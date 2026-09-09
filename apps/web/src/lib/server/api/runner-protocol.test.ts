import { RUN_LOG_MAX_BYTES } from '@tines/shared';
import { describe, expect, it } from 'vitest';
import {
	addComment,
	addIssue,
	addRun,
	addRunner,
	addTransitionEvent,
	eventsOfType,
	issueById,
	keyForRun,
	NOW,
	OPEN,
	REVIEW,
	runById,
	runnerById,
	seedBase,
	setSettings,
	USER
} from '../supervisor/test-fixtures';
import { sha256Hex } from '../crypto';
import { ApiFail, type ActorContext } from './core';
import {
	appendLogTail,
	appendRunLog,
	authenticateRunnerToken,
	finishRun,
	pollRunner,
	type RunnerRow
} from './runner-protocol';
import { registerRunner, rotateRunnerToken, updateRunner } from './runners';
import { updateSupervisorSettings } from './supervisor';
import { createTestDb, type TestDb } from './test-db';

const actor: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

function world(): TestDb {
	const t = createTestDb();
	seedBase(t);
	setSettings(t);
	return t;
}

async function runnerRow(t: TestDb, id: string): Promise<RunnerRow> {
	const row = await t.db.selectFrom('runner').selectAll().where('id', '=', id).executeTakeFirst();
	if (!row) throw new Error(`no runner ${id}`);
	return row;
}

function expectFail(fn: () => Promise<unknown>, code: string): Promise<void> {
	return fn().then(
		() => {
			throw new Error(`expected ApiFail ${code}`);
		},
		(e) => {
			expect(e).toBeInstanceOf(ApiFail);
			expect((e as ApiFail).code).toBe(code);
		}
	);
}

// ---------------------------------------------------------------------------

describe('registerRunner', () => {
	it('creates a local runner with a hashed token, shown once', async () => {
		const t = world();
		const { runner, runner_token } = await registerRunner(t.db, t.env, actor, {
			name: 'laptop-m4',
			harness: 'claude_code',
			hostname: 'mbp.local',
			platform: 'darwin'
		});
		expect(runner.type).toBe('local');
		expect(runner.online).toBe(true); // registration counts as a heartbeat
		expect(runner_token).toMatch(/^tines_rt_/);
		const row = runnerById(t, runner.id);
		expect(row.runner_token_hash).toBe(await sha256Hex(runner_token));
		// The token never appears in the serialized runner.
		expect(JSON.stringify(runner)).not.toContain(runner_token);
		expect(eventsOfType(t, 'runner.registered')).toHaveLength(1);

		const authed = await authenticateRunnerToken(t.db, runner_token);
		expect(authed?.id).toBe(runner.id);
	});

	it('reconnects an existing local runner by name: same row, fresh token, old one dead', async () => {
		const t = world();
		const first = await registerRunner(t.db, t.env, actor, { name: 'laptop-m4' });
		const second = await registerRunner(t.db, t.env, actor, { name: 'laptop-m4' });
		expect(second.runner.id).toBe(first.runner.id);
		expect(second.runner_token).not.toBe(first.runner_token);
		expect(await authenticateRunnerToken(t.db, first.runner_token)).toBeUndefined();
		expect((await authenticateRunnerToken(t.db, second.runner_token))?.id).toBe(first.runner.id);
	});

	it('reconnect updates only the fields the daemon sent — server-side edits survive', async () => {
		const t = world();
		const first = await registerRunner(t.db, t.env, actor, {
			name: 'laptop-m4',
			max_concurrent: 2
		});
		// The user tuned these in the UI; the daemon never sends them.
		await updateRunner(t.db, t.env, actor, first.runner.id, {
			max_run_minutes: 90,
			default_tier: 'smartest'
		});
		const second = await registerRunner(t.db, t.env, actor, {
			name: 'laptop-m4',
			max_concurrent: 3,
			hostname: 'mbp.local'
		});
		expect(second.runner.max_concurrent).toBe(3); // sent: updated
		expect(second.runner.max_run_minutes).toBe(90); // not sent: kept
		expect(second.runner.default_tier).toBe('smartest'); // not sent: kept
		expect(second.runner.config.hostname).toBe('mbp.local');
	});

	it('reconnect away from the custom harness drops the stored command template', async () => {
		const t = world();
		const first = await registerRunner(t.db, t.env, actor, {
			name: 'laptop-m4',
			harness: 'custom',
			command: 'run {prompt_file}'
		});
		expect(first.runner.config.command).toBe('run {prompt_file}');
		const second = await registerRunner(t.db, t.env, actor, {
			name: 'laptop-m4',
			harness: 'claude_code'
		});
		expect(second.runner.config).toMatchObject({ harness: 'claude_code' });
		expect(second.runner.config.command).toBeUndefined();
	});

	it('rejects a custom harness without a command, and unknown-tier registrations', async () => {
		const t = world();
		await expectFail(
			() => registerRunner(t.db, t.env, actor, { name: 'x', harness: 'custom' }),
			'invalid_field'
		);
	});

	it('an API key is not a runner token (and vice versa: the inverse fence)', async () => {
		const t = world();
		await registerRunner(t.db, t.env, actor, { name: 'laptop-m4' });
		// A run key (an api_key row) never authenticates the protocol.
		expect(await authenticateRunnerToken(t.db, 'tines_someapikeysecret')).toBeUndefined();
	});
});

