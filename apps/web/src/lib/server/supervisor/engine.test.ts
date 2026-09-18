import { TEST_NOOP_DISPATCH_EFFECTS } from '$lib/server/api/test-dispatch-effects';
import { describe, expect, it } from 'vitest';
import type { ActorContext } from '../api/core';
import { listIssues, resumeIssue, transitionIssue } from '../api/issues';
import { createTestDb, type TestDb } from '../api/test-db';
import { localAdapter } from './adapter';
import {
	cancelRun,
	cancelAssignedRuns,
	claimRun,
	endRun,
	launchClaimedRun,
	loadEligibleIssues,
	loadEndableRun,
	loadEngineRunners,
	noteRateLimit,
	releaseDeclinedAssignments,
	releaseSurplusAssigned,
	runDispatchPass,
	sweepSupervisor,
	targetsForIssue,
	loadEngineRules
} from './engine';
import { createFakeAdapter, type FakeAdapter } from './fake-adapter';
import {
	addIssue,
	addLabel,
	addRule,
	addRun,
	addRunKey,
	addRunner,
	addTransitionEvent,
	addTwoStageWorkflow,
	CLOSED,
	eventsOfType,
	issueById,
	keyForRun,
	NOW,
	OPEN,
	PROJECT,
	REVIEW,
	runById,
	runnerById,
	runs,
	seedBase,
	setSettings,
	STAGE_A,
	STAGE_B,
	USER
} from './test-fixtures';

/** A seeded world: user, project, armed settings. */
function world(): TestDb {
	const t = createTestDb();
	seedBase(t);
	setSettings(t);
	return t;
}

function pass(t: TestDb, fake: FakeAdapter | typeof localAdapter = createFakeAdapter(), now = NOW) {
	return runDispatchPass(t.db, t.env, USER, { now, adapters: { local: fake } });
}

const sessionActor: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

describe('eligibility', () => {
	it('dispatches only active-category, ready, unclaimed, unparked issues', async () => {
		const t = world();
		const runner = addRunner(t, { maxConcurrent: 10 });
		addRule(t, { targets: [{ runner_id: runner }] });

		const eligible = addIssue(t);
		addIssue(t, { state: REVIEW }); // awaiting_human
		addIssue(t, { state: CLOSED }); // done
		addIssue(t, { needsAttention: true }); // parked
		const blocked = addIssue(t);
		const blocker = addIssue(t, { state: REVIEW });
		t.sqlite
			.prepare(
				`INSERT INTO issue_link (id, source_issue_id, target_issue_id, kind, created_at) VALUES (?, ?, ?, 'blocks', ${NOW})`
			)
			.run('lnk_1', blocker, blocked);
		const dup = addIssue(t);
		t.sqlite
			.prepare(
				`INSERT INTO issue_link (id, source_issue_id, target_issue_id, kind, created_at) VALUES (?, ?, ?, 'duplicate_of', ${NOW})`
			)
			.run('lnk_2', dup, eligible);

		const candidates = await loadEligibleIssues(t.db, USER);
		expect(candidates.map((c) => c.id)).toEqual([eligible]);

		const result = await pass(t);
		expect(result.claimed).toBe(1);
		expect(runs(t)).toHaveLength(1);
		expect(runs(t)[0].issue_id).toBe(eligible);
	});

	it('a blocker whose effective state (via its duplicate chain) is done does not block', async () => {
		const t = world();
		const runner = addRunner(t);
		addRule(t, { targets: [{ runner_id: runner }] });

		const issue = addIssue(t);
		const blocker = addIssue(t); // own state Open (not done)…
		const canonical = addIssue(t, { state: CLOSED }); // …but it duplicates a done issue
		t.sqlite.exec(`
			INSERT INTO issue_link (id, source_issue_id, target_issue_id, kind, created_at) VALUES
				('lnk_b', '${blocker}', '${issue}', 'blocks', ${NOW}),
				('lnk_d', '${blocker}', '${canonical}', 'duplicate_of', ${NOW});
		`);
		const candidates = await loadEligibleIssues(t.db, USER);
		expect(candidates.map((c) => c.id)).toContain(issue);
	});

	it("carries each candidate's labels, so a label rule can match", async () => {
		const t = world();
		const runner = addRunner(t);
		const docs = addLabel(t, 'docs');
		addRule(t, { label: docs, targets: [{ runner_id: runner }] });
		const labelled = addIssue(t, { labels: [docs] });
		const plain = addIssue(t);

		const candidates = await loadEligibleIssues(t.db, USER);
		const byId = new Map(candidates.map((c) => [c.id, c.label_ids]));
		expect(byId.get(labelled)).toEqual([docs]);
		expect(byId.get(plain)).toEqual([]);

		const rules = await loadEngineRules(t.db, USER);
		expect(
			targetsForIssue(
				candidates.find((c) => c.id === labelled)!,
				rules
			).targets
		).toEqual([{ runner_id: runner }]);
		expect(
			targetsForIssue(
				candidates.find((c) => c.id === plain)!,
				rules
			).targets
		).toEqual([]);

		const result = await pass(t);
		expect(result.claimed).toBe(1);
		expect(runs(t)[0].issue_id).toBe(labelled);
	});

	it('skips — without a strike — an issue two label rules match equally', async () => {
		const t = world();
		const runner = addRunner(t);
		const docs = addLabel(t, 'docs');
		const security = addLabel(t, 'security');
		const a = addRule(t, { label: docs, targets: [{ runner_id: runner }] });
		const b = addRule(t, { label: security, targets: [{ runner_id: runner }] });
		const issue = addIssue(t, { labels: [docs, security] });

		const candidates = await loadEligibleIssues(t.db, USER);
		const rules = await loadEngineRules(t.db, USER);
		const resolved = targetsForIssue(candidates[0], rules);
		expect(resolved.rule).toBeNull();
		expect(resolved.targets).toEqual([]);
		expect(resolved.ambiguous.map((r) => r.id).sort()).toEqual([a, b].sort());

		const result = await pass(t);
		expect(result.claimed).toBe(0);
		expect(runs(t)).toHaveLength(0);
		expect(issueById(t, issue).attempt_count).toBe(0);
	});

	it('dispatches nothing while the kill switch is off', async () => {
		const t = world();
		setSettings(t, { enabled: false });
		const runner = addRunner(t);
		addRule(t, { targets: [{ runner_id: runner }] });
		addIssue(t);
		expect((await pass(t)).claimed).toBe(0);
		expect(runs(t)).toHaveLength(0);
	});

	it('no matching rule means no automation for that issue', async () => {
		const t = world();
		t.sqlite.exec(
			`INSERT INTO project (id, user_id, name, created_at, updated_at) VALUES ('prj_other', '${USER}', 'other', ${NOW}, ${NOW})`
		);
		const runner = addRunner(t);
		addRule(t, { project: 'prj_other', targets: [{ runner_id: runner }] });
		addIssue(t); // lives in prj_1
		// The scoped rule cannot match (different project), and no global rule exists.
		expect((await pass(t)).claimed).toBe(0);
	});

	it('oldest-updated_at first: scarce capacity goes to the longest-untouched issue', async () => {
		const t = world();
		setSettings(t, { quota: { type: 'global_cap', limit: 1 } });
		const runner = addRunner(t, { maxConcurrent: 5 });
		addRule(t, { targets: [{ runner_id: runner }] });
		addIssue(t, { id: 'iss_fresh', updatedAt: NOW });
		addIssue(t, { id: 'iss_stale', updatedAt: NOW - 60_000 });

		const result = await pass(t);
		expect(result.claimed).toBe(1);
		expect(runs(t)[0].issue_id).toBe('iss_stale');
	});
});