describe('rotateRunnerToken', () => {
	it('invalidates the old token, returns the new one once, keeps identity', async () => {
		const t = world();
		const { runner, runner_token } = await registerRunner(t.db, t.env, actor, {
			name: 'laptop-m4'
		});
		const rotated = await rotateRunnerToken(t.db, t.env, actor, runner.id);
		expect(rotated.runner.id).toBe(runner.id);
		expect(rotated.runner_token).not.toBe(runner_token);
		expect(await authenticateRunnerToken(t.db, runner_token)).toBeUndefined();
		expect((await authenticateRunnerToken(t.db, rotated.runner_token))?.id).toBe(runner.id);
		const updates = eventsOfType(t, 'runner.updated');
		expect(updates[updates.length - 1].payload.changed).toEqual(['runner_token']);
	});

	it('404s across users and 422s on managed runners', async () => {
		const t = world();
		const managed = addRunner(t, { type: 'claude_managed', name: 'claude' });
		await expectFail(() => rotateRunnerToken(t.db, t.env, actor, managed), 'invalid_runner_type');
		await expectFail(() => rotateRunnerToken(t.db, t.env, actor, 'rnr_none'), 'not_found');
	});
});

// ---------------------------------------------------------------------------

describe('pollRunner', () => {
	it('bumps last_seen_at and reports coming online', async () => {
		const t = world();
		const id = addRunner(t, { lastSeen: null });
		const later = NOW + 60_000;
		const { cameOnline, response } = await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, id),
			{ owned_runs: [] },
			later
		);
		expect(cameOnline).toBe(true);
		expect(response).toEqual({ assignments: [], cancels: [] });
		expect(runnerById(t, id).last_seen_at).toBe(later);
		// A fresh poll from an online runner is not "coming online".
		const again = await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, id),
			{ owned_runs: [] },
			later + 1000
		);
		expect(again.cameOnline).toBe(false);
	});

	it("adopts the daemon's max_concurrent: row updated, event recorded, capRaised on an increase", async () => {
		const t = world();
		const id = addRunner(t, { maxConcurrent: 1 });
		const raised = await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, id),
			{ owned_runs: [], max_concurrent: 3 },
			NOW + 1
		);
		expect(raised.capRaised).toBe(true);
		expect(runnerById(t, id).max_concurrent).toBe(3);
		const updates = eventsOfType(t, 'runner.updated');
		expect(updates).toHaveLength(1);
		expect(updates[0].payload.changed).toEqual(['max_concurrent']);

		// Same value: no event, no new capacity.
		const same = await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, id),
			{ owned_runs: [], max_concurrent: 3 },
			NOW + 2
		);
		expect(same.capRaised).toBe(false);
		expect(eventsOfType(t, 'runner.updated')).toHaveLength(1);

		// Lowering updates the row but frees no capacity; omitting it keeps the cap.
		const lowered = await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, id),
			{ owned_runs: [], max_concurrent: 2 },
			NOW + 3
		);
		expect(lowered.capRaised).toBe(false);
		expect(runnerById(t, id).max_concurrent).toBe(2);
		await pollRunner(t.db, t.env, await runnerRow(t, id), { owned_runs: [] }, NOW + 4);
		expect(runnerById(t, id).max_concurrent).toBe(2);
	});

	it('draining is stated per poll: set while true, cleared when absent, and leaving it frees capacity', async () => {
		const t = world();
		const id = addRunner(t);
		const entering = await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, id),
			{ owned_runs: [], draining: true },
			NOW + 1
		);
		expect(entering.capRaised).toBe(false);
		expect(runnerById(t, id).draining).toBe(1);
		// No runner.updated event: draining is the daemon's transient state, not an edit.
		expect(eventsOfType(t, 'runner.updated')).toHaveLength(0);

		// Still draining: nothing new to dispatch for.
		const still = await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, id),
			{ owned_runs: [], draining: true },
			NOW + 2
		);
		expect(still.capRaised).toBe(false);

		// The relaunched daemon (or one predating the field) polls without it:
		// the runner reopens, and that is a capacity change worth a pass.
		const leaving = await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, id),
			{ owned_runs: [] },
			NOW + 3
		);
		expect(leaving.capRaised).toBe(true);
		expect(runnerById(t, id).draining).toBe(0);

		await expectFail(
			async () =>
				pollRunner(
					t.db,
					t.env,
					await runnerRow(t, id),
					{ owned_runs: [], draining: 'yes' as unknown as boolean },
					NOW + 4
				),
			'invalid_field'
		);
	});

	it('a draining runner still receives the runs it already claimed', async () => {
		const t = world();
		const runnerId = addRunner(t);
		const issue = addIssue(t);
		const runId = addRun(t, { issueId: issue, runnerId });
		const { response } = await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			{ owned_runs: [], draining: true },
			NOW + 1
		);
		expect(response.assignments.map((a) => a.run.id)).toEqual([runId]);
		expect(runById(t, runId)?.status).toBe('launching');
	});

	it('rejects an out-of-bounds max_concurrent', async () => {
		const t = world();
		const id = addRunner(t);
		await expectFail(
			async () =>
				pollRunner(
					t.db,
					t.env,
					await runnerRow(t, id),
					{ owned_runs: [], max_concurrent: 0 },
					NOW + 1
				),
			'invalid_field'
		);
		await expectFail(
			async () =>
				pollRunner(
					t.db,
					t.env,
					await runnerRow(t, id),
					{ owned_runs: [], max_concurrent: 101 },
					NOW + 1
				),
			'invalid_field'
		);
	});

	it('delivers an assigned run exactly once: prompt, bundle, run key, launching flip', async () => {
		const t = world();
		const runnerId = addRunner(t, { name: 'laptop-m4' });
		const issue = addIssue(t);
		const runId = addRun(t, { issueId: issue, runnerId });

		const { response } = await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			{ owned_runs: [] },
			NOW + 1
		);
		expect(response.assignments).toHaveLength(1);
		const a = response.assignments[0];
		expect(a.run.id).toBe(runId);
		expect(a.run.status).toBe('launching');
		expect(a.timeout_minutes).toBe(30);
		// Preamble + stitched prompt: run identity, contract, and the issue block.
		expect(a.prompt).toContain('# Supervisor run');
		expect(a.prompt).toContain(`This is run ${runId} on runner "laptop-m4" for issue demo/`);
		expect(a.prompt).toContain('TINES_API_KEY');
		expect(a.prompt).toContain('## Issue: demo/');
		expect(a.bundle.repos).toEqual([]);
		// The run key is live, bound to the run, and hashed at rest.
		expect(a.run_key).toMatch(/^tines_/);
		const key = keyForRun(t, runId);
		expect(key?.key_hash).toBe(await sha256Hex(a.run_key));
		expect(key?.revoked_at).toBeNull();
		expect(runById(t, runId)?.status).toBe('launching');

		// One-shot: a second poll (the two-daemons-one-token case) gets nothing.
		const second = await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			{ owned_runs: [] },
			NOW + 2
		);
		expect(second.response.assignments).toEqual([]);
	});

	it('opens the delivered issue block with the human steer that started the round', async () => {
		const t = world();
		const runnerId = addRunner(t);
		const issue = addIssue(t);
		// A previous run ended, then the human sent the issue back and said why.
		addRun(t, {
			issueId: issue,
			runnerId,
			status: 'completed',
			endedAt: NOW - 7_200_000,
			stateAtStart: REVIEW
		});
		addTransitionEvent(t, {
			issueId: issue,
			apiKeyId: null,
			at: NOW - 3_600_000,
			from: REVIEW,
			to: OPEN,
			fromName: 'In review',
			toName: 'Open',
			action: 'Send back'
		});
		addComment(t, { issueId: issue, body: 'CI is red on the e2e job.', at: NOW - 3_500_000 });
		const runId = addRun(t, { issueId: issue, runnerId });

		const { response } = await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			{ owned_runs: [] },
			NOW + 1
		);
		const prompt = response.assignments[0].prompt;
		expect(response.assignments[0].run.id).toBe(runId);
		// The steer reaches the agent through the delivered prompt, not only
		// through a read of the issue.
		expect(prompt).toContain('### Since the last run');
		expect(prompt).toContain('Send back');
		expect(prompt).toContain('CI is red on the e2e job.');
		expect(prompt.indexOf('### Since the last run')).toBeLessThan(prompt.indexOf('### Comments'));
	});

	it('cancels the assignment instead of delivering when the issue moved away', async () => {
		const t = world();
		const runnerId = addRunner(t);
		const issue = addIssue(t);
		const runId = addRun(t, { issueId: issue, runnerId });
		// The issue was transitioned away between claim and delivery.
		t.sqlite.prepare('UPDATE issue SET state_id = ? WHERE id = ?').run(REVIEW, issue);

		const { response } = await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			{ owned_runs: [] },
			NOW + 1
		);
		expect(response.assignments).toEqual([]);
		const run = runById(t, runId);
		expect(run?.status).toBe('canceled');
		expect(run?.error).toContain('no longer eligible at delivery');
		// Free cancel: never started, so no judgment and no strike.
		expect(issueById(t, issue).attempt_count).toBe(0);
		// No run key was ever minted for it.
		expect(keyForRun(t, runId)).toBeUndefined();
	});

	it('cancels the assignment when automation was disarmed or the issue parked', async () => {
		const t = world();
		const runnerId = addRunner(t);
		const parked = addIssue(t);
		const runA = addRun(t, { issueId: parked, runnerId });
		t.sqlite.prepare('UPDATE issue SET needs_attention = 1 WHERE id = ?').run(parked);
		const { response } = await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			{ owned_runs: [] },
			NOW + 1
		);
		expect(response.assignments).toEqual([]);
		expect(runById(t, runA)?.status).toBe('canceled');

		const issue = addIssue(t);
		const runB = addRun(t, { issueId: issue, runnerId });
		setSettings(t, { enabled: false });
		const again = await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			{ owned_runs: [] },
			NOW + 2
		);
		expect(again.response.assignments).toEqual([]);
		expect(runById(t, runB)?.status).toBe('canceled');
	});

	it('a paused runner gets no deliveries (its assigned runs are already being canceled elsewhere)', async () => {
		const t = world();
		const runnerId = addRunner(t, { status: 'paused' });
		const issue = addIssue(t);
		const runId = addRun(t, { issueId: issue, runnerId });
		const { response } = await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			{ owned_runs: [] },
			NOW + 1
		);
		expect(response.assignments).toEqual([]);
		expect(runById(t, runId)?.status).toBe('assigned');
	});

	it('owned_runs reconciliation fails running runs the daemon lost', async () => {
		const t = world();
		const runnerId = addRunner(t, { maxConcurrent: 3 });
		const issueA = addIssue(t);
		const issueB = addIssue(t);
		const lost = addRun(t, { issueId: issueA, runnerId, status: 'running', startedAt: NOW });
		const kept = addRun(t, { issueId: issueB, runnerId, status: 'running', startedAt: NOW });
		const { response } = await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			{ owned_runs: [kept] },
			NOW + 1
		);
		const lostRun = runById(t, lost);
		expect(lostRun?.status).toBe('failed');
		expect(lostRun?.error).toContain('owned_runs');
		expect(runById(t, kept)?.status).toBe('running');
		// The daemon lost the run; the agent did not fail it. Judged
		// `interrupted`: the issue keeps its budget and is dispatchable again.
		expect(lostRun?.outcome).toBe('interrupted');
		expect(issueById(t, issueA).attempt_count).toBe(0);
		expect(response.cancels).toEqual([]);
	});

	it('owned_runs reconciliation puts the pressure on the runner, once per poll', async () => {
		const t = world();
		const runnerId = addRunner(t, { maxConcurrent: 3 });
		const lostA = addRun(t, {
			issueId: addIssue(t),
			runnerId,
			status: 'running',
			startedAt: NOW
		});
		const lostB = addRun(t, {
			issueId: addIssue(t),
			runnerId,
			status: 'running',
			startedAt: NOW
		});
		const { reconciled } = await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			{ owned_runs: [] },
			NOW + 1
		);
		expect(runById(t, lostA)?.outcome).toBe('interrupted');
		expect(runById(t, lostB)?.outcome).toBe('interrupted');
		// Two runs, one daemon restart: one incident, one increment, one event.
		const runner = runnerById(t, runnerId);
		expect(runner.launch_failures).toBe(1);
		expect(runner.backoff_until).toBeGreaterThan(NOW + 1);
		expect(eventsOfType(t, 'runner.errored')).toHaveLength(1);
		// The freed claims are dispatchable now, not at the next cron.
		expect(reconciled).toBe(true);
	});

	it('cancels lists owned runs the supervisor already settled (kill, do not finish)', async () => {
		const t = world();
		const runnerId = addRunner(t, { maxConcurrent: 3 });
		const issueA = addIssue(t);
		const issueB = addIssue(t);
		const settled = addRun(t, { issueId: issueA, runnerId, status: 'canceled', startedAt: NOW });
		const live = addRun(t, { issueId: issueB, runnerId, status: 'running', startedAt: NOW });
		const { response } = await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			{ owned_runs: [settled, live, 'arun_unknown'] },
			NOW + 1
		);
		expect(response.cancels.sort()).toEqual([settled, 'arun_unknown'].sort());
	});
});

// ---------------------------------------------------------------------------

describe('appendLogTail', () => {
	it('appends under the cap without dropping', () => {
		expect(appendLogTail('abc', 0, 'def')).toEqual({ log: 'abcdef', dropped: 0, evicted: null });
	});

	it('truncates from the head with byte accounting', () => {
		const log = 'x'.repeat(RUN_LOG_MAX_BYTES - 10);
		const first = appendLogTail(log, 0, 'y'.repeat(30));
		expect(new TextEncoder().encode(first.log).length).toBe(RUN_LOG_MAX_BYTES);
		expect(first.dropped).toBe(20);
		// The evicted bytes come back so the caller can spill them to R2.
		expect(first.evicted && new TextDecoder().decode(first.evicted)).toBe('x'.repeat(20));
		expect(first.log.endsWith('y'.repeat(30))).toBe(true);
		// Accounting accumulates across appends.
		const second = appendLogTail(first.log, first.dropped, 'z'.repeat(7));
		expect(second.dropped).toBe(27);
	});
});

describe('appendRunLog', () => {
	it('first append flips launching → running with started_at and the started event', async () => {
		const t = world();
		const runnerId = addRunner(t);
		const issue = addIssue(t);
		const runId = addRun(t, { issueId: issue, runnerId, status: 'launching' });
		const res = await appendRunLog(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			runId,
			'hello\n',
			NOW + 5
		);
		expect(res).toEqual({ status: 'running', log_bytes_dropped: 0, log_seq: 0 });
		const run = runById(t, runId);
		expect(run?.status).toBe('running');
		expect(run?.started_at).toBe(NOW + 5);
		expect(run?.log).toBe('hello\n');
		const started = eventsOfType(t, 'agent_run.started');
		expect(started).toHaveLength(1);
		expect(started[0].payload.run_id).toBe(runId);
	});

	it("rejects appends to undelivered, ended, or other runners' runs", async () => {
		const t = world();
		const runnerId = addRunner(t);
		const other = addRunner(t, { name: 'other' });
		const issue = addIssue(t);
		const runId = addRun(t, { issueId: issue, runnerId, status: 'assigned' });
		const row = await runnerRow(t, runnerId);
		const otherRow = await runnerRow(t, other);
		await expectFail(() => appendRunLog(t.db, t.env, row, runId, 'x', NOW), 'run_not_delivered');
		await expectFail(() => appendRunLog(t.db, t.env, otherRow, runId, 'x', NOW), 'not_found');
		t.sqlite.prepare(`UPDATE agent_run SET status = 'completed' WHERE id = ?`).run(runId);
		await expectFail(() => appendRunLog(t.db, t.env, row, runId, 'x', NOW), 'run_already_ended');
	});

	it('accounts truncation on the stored row', async () => {
		const t = world();
		const runnerId = addRunner(t);
		const issue = addIssue(t);
		const runId = addRun(t, {
			issueId: issue,
			runnerId,
			status: 'running',
			startedAt: NOW,
			log: 'x'.repeat(RUN_LOG_MAX_BYTES)
		});
		await appendRunLog(t.db, t.env, await runnerRow(t, runnerId), runId, 'tail', NOW + 1);
		const run = runById(t, runId);
		expect(run?.log_bytes_dropped).toBe(4);
		expect((run?.log as string).endsWith('tail')).toBe(true);
		expect(new TextEncoder().encode(run?.log as string).length).toBe(RUN_LOG_MAX_BYTES);
	});
});