describe('local concurrency release', () => {
	it('keeps running work and releases newest surplus assigned claims', async () => {
		const t = world();
		const runnerId = addRunner(t, { maxConcurrent: 3 });
		t.sqlite
			.prepare(
				`UPDATE runner SET daemon_instance_id = 'boot_1', concurrency_instance_id = 'boot_1',
				 concurrency_mode = 'remote', concurrency_ceiling = 1 WHERE id = ?`
			)
			.run(runnerId);
		const runningIssue = addIssue(t, { title: 'running' });
		const oldIssue = addIssue(t, { title: 'old assignment' });
		const newIssue = addIssue(t, { title: 'new assignment' });
		const running = addRun(t, {
			issueId: runningIssue,
			runnerId,
			status: 'running',
			startedAt: NOW - 100,
			createdAt: NOW - 300
		});
		const oldAssigned = addRun(t, {
			issueId: oldIssue,
			runnerId,
			createdAt: NOW - 200
		});
		const newAssigned = addRun(t, {
			issueId: newIssue,
			runnerId,
			createdAt: NOW - 100
		});
		let signals = 0;
		const released = await releaseSurplusAssigned(
			t.db,
			t.env,
			{ userId: USER, runnerId, instanceId: 'boot_1', ceiling: 1, now: NOW },
			() => signals++
		);

		expect(released).toEqual([oldAssigned, newAssigned]);
		expect(runById(t, running)!.status).toBe('running');
		expect(runById(t, oldAssigned)!.status).toBe('canceled');
		expect(runById(t, newAssigned)!.status).toBe('canceled');
		expect(signals).toBe(2);
	});

	it('rechecks capacity in the release transaction when a running slot opens', async () => {
		const t = world();
		const runnerId = addRunner(t, { maxConcurrent: 2 });
		t.sqlite
			.prepare(
				`UPDATE runner SET daemon_instance_id = 'boot_1', concurrency_instance_id = 'boot_1',
				 concurrency_mode = 'remote', concurrency_ceiling = 1 WHERE id = ?`
			)
			.run(runnerId);
		const running = addRun(t, {
			issueId: addIssue(t, { title: 'running' }),
			runnerId,
			status: 'running',
			startedAt: NOW - 100,
			createdAt: NOW - 200
		});
		const assigned = addRun(t, {
			issueId: addIssue(t, { title: 'assigned' }),
			runnerId,
			createdAt: NOW - 100
		});
		const realBatch = t.env.DB.batch.bind(t.env.DB);
		let injected = false;
		t.env.DB.batch = async (statements) => {
			if (!injected) {
				injected = true;
				t.sqlite
					.prepare("UPDATE agent_run SET status = 'completed', ended_at = ? WHERE id = ?")
					.run(NOW - 1, running);
			}
			return realBatch(statements);
		};

		const released = await releaseSurplusAssigned(
			t.db,
			t.env,
			{ userId: USER, runnerId, instanceId: 'boot_1', ceiling: 1, now: NOW },
			() => {}
		);

		expect(injected).toBe(true);
		expect(released).toEqual([]);
		expect(runById(t, assigned)!.status).toBe('assigned');
	});

	it('decline revokes only the refused run key', async () => {
		const t = world();
		const runnerId = addRunner(t);
		const refused = addRun(t, {
			issueId: addIssue(t, { title: 'refused' }),
			runnerId,
			status: 'launching'
		});
		const other = addRun(t, {
			issueId: addIssue(t, { title: 'other' }),
			runnerId,
			status: 'launching'
		});
		addRunKey(t, refused);
		addRunKey(t, other);

		const released = await releaseDeclinedAssignments(
			t.db,
			t.env,
			{ userId: USER, runnerId, runIds: [refused], now: NOW },
			() => {}
		);

		expect(released).toEqual([refused]);
		expect(keyForRun(t, refused)!.revoked_at).toBe(NOW);
		expect(keyForRun(t, other)!.revoked_at).toBeNull();
		expect(runById(t, other)!.status).toBe('launching');
	});
});

describe('readiness equivalence with the issues API', () => {
	// The engine's raw eligibility CTE and issues.ts's Kysely-built readiness
	// are two renderings of one rule; this matrix pins them together for the
	// shapes most likely to diverge (dup-of-dup resolution, link cycles).
	it('loadEligibleIssues membership matches serialized readiness across the fixture matrix', async () => {
		const t = world();
		const plain = addIssue(t); // eligible baseline
		const blocked = addIssue(t);
		const openBlocker = addIssue(t, { state: REVIEW });
		// Blocker cycle (race-created; write-time checks normally reject it):
		// both effectively open, so both block each other — and neither query
		// may loop forever resolving it.
		const cycleA = addIssue(t);
		const cycleB = addIssue(t);
		// Dup-of-dup: the blocker's chain terminates on a done issue, so it
		// does not block; the duplicates themselves are never dispatchable.
		const dupBlocked = addIssue(t);
		const dupBlocker = addIssue(t);
		const dupMiddle = addIssue(t);
		const dupDone = addIssue(t, { state: CLOSED });
		t.sqlite.exec(`
			INSERT INTO issue_link (id, source_issue_id, target_issue_id, kind, created_at) VALUES
				('l_b', '${openBlocker}', '${blocked}', 'blocks', ${NOW}),
				('l_c1', '${cycleA}', '${cycleB}', 'blocks', ${NOW}),
				('l_c2', '${cycleB}', '${cycleA}', 'blocks', ${NOW}),
				('l_db', '${dupBlocker}', '${dupBlocked}', 'blocks', ${NOW}),
				('l_d1', '${dupBlocker}', '${dupMiddle}', 'duplicate_of', ${NOW}),
				('l_d2', '${dupMiddle}', '${dupDone}', 'duplicate_of', ${NOW});
		`);

		const eligible = new Set((await loadEligibleIssues(t.db, USER)).map((c) => c.id));
		expect(eligible).toEqual(new Set([plain, dupBlocked]));

		// Equivalence: eligible ⇔ ready (per the issues API) ∧ effective
		// category active — no runs or parking in this fixture.
		const ready = await listIssues(t.db, USER, { ready: true }, { cursor: null, limit: 100 });
		const expected = new Set(
			ready.items.filter((i) => i.effective_state.category === 'active').map((i) => i.id)
		);
		expect(eligible).toEqual(expected);
	});
});

describe('an archived project', () => {
	it('drops out of the dispatch queue and comes back on unarchive', async () => {
		const t = world();
		const runner = addRunner(t, { maxConcurrent: 10 });
		addRule(t, { targets: [{ runner_id: runner }] });
		const issue = addIssue(t);
		expect((await loadEligibleIssues(t.db, USER)).map((c) => c.id)).toEqual([issue]);

		t.sqlite.exec(`UPDATE project SET archived_at = ${NOW} WHERE id = '${PROJECT}'`);
		expect(await loadEligibleIssues(t.db, USER)).toEqual([]);
		expect((await pass(t)).claimed).toBe(0);
		expect(runs(t)).toHaveLength(0);

		t.sqlite.exec(`UPDATE project SET archived_at = NULL WHERE id = '${PROJECT}'`);
		expect((await pass(t)).claimed).toBe(1);
		expect(runs(t)).toHaveLength(1);
	});
});