// ---------------------------------------------------------------------------

describe('finishRun', () => {
	async function delivered(t: TestDb, opts: { runnerId: string; issueId: string }) {
		const runId = addRun(t, { issueId: opts.issueId, runnerId: opts.runnerId });
		const { response } = await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, opts.runnerId),
			{ owned_runs: [] },
			NOW + 1
		);
		expect(response.assignments.map((a) => a.run.id)).toContain(runId);
		return runId;
	}

	it('completed + a run-key transition = advanced: attempt reset, key revoked immediately', async () => {
		const t = world();
		const runnerId = addRunner(t);
		const issue = addIssue(t, { attemptCount: 2 });
		const runId = await delivered(t, { runnerId, issueId: issue });
		await appendRunLog(t.db, t.env, await runnerRow(t, runnerId), runId, 'working…\n', NOW + 10);
		const keyId = keyForRun(t, runId)?.id as string;
		addTransitionEvent(t, { issueId: issue, apiKeyId: keyId, at: NOW + 20 });

		const run = await finishRun(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			runId,
			{ status: 'completed' },
			NOW + 30
		);
		expect(run.status).toBe('completed');
		expect(issueById(t, issue).attempt_count).toBe(0);
		expect(keyForRun(t, runId)?.revoked_at).toBe(NOW + 30);
		const ended = eventsOfType(t, 'agent_run.ended');
		expect(ended[ended.length - 1].payload.outcome).toBe('advanced');
	});

	it('a do-nothing finish straight from launching is still judged — and strikes', async () => {
		const t = world();
		const runnerId = addRunner(t);
		const issue = addIssue(t);
		const runId = await delivered(t, { runnerId, issueId: issue });
		// No logs, no transition: the harness exited silently.
		const run = await finishRun(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			runId,
			{ status: 'completed' },
			NOW + 30
		);
		expect(run.status).toBe('completed');
		expect(issueById(t, issue).attempt_count).toBe(1);
		const ended = eventsOfType(t, 'agent_run.ended');
		expect(ended[ended.length - 1].payload.outcome).toBe('stalled');
	});

	it('a daemon reporting its own shutdown is interrupted: no strike, runner backs off', async () => {
		const t = world();
		const runnerId = addRunner(t);
		const issue = addIssue(t, { attemptCount: 2 });
		const runId = await delivered(t, { runnerId, issueId: issue });
		await appendRunLog(t.db, t.env, await runnerRow(t, runnerId), runId, 'working…\n', NOW + 10);

		const run = await finishRun(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			runId,
			{ status: 'failed', error: 'daemon shut down', judgment: 'interrupted' },
			NOW + 30
		);
		expect(run.status).toBe('failed');
		expect(run.outcome).toBe('interrupted');
		// Neither charged nor forgiven: the attempt the daemon swallowed
		// simply never happened.
		expect(issueById(t, issue).attempt_count).toBe(2);
		expect(eventsOfType(t, 'issue.parked')).toHaveLength(0);
		expect(keyForRun(t, runId)?.revoked_at).toBe(NOW + 30);
		const ended = eventsOfType(t, 'agent_run.ended');
		expect(ended[ended.length - 1].payload.outcome).toBe('interrupted');
		// The pressure moved to the runner rather than disappearing.
		expect(runnerById(t, runnerId).launch_failures).toBe(1);
		expect(eventsOfType(t, 'runner.errored')).toHaveLength(1);
	});

	it('a usage limit spares the issue and holds the runner to the reset', async () => {
		const t = world();
		const runnerId = addRunner(t);
		const issue = addIssue(t, { attemptCount: 2 });
		const runId = await delivered(t, { runnerId, issueId: issue });

		const run = await finishRun(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			runId,
			{
				status: 'failed',
				error: 'rate limited: session limit · resets 3pm (America/New_York)',
				judgment: 'rate_limited',
				resume_at: NOW + 3_600_000
			},
			NOW + 30
		);
		expect(run.outcome).toBe('interrupted');
		// The wall was the provider's, not this issue's: no strike, no parking.
		expect(issueById(t, issue).attempt_count).toBe(2);
		expect(issueById(t, issue).needs_attention).toBe(0);
		expect(eventsOfType(t, 'issue.parked')).toHaveLength(0);
		expect(keyForRun(t, runId)?.revoked_at).toBe(NOW + 30);
		const r = runnerById(t, runnerId);
		expect(r.backoff_until).toBe(NOW + 3_600_000 + 60_000);
		expect(r.backoff_reason).toBe('rate_limit');
		// Not the dead-credential counter: nothing is wrong with this runner.
		expect(r.launch_failures).toBe(0);
		expect(eventsOfType(t, 'runner.errored')).toHaveLength(0);
		expect(eventsOfType(t, 'runner.rate_limited')).toHaveLength(1);
	});

	it('holds on the empty-stdout shape too: a run that died while still launching', async () => {
		const t = world();
		const runnerId = addRunner(t);
		const runId = await delivered(t, { runnerId, issueId: addIssue(t) });
		await finishRun(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			runId,
			{
				status: 'failed',
				error: "rate limited: You've hit your session limit",
				judgment: 'rate_limited'
			},
			NOW + 30
		);
		// No reset reported: the default hold, not nothing.
		expect(runnerById(t, runnerId).backoff_until).toBe(NOW + 30 + 30 * 60_000);
		expect(runnerById(t, runnerId).backoff_reason).toBe('rate_limit');
	});

	it('a burst of rate-limited finishes is one hold and one event', async () => {
		const t = world();
		const runnerId = addRunner(t, { maxConcurrent: 2 });
		const runA = await delivered(t, { runnerId, issueId: addIssue(t) });
		const runB = await delivered(t, { runnerId, issueId: addIssue(t) });
		const report = async (runId: string) =>
			finishRun(
				t.db,
				t.env,
				await runnerRow(t, runnerId),
				runId,
				{
					status: 'failed',
					error: 'rate limited',
					judgment: 'rate_limited',
					resume_at: NOW + 600_000
				},
				NOW + 30
			);
		await report(runA);
		await report(runB);
		expect(eventsOfType(t, 'runner.rate_limited')).toHaveLength(1);
		expect(runnerById(t, runnerId).backoff_until).toBe(NOW + 600_000 + 60_000);
	});

	it('rejects a resume_at that is not a number, and ignores the judgment on success', async () => {
		const t = world();
		const runnerId = addRunner(t);
		const runId = await delivered(t, { runnerId, issueId: addIssue(t) });
		await expect(
			finishRun(
				t.db,
				t.env,
				await runnerRow(t, runnerId),
				runId,
				{ status: 'failed', judgment: 'rate_limited', resume_at: 'soon' } as never,
				NOW + 30
			)
		).rejects.toThrow(/resume_at/);
		// A completed run is the work landing; a limit claim on it means nothing.
		const run = await finishRun(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			runId,
			{ status: 'completed', judgment: 'rate_limited', resume_at: NOW + 600_000 } as never,
			NOW + 30
		);
		expect(run.status).toBe('completed');
		expect(runnerById(t, runnerId).backoff_reason).toBeNull();
		expect(eventsOfType(t, 'runner.rate_limited')).toHaveLength(0);
	});

	it('a shutdown reporting two runs is one incident, not two', async () => {
		const t = world();
		const runnerId = addRunner(t, { maxConcurrent: 2 });
		const runA = await delivered(t, { runnerId, issueId: addIssue(t) });
		const runB = await delivered(t, { runnerId, issueId: addIssue(t) });
		for (const runId of [runA, runB]) {
			await appendRunLog(t.db, t.env, await runnerRow(t, runnerId), runId, 'x\n', NOW + 10);
			await finishRun(
				t.db,
				t.env,
				await runnerRow(t, runnerId),
				runId,
				{ status: 'failed', error: 'daemon shut down', judgment: 'interrupted' },
				NOW + 30
			);
		}
		expect(runById(t, runA)?.outcome).toBe('interrupted');
		expect(runById(t, runB)?.outcome).toBe('interrupted');
		// One Ctrl-C, one failure: the burst of finish reports lands inside
		// the backoff window the first one opened.
		expect(runnerById(t, runnerId).launch_failures).toBe(1);
		expect(eventsOfType(t, 'runner.errored')).toHaveLength(1);
	});

	it('an ordinary failed finish still strikes — only the daemon-set judgment is spared', async () => {
		const t = world();
		const runnerId = addRunner(t);
		const issue = addIssue(t, { attemptCount: 1 });
		const runId = await delivered(t, { runnerId, issueId: issue });
		await appendRunLog(t.db, t.env, await runnerRow(t, runnerId), runId, 'cloning…\n', NOW + 10);

		const run = await finishRun(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			runId,
			{ status: 'failed', error: 'workspace setup failed: git clone exited 128' },
			NOW + 30
		);
		expect(run.outcome).toBe('stalled');
		expect(issueById(t, issue).attempt_count).toBe(2);
		expect(runnerById(t, runnerId).launch_failures).toBe(0);
	});

	it('judgment on a completed finish is ignored: a quiet success still strikes', async () => {
		const t = world();
		const runnerId = addRunner(t);
		const issue = addIssue(t);
		const runId = await delivered(t, { runnerId, issueId: issue });
		await appendRunLog(t.db, t.env, await runnerRow(t, runnerId), runId, 'done\n', NOW + 10);

		const run = await finishRun(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			runId,
			{ status: 'completed', judgment: 'interrupted' },
			NOW + 30
		);
		expect(run.outcome).toBe('stalled');
		expect(issueById(t, issue).attempt_count).toBe(1);
		expect(runnerById(t, runnerId).launch_failures).toBe(0);
	});

	it('failed finishes record the error and usage lands on the run', async () => {
		const t = world();
		const runnerId = addRunner(t);
		const issue = addIssue(t);
		const runId = await delivered(t, { runnerId, issueId: issue });
		const run = await finishRun(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			runId,
			{
				status: 'failed',
				error: 'harness exited with 1',
				usage: { input_tokens: 100, output_tokens: 20, cost_usd: 0.5, cost_source: 'provider' }
			},
			NOW + 30
		);
		expect(run.status).toBe('failed');
		expect(run.error).toBe('harness exited with 1');
		expect(run.usage).toEqual({
			input_tokens: 100,
			output_tokens: 20,
			cost_usd: 0.5,
			cost_source: 'provider'
		});
	});

	it('finishing a settled run 422s (the cancels path reports nothing)', async () => {
		const t = world();
		const runnerId = addRunner(t);
		const issue = addIssue(t);
		const runId = addRun(t, { issueId: issue, runnerId, status: 'canceled' });
		const row = await runnerRow(t, runnerId);
		await expectFail(
			() => finishRun(t.db, t.env, row, runId, { status: 'completed' }, NOW),
			'run_already_ended'
		);
	});
});