describe('the guarded claim', () => {
	const claimInput = (t: TestDb, issueId: string, runnerId: string, over: object = {}) => ({
		runId: `arun_${Math.random().toString(36).slice(2)}`,
		userId: USER,
		issueId,
		projectId: PROJECT,
		stateId: OPEN,
		runnerId,
		maxConcurrent: 5,
		tier: 'balanced' as const,
		model: null,
		quota: { type: 'global_cap' as const, limit: 10 },
		now: NOW,
		...over
	});

	it('refuses an issue whose project was archived between the queue read and the claim', async () => {
		const t = world();
		const runner = addRunner(t);
		const issue = addIssue(t);
		const input = claimInput(t, issue, runner);
		// The pass read the queue while the project was live.
		t.sqlite.exec(`UPDATE project SET archived_at = ${NOW} WHERE id = '${PROJECT}'`);
		expect(await claimRun(t.db, t.env, input)).toBe(false);
		expect(runs(t)).toHaveLength(0);
	});

	it('refuses a stale route after a project assignment changes, including ABA', async () => {
		const t = world();
		const runner = addRunner(t);
		const issue = addIssue(t);
		const input = claimInput(t, issue, runner, { projectAssignmentToken: '' });
		// A -> B -> A can restore the same project while never restoring this token.
		t.sqlite.exec(
			`UPDATE issue SET project_assignment_token = 'assignment-after-aba' WHERE id = '${issue}'`
		);
		expect(await claimRun(t.db, t.env, input)).toBe(false);
		expect(runs(t)).toHaveLength(0);
	});

	it('refuses a source route after the issue moves even if its assignment token is unchanged', async () => {
		const t = world();
		const runner = addRunner(t);
		const issue = addIssue(t);
		const input = claimInput(t, issue, runner);
		t.sqlite.exec(`
			INSERT INTO project (id, user_id, name, created_at, updated_at)
			VALUES ('prj_moved', '${USER}', 'moved', ${NOW}, ${NOW});
			UPDATE issue SET project_id = 'prj_moved', number = 1 WHERE id = '${issue}';
		`);
		expect(await claimRun(t.db, t.env, input)).toBe(false);
		expect(runs(t)).toHaveLength(0);
	});

	it('two racing claims on one issue: exactly one insert wins', async () => {
		const t = world();
		const r1 = addRunner(t);
		const r2 = addRunner(t);
		const issue = addIssue(t);
		expect(await claimRun(t.db, t.env, claimInput(t, issue, r1))).toBe(true);
		expect(await claimRun(t.db, t.env, claimInput(t, issue, r2))).toBe(false);
		expect(runs(t)).toHaveLength(1);
	});

	it('re-checks eligibility inside the statement: state, category, parking', async () => {
		const t = world();
		const r1 = addRunner(t);
		const moved = addIssue(t, { state: REVIEW });
		// Routed for Open, but the issue sits in Review: the claim must not land.
		expect(await claimRun(t.db, t.env, claimInput(t, moved, r1))).toBe(false);
		const parked = addIssue(t, { needsAttention: true });
		expect(await claimRun(t.db, t.env, claimInput(t, parked, r1))).toBe(false);
	});

	it('enforces the runner cap inside the statement', async () => {
		const t = world();
		const r1 = addRunner(t);
		const first = addIssue(t);
		const second = addIssue(t);
		expect(await claimRun(t.db, t.env, claimInput(t, first, r1, { maxConcurrent: 1 }))).toBe(true);
		expect(await claimRun(t.db, t.env, claimInput(t, second, r1, { maxConcurrent: 1 }))).toBe(
			false
		);
	});

	it('enforces the global cap inside the statement', async () => {
		const t = world();
		const r1 = addRunner(t);
		const r2 = addRunner(t);
		const quota = { type: 'global_cap' as const, limit: 1 };
		expect(await claimRun(t.db, t.env, claimInput(t, addIssue(t), r1, { quota }))).toBe(true);
		expect(await claimRun(t.db, t.env, claimInput(t, addIssue(t), r2, { quota }))).toBe(false);
	});

	it('roster counting keys on state_id_at_start even after the issue moved on', async () => {
		const t = world();
		addTwoStageWorkflow(t);
		const r1 = addRunner(t, { maxConcurrent: 10 });
		const quota = { type: 'state_roster' as const, default_limit: 1, overrides: {} };
		const first = addIssue(t, { workflow: 'wf_two', state: STAGE_A });
		const second = addIssue(t, { workflow: 'wf_two', state: STAGE_A });
		expect(await claimRun(t.db, t.env, claimInput(t, first, r1, { stateId: STAGE_A, quota }))).toBe(
			true
		);
		// The agent moves the first issue onward mid-run; the run still
		// occupies its starting state's roster slot until it ends.
		t.sqlite.prepare('UPDATE issue SET state_id = ? WHERE id = ?').run(STAGE_B, first);
		expect(
			await claimRun(t.db, t.env, claimInput(t, second, r1, { stateId: STAGE_A, quota }))
		).toBe(false);
		// Ending the run frees the Stage A slot.
		const runId = runs(t)[0].id as string;
		const run = await loadEndableRun(t.db, USER, runId);
		await endRun(t.db, t.env, run!, { status: 'completed', now: NOW + 1000 });
		expect(
			await claimRun(t.db, t.env, claimInput(t, second, r1, { stateId: STAGE_A, quota }))
		).toBe(true);
	});
});

describe('dispatch pass against the fake adapter', () => {
	it('prefers a routed runner holding a resumable session, without changing the target set', async () => {
		const t = world();
		const cold = addRunner(t, { name: 'cold' });
		const holder = addRunner(t, { name: 'holder' });
		// Routing lists the cold runner first; only affinity moves the holder up.
		addRule(t, { targets: [{ runner_id: cold }, { runner_id: holder }] });
		const issue = addIssue(t);
		const prior = 'arun_prior';
		addRun(t, {
			id: prior,
			issueId: issue,
			runnerId: holder,
			status: 'completed',
			createdAt: NOW - 2,
			endedAt: NOW - 1,
			outcome: 'advanced'
		});
		t.sqlite
			.prepare(
				`INSERT INTO run_resource (
			id, user_id, runner_id, issue_id, kind, owner_run_id, state, expires_at,
			provider_session_id, resume_fingerprint, created_at, updated_at
		) VALUES ('res_aff', ?, ?, ?, 'local_claude', ?, 'available', ?, 'sess_prior', 'v1:abc', ?, ?)`
			)
			.run(USER, holder, issue, prior, NOW + 60_000, NOW, NOW);

		expect(await pass(t, localAdapter)).toEqual({ claimed: 1, launched: 0 });
		const claimed = runs(t).find((r) => r.id !== prior);
		expect(claimed!.runner_id).toBe(holder);
	});

	it('leaves routing order alone when the resource is expired', async () => {
		const t = world();
		const cold = addRunner(t, { name: 'cold' });
		const holder = addRunner(t, { name: 'holder' });
		addRule(t, { targets: [{ runner_id: cold }, { runner_id: holder }] });
		const issue = addIssue(t);
		const prior = 'arun_prior';
		addRun(t, {
			id: prior,
			issueId: issue,
			runnerId: holder,
			status: 'completed',
			createdAt: NOW - 2,
			endedAt: NOW - 1,
			outcome: 'advanced'
		});
		t.sqlite
			.prepare(
				`INSERT INTO run_resource (
			id, user_id, runner_id, issue_id, kind, owner_run_id, state, expires_at,
			provider_session_id, resume_fingerprint, created_at, updated_at
		) VALUES ('res_aff', ?, ?, ?, 'local_claude', ?, 'available', ?, 'sess_prior', 'v1:abc', ?, ?)`
			)
			.run(USER, holder, issue, prior, NOW - 1, NOW, NOW);

		expect(await pass(t, localAdapter)).toEqual({ claimed: 1, launched: 0 });
		const claimed = runs(t).find((r) => r.id !== prior);
		expect(claimed!.runner_id).toBe(cold);
	});

	it('claims, launches, mints the run key, and records the started event', async () => {
		const t = world();
		const fake = createFakeAdapter();
		fake.nextSessionId('sess-42');
		const runner = addRunner(t, { defaultTier: 'cheapest', maxRunMinutes: 30 });
		addRule(t, { targets: [{ runner_id: runner }] });
		const issue = addIssue(t);

		const result = await pass(t, fake);
		expect(result).toEqual({ claimed: 1, launched: 1 });

		const run = runs(t)[0];
		expect(run.status).toBe('running');
		expect(run.issue_id).toBe(issue);
		expect(run.tier).toBe('cheapest');
		expect(run.model).toMatch(/^claude-/);
		expect(run.state_id_at_start).toBe(OPEN);
		expect(run.provider_session_id).toBe('sess-42');
		expect(run.started_at).not.toBeNull();

		// The run key: bound to the run, expiry = launch + timeout + 10m slack.
		const key = keyForRun(t, run.id as string);
		expect(key).toBeDefined();
		expect(key!.revoked_at).toBeNull();
		expect(key!.expires_at).toBe(NOW + 30 * 60_000 + 10 * 60_000);
		expect(run.api_key_id).toBe(key!.id);
		// The adapter received the plaintext key for out-of-prompt delivery.
		expect(fake.launches).toHaveLength(1);
		expect(fake.launches[0].runKey).toMatch(/^tines_/);
		expect(fake.launches[0].model).toBe(run.model);

		const started = eventsOfType(t, 'agent_run.started');
		expect(started).toHaveLength(1);
		expect(started[0].payload).toMatchObject({
			run_id: run.id,
			runner_name: runner,
			tier: 'cheapest',
			model: run.model
		});
		// Supervisor events are attributed to the owning user, no API key.
		expect(started[0].actor_api_key_id).toBeNull();
	});

	it('a poll-mode (local) adapter leaves the claim assigned for the daemon', async () => {
		const t = world();
		const runner = addRunner(t);
		addRule(t, { targets: [{ runner_id: runner }] });
		addIssue(t);
		const result = await pass(t, localAdapter);
		expect(result).toEqual({ claimed: 1, launched: 0 });
		expect(runs(t)[0].status).toBe('assigned');
		// No run key yet: it is minted at poll delivery (Phase 3).
		expect(keyForRun(t, runs(t)[0].id as string)).toBeUndefined();
	});

	it('a second pass over the same pool claims nothing (the first holds the claims)', async () => {
		const t = world();
		const runner = addRunner(t, { maxConcurrent: 10 });
		addRule(t, { targets: [{ runner_id: runner }] });
		addIssue(t);
		addIssue(t);
		expect((await pass(t)).claimed).toBe(2);
		expect((await pass(t)).claimed).toBe(0);
		expect(runs(t)).toHaveLength(2);
	});

	it('global_cap 2 with three eligible issues runs exactly two; the third follows an ending', async () => {
		const t = world();
		setSettings(t, { quota: { type: 'global_cap', limit: 2 } });
		const runner = addRunner(t, { maxConcurrent: 10 });
		addRule(t, { targets: [{ runner_id: runner }] });
		const first = addIssue(t, { updatedAt: NOW - 3000 });
		addIssue(t, { updatedAt: NOW - 2000 });
		const third = addIssue(t, { updatedAt: NOW - 1000 });

		expect((await pass(t)).claimed).toBe(2);
		expect(runs(t).map((r) => r.issue_id)).not.toContain(third);

		// The first run hands its issue off to Review and ends: the freed slot
		// goes to the third issue.
		t.sqlite.prepare('UPDATE issue SET state_id = ? WHERE id = ?').run(REVIEW, first);
		const runId = runs(t).find((r) => r.issue_id === first)!.id as string;
		const run = await loadEndableRun(t.db, USER, runId);
		await endRun(t.db, t.env, run!, { status: 'completed', now: NOW + 1000 });
		expect((await pass(t)).claimed).toBe(1);
		expect(runs(t).map((r) => r.issue_id)).toContain(third);
	});

	it('state_roster limits per stage, honoring overrides', async () => {
		const t = world();
		addTwoStageWorkflow(t);
		setSettings(t, {
			quota: { type: 'state_roster', default_limit: 1, overrides: { [STAGE_B]: 2 } }
		});
		const runner = addRunner(t, { maxConcurrent: 10 });
		addRule(t, { targets: [{ runner_id: runner }] });
		addIssue(t, { workflow: 'wf_two', state: STAGE_A });
		addIssue(t, { workflow: 'wf_two', state: STAGE_A });
		addIssue(t, { workflow: 'wf_two', state: STAGE_B });
		addIssue(t, { workflow: 'wf_two', state: STAGE_B });
		addIssue(t, { workflow: 'wf_two', state: STAGE_B });

		expect((await pass(t)).claimed).toBe(3); // 1 from A (default), 2 from B (override)
		const byState = runs(t).map((r) => r.state_id_at_start);
		expect(byState.filter((s) => s === STAGE_A)).toHaveLength(1);
		expect(byState.filter((s) => s === STAGE_B)).toHaveLength(2);
	});

	it('a runner at max_concurrent is skipped for the next runner in the list', async () => {
		const t = world();
		const r1 = addRunner(t, { maxConcurrent: 1 });
		const r2 = addRunner(t, { maxConcurrent: 1 });
		addRule(t, { targets: [{ runner_id: r1 }, { runner_id: r2 }] });
		addIssue(t, { updatedAt: NOW - 2000 });
		addIssue(t, { updatedAt: NOW - 1000 });

		expect((await pass(t)).claimed).toBe(2);
		expect(
			runs(t)
				.map((r) => r.runner_id)
				.sort()
		).toEqual([r1, r2].sort());
	});

	it('a pin replaces rule matching entirely, tier included', async () => {
		const t = world();
		const ruled = addRunner(t);
		const pinned = addRunner(t);
		addRule(t, { targets: [{ runner_id: ruled }] });
		addIssue(t, { pinnedRunner: pinned, pinnedTier: 'smartest' });

		await pass(t);
		expect(runs(t)).toHaveLength(1);
		expect(runs(t)[0].runner_id).toBe(pinned);
		expect(runs(t)[0].tier).toBe('smartest');
	});

	it('an issue pinned to a paused runner waits — no fallback to rules', async () => {
		const t = world();
		const ruled = addRunner(t);
		const pinned = addRunner(t, { status: 'paused' });
		addRule(t, { targets: [{ runner_id: ruled }] });
		addIssue(t, { pinnedRunner: pinned });
		expect((await pass(t)).claimed).toBe(0);
	});

	it('a draining local runner is skipped by the pass; the next rule target takes the issue', async () => {
		const t = world();
		const draining = addRunner(t, { draining: true });
		const open = addRunner(t);
		addRule(t, { targets: [{ runner_id: draining }, { runner_id: open }] });
		addIssue(t);
		expect((await pass(t)).claimed).toBe(1);
		expect(runs(t)[0].runner_id).toBe(open);
	});

	it('rule tier entries override the runner default; entries without one use it', async () => {
		const t = world();
		const r1 = addRunner(t, { defaultTier: 'cheapest', maxConcurrent: 10 });
		addRule(t, { targets: [{ runner_id: r1, tier: 'smartest' }] });
		addIssue(t);
		await pass(t);
		expect(runs(t)[0].tier).toBe('smartest');
	});

	it('dispatches a scoped tier-only rule through its broader runner fallback list', async () => {
		const t = world();
		const held = addRunner(t, { backoffUntil: NOW + 60_000 });
		const available = addRunner(t, {
			tiers: { smartest: { model: 'runner-two-smartest' } }
		});
		addRule(t, { targets: [{ runner_id: held }, { runner_id: available }] });
		addRule(t, { state: OPEN, targets: [{ runner_id: '*', tier: 'smartest' }] });
		addIssue(t);

		expect((await pass(t)).claimed).toBe(1);
		expect(runs(t)[0]).toMatchObject({
			runner_id: available,
			tier: 'smartest',
			model: 'runner-two-smartest'
		});
	});

	it('honors per-runner tier overrides at launch', async () => {
		const t = world();
		const r1 = addRunner(t, { tiers: { balanced: { model: 'my-pinned-model' } } });
		addRule(t, { targets: [{ runner_id: r1 }] });
		addIssue(t);
		await pass(t);
		expect(runs(t)[0].model).toBe('my-pinned-model');
	});
});

describe('launch failures', () => {
	it('records the error, backs the runner off, flags it — and is never a strike', async () => {
		const t = world();
		const fake = createFakeAdapter();
		fake.failNextLaunch('provider says 429');
		const runner = addRunner(t);
		addRule(t, { targets: [{ runner_id: runner }] });
		const issue = addIssue(t);

		const result = await pass(t, fake);
		expect(result).toEqual({ claimed: 0, launched: 0 });

		const run = runs(t)[0];
		expect(run.status).toBe('failed');
		expect(run.error).toBe('provider says 429');
		expect(run.started_at).toBeNull();
		// Not a strike: the issue didn't fail, the pipe did.
		expect(issueById(t, issue).attempt_count).toBe(0);
		// The runner backs off (2× per consecutive failure) and is flagged.
		const r = runnerById(t, runner);
		expect(r.launch_failures).toBe(1);
		expect(Number(r.backoff_until)).toBeGreaterThanOrEqual(NOW + 60_000);
		expect(eventsOfType(t, 'runner.errored')).toHaveLength(1);
		expect(eventsOfType(t, 'agent_run.started')).toHaveLength(0);
		// The minted key died with the failed launch.
		expect(keyForRun(t, run.id as string)!.revoked_at).not.toBeNull();
	});

	it('retries the next target in the same pass', async () => {
		const t = world();
		const fake = createFakeAdapter();
		fake.failNextLaunch('first runner is broken');
		const broken = addRunner(t);
		const healthy = addRunner(t);
		addRule(t, { targets: [{ runner_id: broken }, { runner_id: healthy }] });
		const issue = addIssue(t);

		const result = await pass(t, fake);
		expect(result).toEqual({ claimed: 1, launched: 1 });
		const all = runs(t);
		expect(all).toHaveLength(2);
		expect(all.find((r) => r.runner_id === broken)!.status).toBe('failed');
		const winner = all.find((r) => r.runner_id === healthy)!;
		expect(winner.status).toBe('running');
		expect(winner.issue_id).toBe(issue);
	});

	it('backoff excludes the runner until it expires; a successful launch clears it', async () => {
		const t = world();
		const fake = createFakeAdapter();
		fake.failNextLaunch('boom');
		const runner = addRunner(t);
		addRule(t, { targets: [{ runner_id: runner }] });
		addIssue(t);

		await pass(t, fake);
		// Still backing off: nothing dispatches.
		expect((await pass(t, fake, NOW + 30_000)).claimed).toBe(0);
		// Backoff expired: the retry succeeds and resets the failure count.
		const after = NOW + 61_000;
		expect((await pass(t, fake, after)).launched).toBe(1);
		const r = runnerById(t, runner);
		expect(r.launch_failures).toBe(0);
		expect(r.backoff_until).toBeNull();
	});

	it('a cancel landing between claim and launch revokes the late key and never launches', async () => {
		const t = world();
		const fake = createFakeAdapter();
		const runnerId = addRunner(t);
		const issue = addIssue(t);
		await claimRun(t.db, t.env, {
			runId: 'arun_race',
			userId: USER,
			issueId: issue,
			projectId: PROJECT,
			stateId: OPEN,
			runnerId,
			maxConcurrent: 1,
			tier: 'balanced',
			model: null,
			quota: { type: 'global_cap', limit: 10 },
			now: NOW
		});
		// The cancel wins the race before the assigned→launching flip.
		expect((await cancelRun(t.db, t.env, USER, 'arun_race')).kind).toBe('canceled');

		const runner = (await loadEngineRunners(t.db, USER)).get(runnerId)!;
		const outcome = await launchClaimedRun(t.db, t.env, fake, {
			userId: USER,
			runId: 'arun_race',
			issueId: issue,
			projectId: PROJECT,
			runner,
			tier: 'balanced',
			model: null,
			now: NOW
		});
		expect(outcome).toBe('lost');
		// No provider session, no started event, no runner backoff…
		expect(fake.launches).toHaveLength(0);
		expect(eventsOfType(t, 'agent_run.started')).toHaveLength(0);
		expect(runnerById(t, runnerId).launch_failures).toBe(0);
		// …and the key minted after the cancel's revocation sweep is dead too.
		const key = keyForRun(t, 'arun_race');
		expect(key).toBeDefined();
		expect(key!.revoked_at).not.toBeNull();
		expect(runById(t, 'arun_race')!.status).toBe('canceled');
	});

	it('persists the first managed effort milestone from a null CAS state', async () => {
		const t = world();
		const runnerId = addRunner(t);
		const issue = addIssue(t);
		await claimRun(t.db, t.env, {
			runId: 'arun_effort_launch',
			userId: USER,
			issueId: issue,
			projectId: PROJECT,
			stateId: OPEN,
			runnerId,
			maxConcurrent: 1,
			tier: 'balanced',
			model: 'claude-sonnet-5',
			requestedEffort: 'high',
			resolvedEffort: 'high',
			effortSource: { kind: 'runner_tier', runner_id: runnerId, tier: 'balanced' },
			quota: { type: 'global_cap', limit: 10 },
			now: NOW
		});
		const fake = createFakeAdapter();
		const launch = fake.launch.bind(fake);
		fake.launch = async (input) => {
			await input.recordEffortEvidence?.({
				status: 'confirmed',
				transport: 'managed_agent_config',
				attempted_effort: 'high',
				observed_model: 'claude-sonnet-5',
				observed_effort: 'high'
			});
			return launch(input);
		};
		const runner = (await loadEngineRunners(t.db, USER)).get(runnerId)!;
		expect(
			await launchClaimedRun(t.db, t.env, fake, {
				userId: USER,
				runId: 'arun_effort_launch',
				issueId: issue,
				projectId: PROJECT,
				runner,
				tier: 'balanced',
				model: 'claude-sonnet-5',
				effort: 'high',
				now: NOW
			})
		).toBe('launched');
		expect(runById(t, 'arun_effort_launch')).toMatchObject({
			status: 'running',
			effort_application_status: 'confirmed'
		});
	});

	it('consecutive failures double the backoff', async () => {
		const t = world();
		const fake = createFakeAdapter();
		fake.failNextLaunch('boom 1');
		fake.failNextLaunch('boom 2');
		const runner = addRunner(t);
		addRule(t, { targets: [{ runner_id: runner }] });
		addIssue(t);

		await pass(t, fake);
		const second = NOW + 61_000;
		await pass(t, fake, second);
		const r = runnerById(t, runner);
		expect(r.launch_failures).toBe(2);
		expect(r.backoff_until).toBe(second + 120_000);
	});
});