// ---------------------------------------------------------------------------

describe('pause and kill-switch cancels', () => {
	it('pausing a runner cancels its assigned runs; launching/running finish', async () => {
		const t = world();
		const runnerId = addRunner(t, { maxConcurrent: 3 });
		const assigned = addRun(t, { issueId: addIssue(t), runnerId });
		const running = addRun(t, {
			issueId: addIssue(t),
			runnerId,
			status: 'running',
			startedAt: NOW
		});
		await updateRunner(t.db, t.env, actor, runnerId, { status: 'paused' });
		expect(runById(t, assigned)?.status).toBe('canceled');
		expect(runById(t, assigned)?.error).toBe('runner paused');
		expect(runById(t, running)?.status).toBe('running');
	});

	it('the kill switch off cancels assigned runs fleet-wide; bulk cancel takes the rest', async () => {
		const t = world();
		const a = addRunner(t, { name: 'a', maxConcurrent: 3 });
		const b = addRunner(t, { name: 'b', maxConcurrent: 3 });
		const assignedA = addRun(t, { issueId: addIssue(t), runnerId: a });
		const assignedB = addRun(t, { issueId: addIssue(t), runnerId: b });
		const runningIssue = addIssue(t);
		const running = addRun(t, {
			issueId: runningIssue,
			runnerId: a,
			status: 'running',
			startedAt: NOW
		});

		const off = await updateSupervisorSettings(t.db, t.env, actor, { enabled: false });
		expect(off.enabled).toBe(false);
		expect(off.canceled_runs).toBe(2);
		expect(runById(t, assignedA)?.status).toBe('canceled');
		expect(runById(t, assignedB)?.status).toBe('canceled');
		expect(runById(t, running)?.status).toBe('running');

		// The bulk-cancel option: plain individual cancels, strikes and all.
		const bulk = await updateSupervisorSettings(t.db, t.env, actor, {
			enabled: false,
			cancel_in_flight: true
		});
		expect(bulk.canceled_runs).toBe(1);
		expect(runById(t, running)?.status).toBe('canceled');
		expect(issueById(t, runningIssue).attempt_count).toBe(1);
	});

	it('cancel_in_flight is rejected while enabling', async () => {
		const t = world();
		await expectFail(
			() => updateSupervisorSettings(t.db, t.env, actor, { enabled: true, cancel_in_flight: true }),
			'invalid_field'
		);
	});
});