describe('end judgment', () => {
	/** One running run via the fake adapter; returns its ids. */
	async function runningRun(t: TestDb, opts: { attemptCount?: number } = {}) {
		const runner = addRunner(t);
		addRule(t, { targets: [{ runner_id: runner }] });
		const issue = addIssue(t, { attemptCount: opts.attemptCount });
		await pass(t);
		const run = runs(t)[0];
		expect(run.status).toBe('running');
		return { issue, runner, runId: run.id as string, keyId: run.api_key_id as string };
	}

	async function end(
		t: TestDb,
		runId: string,
		status: 'completed' | 'failed' | 'timed_out' | 'canceled',
		now = NOW + 60_000
	) {
		const run = await loadEndableRun(t.db, USER, runId);
		return endRun(t.db, t.env, run!, { status, now });
	}

	it('a run that ends without moving its issue strikes it — completed or not', async () => {
		for (const status of ['completed', 'failed', 'timed_out', 'canceled'] as const) {
			const t = world();
			const { issue, runId } = await runningRun(t);
			const outcome = await end(t, runId, status);
			expect(outcome).toEqual({ ended: true, outcome: 'stalled', parked: false });
			expect(issueById(t, issue).attempt_count).toBe(1);
			expect(issueById(t, issue).needs_attention).toBe(0);
			const ended = eventsOfType(t, 'agent_run.ended');
			expect(ended).toHaveLength(1);
			expect(ended[0].payload).toMatchObject({ status, outcome: 'stalled' });
			// The run key dies with the run.
			expect(keyForRun(t, runId)!.revoked_at).not.toBeNull();
		}
	});

	it('a run-key-authored transition during the run means advanced: count resets', async () => {
		const t = world();
		const { issue, runId, keyId } = await runningRun(t, { attemptCount: 2 });
		addTransitionEvent(t, { issueId: issue, apiKeyId: keyId, at: NOW + 1000 });
		const outcome = await end(t, runId, 'completed');
		expect(outcome.outcome).toBe('advanced');
		expect(issueById(t, issue).attempt_count).toBe(0);
		expect(eventsOfType(t, 'agent_run.ended')[0].payload.outcome).toBe('advanced');
	});

	it('an interrupted end neither strikes the issue nor forgives its earlier attempts', async () => {
		const t = world();
		const { issue, runId } = await runningRun(t, { attemptCount: 2 });
		const run = await loadEndableRun(t.db, USER, runId);
		const outcome = await endRun(t.db, t.env, run!, {
			status: 'failed',
			error: 'runner offline',
			judgment: 'interrupted',
			now: NOW + 60_000
		});
		expect(outcome).toEqual({ ended: true, outcome: 'interrupted', parked: false });
		// Not 3 (no strike) and not 0 (no reset): the attempt never happened.
		expect(issueById(t, issue).attempt_count).toBe(2);
		expect(runById(t, runId)!.status).toBe('failed');
		expect(eventsOfType(t, 'agent_run.ended')[0].payload.outcome).toBe('interrupted');
		expect(keyForRun(t, runId)!.revoked_at).not.toBeNull();
	});

	it('an interrupted run whose key moved the issue is still advanced', async () => {
		const t = world();
		const { issue, runId, keyId } = await runningRun(t, { attemptCount: 2 });
		addTransitionEvent(t, { issueId: issue, apiKeyId: keyId, at: NOW + 1000 });
		const run = await loadEndableRun(t.db, USER, runId);
		const outcome = await endRun(t.db, t.env, run!, {
			status: 'failed',
			error: 'runner offline',
			judgment: 'interrupted',
			now: NOW + 60_000
		});
		// Authorship is checked first and wins: the work landed either way.
		expect(outcome.outcome).toBe('advanced');
		expect(issueById(t, issue).attempt_count).toBe(0);
	});

	it('A→B→A wandering still counts as engagement, not a strike', async () => {
		const t = world();
		const { issue, runId, keyId } = await runningRun(t, { attemptCount: 1 });
		addTransitionEvent(t, {
			issueId: issue,
			apiKeyId: keyId,
			at: NOW + 1000,
			from: OPEN,
			to: REVIEW
		});
		addTransitionEvent(t, {
			issueId: issue,
			apiKeyId: keyId,
			at: NOW + 2000,
			from: REVIEW,
			to: OPEN
		});
		const outcome = await end(t, runId, 'completed');
		expect(outcome.outcome).toBe('advanced');
		expect(issueById(t, issue).attempt_count).toBe(0);
	});

	it("someone else's transition during the run neither credits it nor blocks the strike", async () => {
		const t = world();
		const { issue, runId } = await runningRun(t);
		// A human (no API key) moved the issue while the agent idled.
		addTransitionEvent(t, { issueId: issue, apiKeyId: null, at: NOW + 1000 });
		const outcome = await end(t, runId, 'completed');
		expect(outcome.outcome).toBe('stalled');
		expect(issueById(t, issue).attempt_count).toBe(1);
	});

	it("another run's key does not credit this run", async () => {
		const t = world();
		const { issue, runId } = await runningRun(t);
		// A different (real) key row, to satisfy the FK.
		t.sqlite
			.prepare(
				`INSERT INTO api_key (id, user_id, name, key_hash, key_prefix, created_at) VALUES ('key_other', '${USER}', 'other', 'h', 'p', ${NOW})`
			)
			.run();
		addTransitionEvent(t, { issueId: issue, apiKeyId: 'key_other', at: NOW + 1000 });
		expect((await end(t, runId, 'completed')).outcome).toBe('stalled');
	});

	it('striking out parks the issue: needs_attention, issue.parked, no further dispatch', async () => {
		const t = world();
		setSettings(t, { attemptLimit: 3 });
		const { issue, runId } = await runningRun(t, { attemptCount: 2 });
		const outcome = await end(t, runId, 'failed');
		expect(outcome.parked).toBe(true);
		const row = issueById(t, issue);
		expect(row.attempt_count).toBe(3);
		expect(row.needs_attention).toBe(1);
		const parked = eventsOfType(t, 'issue.parked');
		expect(parked).toHaveLength(1);
		expect(parked[0].payload).toMatchObject({ attempt_count: 3, attempt_limit: 3 });
		// The supervisor won't touch it again until a human acts.
		expect((await pass(t)).claimed).toBe(0);
	});

	it('concurrent finish and cancel reports apply exactly one final report (the flip is the CAS)', async () => {
		const t = world();
		const { issue, runId } = await runningRun(t);
		const run = await loadEndableRun(t.db, USER, runId);
		const winnerUsage = JSON.stringify({ cost_usd: 1, cost_source: 'priced' });
		const [first, second] = await Promise.all([
			endRun(t.db, t.env, run!, {
				status: 'completed',
				now: NOW + 1000,
				finalReport: { usage: winnerUsage, provider_session_id: 'winner' }
			}),
			endRun(t.db, t.env, run!, {
				status: 'canceled',
				now: NOW + 2000,
				finalReport: {
					usage: JSON.stringify({ cost_usd: 99 }),
					provider_session_id: 'loser'
				}
			})
		]);
		expect([first.ended, second.ended].sort()).toEqual([false, true]);
		const stored = runById(t, runId)!;
		if (stored.status === 'completed') {
			expect(stored).toMatchObject({ usage: winnerUsage, provider_session_id: 'winner' });
		} else {
			expect(stored).toMatchObject({
				status: 'canceled',
				usage: JSON.stringify({ cost_usd: 99 }),
				provider_session_id: 'loser'
			});
		}
		expect(issueById(t, issue).attempt_count).toBe(1);
		const events = eventsOfType(t, 'agent_run.ended');
		expect(events).toHaveLength(1);
		expect(events[0].payload.usage).toEqual(JSON.parse(stored.usage as string));
	});

	it('two ends with identical status and clock still apply exactly once', async () => {
		// Two sweeps derive the same `now` from controller.scheduledTime, so
		// the losing end may match the winner on (status, ended_at) exactly —
		// the flip-first CAS, not the guard values, must decide ownership.
		const t = world();
		const { issue, runId } = await runningRun(t);
		const run = await loadEndableRun(t.db, USER, runId);
		const first = await endRun(t.db, t.env, run!, { status: 'timed_out', now: NOW + 1000 });
		const second = await endRun(t.db, t.env, run!, { status: 'timed_out', now: NOW + 1000 });
		expect(first.ended).toBe(true);
		expect(second).toEqual({ ended: false, outcome: null, parked: false });
		expect(issueById(t, issue).attempt_count).toBe(1);
		expect(eventsOfType(t, 'agent_run.ended')).toHaveLength(1);
		expect(eventsOfType(t, 'issue.parked')).toHaveLength(0);
	});

	it('a manual attempt-count reset racing the end is never overwritten with a stale count', async () => {
		const t = world();
		setSettings(t, { attemptLimit: 3 });
		const { issue, runId } = await runningRun(t, { attemptCount: 2 });
		const run = await loadEndableRun(t.db, USER, runId);
		// A human resets the budget while the end is in flight: the strike must
		// land as 0+1, not the stale 2+1 (which would have parked the issue).
		t.sqlite.prepare('UPDATE issue SET attempt_count = 0 WHERE id = ?').run(issue);
		const outcome = await endRun(t.db, t.env, run!, { status: 'completed', now: NOW + 1000 });
		expect(outcome.parked).toBe(false);
		expect(issueById(t, issue).attempt_count).toBe(1);
		expect(issueById(t, issue).needs_attention).toBe(0);
		expect(eventsOfType(t, 'issue.parked')).toHaveLength(0);
	});

	it('canceling a never-started (assigned) run is free: no judgment, no strike', async () => {
		const t = world();
		const runner = addRunner(t);
		addRule(t, { targets: [{ runner_id: runner }] });
		const issue = addIssue(t);
		await pass(t, localAdapter); // poll mode: run stays assigned
		const runId = runs(t)[0].id as string;

		const result = await cancelRun(t.db, t.env, USER, runId);
		expect(result.kind).toBe('canceled');
		expect(runById(t, runId)!.status).toBe('canceled');
		expect(issueById(t, issue).attempt_count).toBe(0);
		const ended = eventsOfType(t, 'agent_run.ended');
		expect(ended).toHaveLength(1);
		expect(ended[0].payload.outcome).toBeUndefined();
	});
});

describe('cancel', () => {
	it('reports each durable assigned-run cancellation before a later failure', async () => {
		const t = world();
		const runner = addRunner(t);
		addRun(t, { issueId: addIssue(t), runnerId: runner, status: 'assigned' });
		addRun(t, { issueId: addIssue(t), runnerId: runner, status: 'assigned' });
		const realBatch = t.env.DB.batch.bind(t.env.DB);
		let batches = 0;
		t.env.DB.batch = async (statements) => {
			batches += 1;
			// endRun owns one flip batch and one dependent-write batch. Fail the
			// next run's flip, after the first win has returned and notified.
			if (batches === 3) throw new Error('injected later cancellation failure');
			return realBatch(statements);
		};
		let notifications = 0;
		await expect(
			cancelAssignedRuns(
				t.db,
				t.env,
				{ userId: USER, runnerId: runner },
				'runner paused',
				() => notifications++,
				NOW
			)
		).rejects.toThrow('injected later cancellation failure');
		expect(notifications).toBe(1);
		expect(runs(t).filter((run) => run.status === 'canceled')).toHaveLength(1);
	});

	it('reports no cancellation for zero matches or a lost terminal guard', async () => {
		const t = world();
		const runner = addRunner(t);
		const issue = addIssue(t);
		addRun(t, { issueId: issue, runnerId: runner, status: 'running', startedAt: NOW });
		let notifications = 0;
		expect(
			await cancelAssignedRuns(
				t.db,
				t.env,
				{ userId: USER, runnerId: runner },
				'runner paused',
				() => notifications++,
				NOW
			)
		).toBe(0);
		expect(notifications).toBe(0);
	});

	it('cancels a running run through the adapter and judges it like any end', async () => {
		const t = world();
		const fake = createFakeAdapter();
		const runner = addRunner(t);
		addRule(t, { targets: [{ runner_id: runner }] });
		const issue = addIssue(t);
		await pass(t, fake);
		const runId = runs(t)[0].id as string;

		const result = await cancelRun(t.db, t.env, USER, runId, { local: fake });
		expect(result.kind).toBe('canceled');
		expect(fake.cancels).toHaveLength(1);
		expect(fake.cancels[0].provider_session_id).toBe(runs(t)[0].provider_session_id);
		expect(runById(t, runId)!.status).toBe('canceled');
		expect(issueById(t, issue).attempt_count).toBe(1); // a strike: it moved nothing

		expect((await cancelRun(t.db, t.env, USER, runId)).kind).toBe('already_ended');
		expect((await cancelRun(t.db, t.env, USER, 'arun_nope')).kind).toBe('not_found');
	});
});

describe('resume and manual transitions', () => {
	it('resume clears parking, resets the count, fires issue.resumed', async () => {
		const t = world();
		const issue = addIssue(t, { needsAttention: true, attemptCount: 3 });
		const detail = await resumeIssue(t.db, t.env, sessionActor, TEST_NOOP_DISPATCH_EFFECTS, issue);
		expect(detail.needs_attention).toBe(false);
		expect(detail.attempt_count).toBe(0);
		expect(eventsOfType(t, 'issue.resumed')).toHaveLength(1);
		// Idempotent: resuming again records nothing new.
		await resumeIssue(t.db, t.env, sessionActor, TEST_NOOP_DISPATCH_EFFECTS, issue);
		expect(eventsOfType(t, 'issue.resumed')).toHaveLength(1);
	});

	it('any non-run-key transition un-parks and resets the count', async () => {
		const t = world();
		const issue = addIssue(t, { needsAttention: true, attemptCount: 3 });
		await transitionIssue(t.db, t.env, sessionActor, TEST_NOOP_DISPATCH_EFFECTS, issue, {
			action: 'Submit for review'
		});
		const row = issueById(t, issue);
		expect(row.needs_attention).toBe(0);
		expect(row.attempt_count).toBe(0);
	});

	it('a run-key transition does not un-park or reset', async () => {
		const t = world();
		// A real run key row to attribute the transition to.
		const runner = addRunner(t);
		addRule(t, { targets: [{ runner_id: runner }] });
		const other = addIssue(t);
		await pass(t);
		const keyId = runs(t)[0].api_key_id as string;

		const issue = addIssue(t, { attemptCount: 2 });
		const runKeyActor: ActorContext = {
			...sessionActor,
			viaSession: false,
			apiKeyId: keyId,
			apiKeyName: 'run key',
			agentRunId: runs(t)[0].id as string
		};
		await transitionIssue(t.db, t.env, runKeyActor, TEST_NOOP_DISPATCH_EFFECTS, issue, {
			action: 'Submit for review'
		});
		expect(issueById(t, issue).attempt_count).toBe(2);
		expect(issueById(t, other).attempt_count).toBe(0);
	});
});

describe('the sweep', () => {
	it('times out overdue runs: adapter cancel, judged end, key revoked', async () => {
		const t = world();
		const fake = createFakeAdapter();
		const runner = addRunner(t, { maxRunMinutes: 30 });
		addRule(t, { targets: [{ runner_id: runner }] });
		const issue = addIssue(t);
		await pass(t, fake);
		const runId = runs(t)[0].id as string;
		setSettings(t, { enabled: false }); // keep the trailing dispatch pass quiet

		await sweepSupervisor(t.db, t.env, NOW + 31 * 60_000, { local: fake });
		const run = runById(t, runId)!;
		expect(run.status).toBe('timed_out');
		expect(run.error).toContain('max_run_minutes');
		expect(fake.cancels).toHaveLength(1);
		expect(issueById(t, issue).attempt_count).toBe(1);
		expect(keyForRun(t, runId)!.revoked_at).not.toBeNull();
	});

	it('fails the running runs of a local runner offline over five minutes', async () => {
		const t = world();
		const fake = createFakeAdapter();
		const runner = addRunner(t);
		addRule(t, { targets: [{ runner_id: runner }] });
		addIssue(t);
		await pass(t, fake);
		const runId = runs(t)[0].id as string;
		t.sqlite
			.prepare('UPDATE runner SET last_seen_at = ? WHERE id = ?')
			.run(NOW - 6 * 60_000, runner);
		setSettings(t, { enabled: false });

		await sweepSupervisor(t.db, t.env, NOW, { local: fake });
		const run = runById(t, runId)!;
		expect(run.status).toBe('failed');
		expect(run.error).toBe('runner offline');
		expect(keyForRun(t, runId)!.revoked_at).not.toBeNull();
	});

	it('an offline runner interrupts its running runs: no strike, no park, runner backs off', async () => {
		const t = world();
		const fake = createFakeAdapter();
		setSettings(t, { attemptLimit: 3 });
		const runner = addRunner(t);
		addRule(t, { targets: [{ runner_id: runner }] });
		const issue = addIssue(t, { attemptCount: 2 });
		await pass(t, fake);
		const runId = runs(t)[0].id as string;
		t.sqlite
			.prepare('UPDATE runner SET last_seen_at = ? WHERE id = ?')
			.run(NOW - 6 * 60_000, runner);
		setSettings(t, { enabled: false, attemptLimit: 3 });

		await sweepSupervisor(t.db, t.env, NOW, { local: fake });
		// One strike short of the limit, and it stays there: the laptop lid
		// closing is not the issue failing.
		expect(issueById(t, issue).attempt_count).toBe(2);
		expect(issueById(t, issue).needs_attention).toBe(0);
		expect(eventsOfType(t, 'issue.parked')).toHaveLength(0);
		expect(runById(t, runId)!.outcome).toBe('interrupted');
		expect(keyForRun(t, runId)!.revoked_at).not.toBeNull();
		const ended = eventsOfType(t, 'agent_run.ended');
		expect(ended[ended.length - 1].payload).toMatchObject({
			status: 'failed',
			outcome: 'interrupted'
		});
		// The pressure lands on the runner instead.
		expect(runnerById(t, runner).launch_failures).toBe(1);
		expect(runnerById(t, runner).backoff_until).toBeGreaterThan(NOW);
		expect(eventsOfType(t, 'runner.errored')).toHaveLength(1);
	});

	it('an offline run whose agent already transitioned the issue is still advanced', async () => {
		const t = world();
		const fake = createFakeAdapter();
		const runner = addRunner(t);
		addRule(t, { targets: [{ runner_id: runner }] });
		const issue = addIssue(t, { attemptCount: 2 });
		await pass(t, fake);
		const run = runs(t)[0];
		addTransitionEvent(t, {
			issueId: issue,
			apiKeyId: run.api_key_id as string,
			at: NOW - 1000
		});
		t.sqlite
			.prepare('UPDATE runner SET last_seen_at = ? WHERE id = ?')
			.run(NOW - 6 * 60_000, runner);
		setSettings(t, { enabled: false });

		await sweepSupervisor(t.db, t.env, NOW, { local: fake });
		// The work landed before the daemon died — credit is unchanged by how
		// the run ended.
		expect(runById(t, run.id as string)!.outcome).toBe('advanced');
		expect(issueById(t, issue).attempt_count).toBe(0);
	});

	it('one offline sweep taking down two runs is one incident for the runner', async () => {
		const t = world();
		const fake = createFakeAdapter();
		const runner = addRunner(t, { maxConcurrent: 2 });
		addRule(t, { targets: [{ runner_id: runner }] });
		addIssue(t);
		addIssue(t);
		await pass(t, fake);
		expect(runs(t)).toHaveLength(2);
		t.sqlite
			.prepare('UPDATE runner SET last_seen_at = ? WHERE id = ?')
			.run(NOW - 6 * 60_000, runner);
		setSettings(t, { enabled: false });

		await sweepSupervisor(t.db, t.env, NOW, { local: fake });
		expect(runs(t).every((r) => r.outcome === 'interrupted')).toBe(true);
		// One dead daemon, one failure — not one per run it happened to hold.
		expect(runnerById(t, runner).launch_failures).toBe(1);
		expect(eventsOfType(t, 'runner.errored')).toHaveLength(1);

		// A second incident, once the backoff has expired, does count again —
		// a daemon that keeps dying keeps escalating.
		const later = (runnerById(t, runner).backoff_until as number) + 1;
		addRun(t, {
			issueId: addIssue(t),
			runnerId: runner,
			status: 'running',
			startedAt: later - 1000
		});
		await sweepSupervisor(t.db, t.env, later, { local: fake });
		expect(runnerById(t, runner).launch_failures).toBe(2);
		expect(eventsOfType(t, 'runner.errored')).toHaveLength(2);
	});

	it('a usage limit holds the runner to the reported reset without a strike', async () => {
		const t = world();
		const runner = addRunner(t);
		await noteRateLimit(t.db, t.env, {
			userId: USER,
			runnerId: runner,
			runId: 'arun_x',
			error: 'rate limited: session limit',
			resumeAt: NOW + 3_600_000,
			limit: 'five_hour',
			now: NOW
		});
		const r = runnerById(t, runner);
		expect(r.backoff_until).toBe(NOW + 3_600_000 + 60_000);
		expect(r.backoff_reason).toBe('rate_limit');
		// A busy afternoon must not read as the dead-credential escalation.
		expect(r.launch_failures).toBe(0);
		const events = eventsOfType(t, 'runner.rate_limited');
		expect(events).toHaveLength(1);
		expect(events[0].payload).toMatchObject({
			resets_at: NOW + 3_600_000 + 60_000,
			reported_reset_at: NOW + 3_600_000,
			limit: 'five_hour',
			run_id: 'arun_x'
		});
		expect(eventsOfType(t, 'runner.errored')).toHaveLength(0);
	});

	it('collapses a burst into one hold, but lets a later reset extend it', async () => {
		const t = world();
		const runner = addRunner(t);
		const note = (resumeAt: number) =>
			noteRateLimit(t.db, t.env, {
				userId: USER,
				runnerId: runner,
				error: 'rate limited',
				resumeAt,
				limit: null,
				now: NOW
			});
		await note(NOW + 3_600_000);
		// The other two runs of the burst die seconds later with the same wall.
		await note(NOW + 3_600_000);
		await note(NOW + 60_000);
		expect(runnerById(t, runner).backoff_until).toBe(NOW + 3_600_000 + 60_000);
		expect(eventsOfType(t, 'runner.rate_limited')).toHaveLength(1);

		// A later reset is better information, so it wins — unlike the
		// interruption backoff, which refuses any change inside its window.
		await note(NOW + 2 * 3_600_000);
		expect(runnerById(t, runner).backoff_until).toBe(NOW + 2 * 3_600_000 + 60_000);
		expect(eventsOfType(t, 'runner.rate_limited')).toHaveLength(2);
	});

	it('a known reset overrides a failure backoff, and a launch clears the reason', async () => {
		const t = world();
		const fake = createFakeAdapter();
		const runner = addRunner(t);
		addRule(t, { targets: [{ runner_id: runner }] });
		t.sqlite
			.prepare('UPDATE runner SET launch_failures = 3, backoff_until = ? WHERE id = ?')
			.run(NOW + 10_000, runner);
		await noteRateLimit(t.db, t.env, {
			userId: USER,
			runnerId: runner,
			error: 'rate limited',
			resumeAt: NOW + 3_600_000,
			limit: null,
			now: NOW
		});
		expect(runnerById(t, runner).backoff_reason).toBe('rate_limit');
		expect(runnerById(t, runner).launch_failures).toBe(3);

		addIssue(t);
		const after = NOW + 4_000_000;
		t.sqlite.prepare('UPDATE runner SET last_seen_at = ? WHERE id = ?').run(after, runner);
		await pass(t, fake, after);
		const r = runnerById(t, runner);
		expect(r.backoff_until).toBeNull();
		expect(r.backoff_reason).toBeNull();
		expect(r.launch_failures).toBe(0);
	});

	it('a successful launch clears the pressure an interruption applied', async () => {
		const t = world();
		const fake = createFakeAdapter();
		const runner = addRunner(t);
		addRule(t, { targets: [{ runner_id: runner }] });
		const issue = addIssue(t);
		await pass(t, fake);
		t.sqlite
			.prepare('UPDATE runner SET last_seen_at = ? WHERE id = ?')
			.run(NOW - 6 * 60_000, runner);
		setSettings(t, { enabled: false });
		await sweepSupervisor(t.db, t.env, NOW, { local: fake });
		expect(runnerById(t, runner).launch_failures).toBe(1);

		// The daemon comes back and the issue — never struck — is picked up
		// again. Launching is what proves the runner healthy, so that is what
		// clears the count; a poll alone (every 15s) would not be evidence.
		setSettings(t, { enabled: true });
		const back = (runnerById(t, runner).backoff_until as number) + 1;
		t.sqlite.prepare('UPDATE runner SET last_seen_at = ? WHERE id = ?').run(back, runner);
		await pass(t, fake, back);
		expect(runs(t).some((r) => r.status === 'running' && r.issue_id === issue)).toBe(true);
		expect(runnerById(t, runner).launch_failures).toBe(0);
		expect(runnerById(t, runner).backoff_until).toBeNull();
	});

	it('fails assigned runs unacknowledged after five minutes as launch failures', async () => {
		const t = world();
		const runner = addRunner(t);
		addRule(t, { targets: [{ runner_id: runner }] });
		const issue = addIssue(t);
		await pass(t, localAdapter); // stays assigned
		const runId = runs(t)[0].id as string;
		setSettings(t, { enabled: false });

		await sweepSupervisor(t.db, t.env, NOW + 6 * 60_000);
		const run = runById(t, runId)!;
		expect(run.status).toBe('failed');
		expect(run.error).toContain('not acknowledged');
		// Launch-failure semantics: runner flagged, issue unstruck.
		expect(runnerById(t, runner).launch_failures).toBe(1);
		expect(issueById(t, issue).attempt_count).toBe(0);
		expect(eventsOfType(t, 'runner.errored')).toHaveLength(1);
	});

	it('fails immediate-mode launching runs with no recorded session after five minutes', async () => {
		const t = world();
		const runner = addRunner(t);
		addRule(t, { targets: [{ runner_id: runner }] });
		addIssue(t);
		await pass(t, localAdapter);
		const runId = runs(t)[0].id as string;
		// Simulate a worker evicted between the flip and the session write.
		t.sqlite.prepare(`UPDATE agent_run SET status = 'launching' WHERE id = ?`).run(runId);
		// Keep the runner "seen" so the local offline rule stays out of the way.
		t.sqlite
			.prepare('UPDATE runner SET last_seen_at = ? WHERE id = ?')
			.run(NOW + 6 * 60_000 - 10_000, runner);
		setSettings(t, { enabled: false });

		// With an immediate-mode adapter this is provider-launch limbo.
		await sweepSupervisor(t.db, t.env, NOW + 6 * 60_000, { local: createFakeAdapter() });
		expect(runById(t, runId)!.status).toBe('failed');
		expect(runById(t, runId)!.error).toContain('no provider session');
	});

	it('a quiet poll-mode launching run with a live daemon survives the launch-stall sweep', async () => {
		const t = world();
		const runner = addRunner(t);
		addRule(t, { targets: [{ runner_id: runner }] });
		addIssue(t);
		await pass(t, localAdapter);
		const runId = runs(t)[0].id as string;
		// Delivered to the daemon (assigned → launching), which is quietly
		// cloning / running a harness that has emitted nothing yet: never a
		// session id, and `running` only arrives at the first log flush.
		t.sqlite.prepare(`UPDATE agent_run SET status = 'launching' WHERE id = ?`).run(runId);
		// The daemon is alive and polling.
		t.sqlite
			.prepare('UPDATE runner SET last_seen_at = ? WHERE id = ?')
			.run(NOW + 6 * 60_000 - 10_000, runner);
		setSettings(t, { enabled: false });

		// Default adapters: local is poll-mode, so the run is left alone —
		// its liveness is owned_runs, the offline rule, and the timeout.
		await sweepSupervisor(t.db, t.env, NOW + 6 * 60_000);
		expect(runById(t, runId)!.status).toBe('launching');
		expect(runnerById(t, runner).launch_failures).toBe(0);
	});

	it('a launching local run whose daemon went offline is failed by the offline rule', async () => {
		const t = world();
		const runner = addRunner(t);
		addRule(t, { targets: [{ runner_id: runner }] });
		const issue = addIssue(t);
		await pass(t, localAdapter);
		const runId = runs(t)[0].id as string;
		t.sqlite.prepare(`UPDATE agent_run SET status = 'launching' WHERE id = ?`).run(runId);
		// Daemon dead since delivery: nothing else would ever reap this run.
		setSettings(t, { enabled: false });

		await sweepSupervisor(t.db, t.env, NOW + 6 * 60_000);
		const run = runById(t, runId)!;
		expect(run.status).toBe('failed');
		expect(run.error).toBe('runner offline');
		// Never started: ended without judgment, so no strike on the issue.
		expect(issueById(t, issue).attempt_count).toBe(0);
	});

	it('revokes expired run keys even when the run end was never detected', async () => {
		const t = world();
		const runner = addRunner(t);
		const issue = addIssue(t);
		t.sqlite.exec(`
			INSERT INTO agent_run (id, user_id, issue_id, runner_id, status, tier, state_id_at_start, created_at, ended_at)
				VALUES ('arun_x', '${USER}', '${issue}', '${runner}', 'completed', 'balanced', '${OPEN}', ${NOW}, ${NOW});
			INSERT INTO api_key (id, user_id, name, key_hash, key_prefix, agent_run_id, expires_at, created_at)
				VALUES ('key_x', '${USER}', 'run arun_x', 'h', 'p', 'arun_x', ${NOW + 1000}, ${NOW});
		`);
		setSettings(t, { enabled: false });
		await sweepSupervisor(t.db, t.env, NOW + 2000);
		expect(t.all(`SELECT revoked_at FROM api_key WHERE id = 'key_x'`)[0].revoked_at).toBe(
			NOW + 2000
		);
	});

	it('runs the dispatch pass for every armed user', async () => {
		const t = world();
		const runner = addRunner(t);
		addRule(t, { targets: [{ runner_id: runner }] });
		addIssue(t);
		await sweepSupervisor(t.db, t.env, NOW); // default adapters: local = poll mode
		expect(runs(t)).toHaveLength(1);
		expect(runs(t)[0].status).toBe('assigned');
	});

	it('sweeps issue owners with missing settings and preserves saved stops', async () => {
		const t = world();
		const runner = addRunner(t);
		addRule(t, { targets: [{ runner_id: runner }] });
		addIssue(t, { title: 'Title only', description: '' });
		t.sqlite.exec(`DELETE FROM supervisor_settings WHERE user_id = '${USER}'`);

		await sweepSupervisor(t.db, t.env, NOW);
		expect(runs(t)).toHaveLength(1);

		const stopped = world();
		const stoppedRunner = addRunner(stopped);
		addRule(stopped, { targets: [{ runner_id: stoppedRunner }] });
		addIssue(stopped);
		setSettings(stopped, { enabled: false });
		const queries = stopped.spyOnQueries();
		await sweepSupervisor(stopped.db, stopped.env, NOW);
		expect(runs(stopped)).toHaveLength(0);
		// Exclusion happens in the sweep population query, rather than wasting a
		// dispatch pass whose later settings guard happens to mask the result.
		expect(queries().filter((query) => query.includes('from "supervisor_settings"')).length).toBe(
			0
		);
	});
});
