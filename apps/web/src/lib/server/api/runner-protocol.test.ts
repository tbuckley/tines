import {
	recordDispatchEffects,
	TEST_NOOP_DISPATCH_EFFECTS
} from '$lib/server/api/test-dispatch-effects';
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
	validateEffortCapabilities,
	type RunnerRow
} from './runner-protocol';
import { registerRunner, rotateRunnerToken, updateRunner } from './runners';
import { getSupervisorSettings, updateSupervisorSettings } from './supervisor';
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

describe('effort capability validation', () => {
	const report = {
		version: 1 as const,
		daemon_version: '0.0.194',
		harness: 'codex' as const,
		harness_version: '0.153.4',
		catalog_digest: 'sha256:test',
		models: [{ model: 'gpt-5.6', efforts: ['low', 'ultra'] }]
	};

	it('accepts bounded exact-model reports only from identified daemon boots', () => {
		expect(validateEffortCapabilities(report, 'boot_1')).toEqual(report);
		expect(() => validateEffortCapabilities(report)).toThrowError(ApiFail);
		expect(() =>
			validateEffortCapabilities(
				{ ...report, models: [{ model: 'gpt-5.6', efforts: ['High'] }] },
				'boot_1'
			)
		).toThrowError(ApiFail);
	});

	it('retains unsupported protocol versions distinctly from absent legacy reports', () => {
		expect(validateEffortCapabilities(undefined, 'boot_1')).toBeNull();
		expect(
			validateEffortCapabilities({ version: 2, reason: 'upgrade required' }, 'boot_1')
		).toEqual({
			version: 2,
			reason: 'upgrade required'
		});
	});
});

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
		const effects = recordDispatchEffects();
		const { runner, runner_token } = await registerRunner(t.db, t.env, actor, effects, {
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
		expect(effects.count()).toBe(1);

		const authed = await authenticateRunnerToken(t.db, runner_token);
		expect(authed?.id).toBe(runner.id);
	});

	it('reconnects an existing local runner by name: same row, fresh token, old one dead', async () => {
		const t = world();
		const effects = recordDispatchEffects();
		const first = await registerRunner(t.db, t.env, actor, effects, {
			name: 'laptop-m4'
		});
		const second = await registerRunner(t.db, t.env, actor, effects, {
			name: 'laptop-m4'
		});
		expect(second.runner.id).toBe(first.runner.id);
		expect(second.runner_token).not.toBe(first.runner_token);
		expect(await authenticateRunnerToken(t.db, first.runner_token)).toBeUndefined();
		expect((await authenticateRunnerToken(t.db, second.runner_token))?.id).toBe(first.runner.id);
		expect(runnerById(t, first.runner.id).resume_config_revision).toBe(0);
		expect(effects.count()).toBe(2);
	});

	it.each(['new', 'reconnect'] as const)(
		'keeps a %s registration silent when its batch rejects',
		async (branch) => {
			const t = world();
			if (branch === 'reconnect') {
				await registerRunner(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, {
					name: 'laptop-m4'
				});
			}
			const beforeEvents = t.all(
				"SELECT id FROM event WHERE type IN ('runner.registered', 'runner.updated')"
			);
			const effects = recordDispatchEffects();
			t.env.DB.batch = async () => {
				throw new Error('injected registration batch failure');
			};
			await expect(
				registerRunner(t.db, t.env, actor, effects, { name: 'laptop-m4' })
			).rejects.toThrow('injected registration batch failure');
			expect(effects.count()).toBe(0);
			expect(
				t.all("SELECT id FROM event WHERE type IN ('runner.registered', 'runner.updated')")
			).toEqual(beforeEvents);
		}
	);

	it('reconnect updates only the fields the daemon sent — server-side edits survive', async () => {
		const t = world();
		const first = await registerRunner(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, {
			name: 'laptop-m4',
			max_concurrent: 2
		});
		// The user tuned these in the UI; the daemon never sends them.
		await updateRunner(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, first.runner.id, {
			max_run_minutes: 90,
			default_tier: 'smartest'
		});
		const second = await registerRunner(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, {
			name: 'laptop-m4',
			max_concurrent: 3,
			hostname: 'mbp.local'
		});
		expect(second.runner.max_concurrent).toBe(3); // sent: updated
		expect(second.runner.max_run_minutes).toBe(90); // not sent: kept
		expect(second.runner.default_tier).toBe('smartest'); // not sent: kept
		expect(second.runner.config.hostname).toBe('mbp.local');
		expect(runnerById(t, first.runner.id).resume_config_revision).toBe(2);
	});

	it('reconnect away from the custom harness drops the stored command template', async () => {
		const t = world();
		const first = await registerRunner(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, {
			name: 'laptop-m4',
			harness: 'custom',
			command: 'run {prompt_file}'
		});
		expect(first.runner.config.command).toBe('run {prompt_file}');
		const second = await registerRunner(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, {
			name: 'laptop-m4',
			harness: 'claude_code'
		});
		expect(second.runner.config).toMatchObject({ harness: 'claude_code' });
		expect(second.runner.config.command).toBeUndefined();
	});

	it('rejects a custom harness without a command, and unknown-tier registrations', async () => {
		const t = world();
		const effects = recordDispatchEffects();
		await expectFail(
			() =>
				registerRunner(t.db, t.env, actor, effects, {
					name: 'x',
					harness: 'custom'
				}),
			'invalid_field'
		);
		expect(effects.count()).toBe(0);
	});

	it('an API key is not a runner token (and vice versa: the inverse fence)', async () => {
		const t = world();
		await registerRunner(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, { name: 'laptop-m4' });
		// A run key (an api_key row) never authenticates the protocol.
		expect(await authenticateRunnerToken(t.db, 'tines_someapikeysecret')).toBeUndefined();
	});
});

describe('rotateRunnerToken', () => {
	it('invalidates the old token, returns the new one once, keeps identity', async () => {
		const t = world();
		const { runner, runner_token } = await registerRunner(
			t.db,
			t.env,
			actor,
			TEST_NOOP_DISPATCH_EFFECTS,
			{
				name: 'laptop-m4'
			}
		);
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
	it('claims an instance silently, then atomically replaces and fences it once', async () => {
		const t = world();
		const id = addRunner(t);

		await pollRunner(t.db, t.env, await runnerRow(t, id), TEST_NOOP_DISPATCH_EFFECTS, {
			instance_id: 'daemon_A',
			owned_runs: []
		});
		expect(runnerById(t, id)).toMatchObject({
			daemon_instance_id: 'daemon_A',
			fenced_instance_id: null
		});
		expect(eventsOfType(t, 'runner.daemon_replaced')).toHaveLength(0);

		await pollRunner(t.db, t.env, await runnerRow(t, id), TEST_NOOP_DISPATCH_EFFECTS, {
			instance_id: 'daemon_B',
			owned_runs: []
		});
		await pollRunner(t.db, t.env, await runnerRow(t, id), TEST_NOOP_DISPATCH_EFFECTS, {
			instance_id: 'daemon_B',
			owned_runs: []
		});
		expect(runnerById(t, id)).toMatchObject({
			daemon_instance_id: 'daemon_B',
			fenced_instance_id: 'daemon_A'
		});
		const replacements = eventsOfType(t, 'runner.daemon_replaced');
		expect(replacements).toHaveLength(1);
		expect(replacements[0]).toMatchObject({
			actor_user_id: USER,
			actor_api_key_id: null,
			payload: { runner_id: id, name: id }
		});
	});

	it('rolls replacement history and ownership back together when admission fails', async () => {
		const t = world();
		const id = addRunner(t);
		await pollRunner(t.db, t.env, await runnerRow(t, id), TEST_NOOP_DISPATCH_EFFECTS, {
			instance_id: 'daemon_A',
			owned_runs: []
		});

		const d1 = t.env.DB;
		const realBatch = d1.batch.bind(d1);
		d1.batch = async (statements) => {
			// The replacement event is statement 0. Make the following ownership
			// write fail inside the same native batch: D1 must retain neither one.
			const failure = d1.prepare('INSERT INTO no_such_table DEFAULT VALUES');
			if (statements.length === 1) return realBatch(statements);
			const eventOffset = statements.length === 3 ? 1 : 0;
			return realBatch([
				...statements.slice(0, eventOffset),
				failure,
				...statements.slice(eventOffset + 1)
			]);
		};
		await expect(
			pollRunner(t.db, t.env, await runnerRow(t, id), TEST_NOOP_DISPATCH_EFFECTS, {
				instance_id: 'daemon_B',
				owned_runs: []
			})
		).rejects.toThrow();
		expect(runnerById(t, id)).toMatchObject({
			daemon_instance_id: 'daemon_A',
			fenced_instance_id: null
		});
		expect(eventsOfType(t, 'runner.daemon_replaced')).toHaveLength(0);

		// Restore the real binding and prove the same takeover succeeds cleanly.
		d1.batch = realBatch;
		await pollRunner(t.db, t.env, await runnerRow(t, id), TEST_NOOP_DISPATCH_EFFECTS, {
			instance_id: 'daemon_B',
			owned_runs: []
		});
		expect(runnerById(t, id)).toMatchObject({
			daemon_instance_id: 'daemon_B',
			fenced_instance_id: 'daemon_A'
		});
		expect(eventsOfType(t, 'runner.daemon_replaced')).toHaveLength(1);
	});

	it('rejects a fenced instance before any poll side effect, even with a stale auth snapshot', async () => {
		const t = world();
		const id = addRunner(t, { maxConcurrent: 1 });
		await pollRunner(t.db, t.env, await runnerRow(t, id), TEST_NOOP_DISPATCH_EFFECTS, {
			instance_id: 'daemon_A',
			owned_runs: []
		});
		const staleA = await runnerRow(t, id);
		await pollRunner(t.db, t.env, await runnerRow(t, id), TEST_NOOP_DISPATCH_EFFECTS, {
			instance_id: 'daemon_B',
			owned_runs: []
		});
		const runningIssue = addIssue(t);
		const assignedIssue = addIssue(t);
		const running = addRun(t, { issueId: runningIssue, runnerId: id, status: 'running' });
		const assigned = addRun(t, { issueId: assignedIssue, runnerId: id, status: 'assigned' });
		const before = {
			runner: runnerById(t, id),
			runs: t.all('SELECT * FROM agent_run ORDER BY id'),
			events: t.all('SELECT * FROM event ORDER BY id'),
			keys: t.all('SELECT * FROM api_key ORDER BY id')
		};

		try {
			await pollRunner(
				t.db,
				t.env,
				staleA,
				TEST_NOOP_DISPATCH_EFFECTS,
				{ instance_id: 'daemon_A', owned_runs: [], max_concurrent: 7, draining: true },
				NOW + 99
			);
			throw new Error('expected runner conflict');
		} catch (error) {
			expect(error).toBeInstanceOf(ApiFail);
			expect(error).toMatchObject({ status: 409, code: 'runner_conflict' });
			expect((error as Error).message).toContain('superseded');
		}
		expect(runnerById(t, id)).toEqual(before.runner);
		expect(t.all('SELECT * FROM agent_run ORDER BY id')).toEqual(before.runs);
		expect(t.all('SELECT * FROM event ORDER BY id')).toEqual(before.events);
		expect(t.all('SELECT * FROM api_key ORDER BY id')).toEqual(before.keys);
		expect(runById(t, running)?.status).toBe('running');
		expect(runById(t, assigned)?.status).toBe('assigned');
		expect(keyForRun(t, assigned)).toBeUndefined();
	});

	it('leaves modern ownership untouched for legacy polls and remembers only one predecessor', async () => {
		const t = world();
		const id = addRunner(t, { maxConcurrent: 1 });
		for (const instance_id of ['daemon_A', 'daemon_B', 'daemon_C']) {
			await pollRunner(t.db, t.env, await runnerRow(t, id), TEST_NOOP_DISPATCH_EFFECTS, {
				instance_id,
				owned_runs: []
			});
		}
		expect(runnerById(t, id)).toMatchObject({
			daemon_instance_id: 'daemon_C',
			fenced_instance_id: 'daemon_B'
		});

		await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, id),
			TEST_NOOP_DISPATCH_EFFECTS,
			{ owned_runs: [], max_concurrent: 4, draining: true },
			NOW + 10
		);
		expect(runnerById(t, id)).toMatchObject({
			daemon_instance_id: 'daemon_C',
			fenced_instance_id: 'daemon_B',
			max_concurrent: 4,
			draining: 1,
			last_seen_at: NOW + 10
		});

		// A is no longer the remembered predecessor and can take over again.
		await pollRunner(t.db, t.env, await runnerRow(t, id), TEST_NOOP_DISPATCH_EFFECTS, {
			instance_id: 'daemon_A',
			owned_runs: []
		});
		expect(runnerById(t, id)).toMatchObject({
			daemon_instance_id: 'daemon_A',
			fenced_instance_id: 'daemon_C'
		});
	});

	it.each([null, '', ' ', 'bad.id', 7, [], 'x'.repeat(129)])(
		'rejects invalid instance id %j before taking ownership',
		async (instance_id) => {
			const t = world();
			const id = addRunner(t);
			await expectFail(
				() =>
					pollRunner(
						t.db,
						t.env,
						runnerById(t, id) as unknown as RunnerRow,
						TEST_NOOP_DISPATCH_EFFECTS,
						{
							instance_id: instance_id as string,
							owned_runs: []
						}
					),
				'invalid_field'
			);
			expect(runnerById(t, id)).toMatchObject({
				daemon_instance_id: null,
				fenced_instance_id: null
			});
			expect(eventsOfType(t, 'runner.daemon_replaced')).toHaveLength(0);
		}
	);

	it('bumps last_seen_at and reports coming online', async () => {
		const t = world();
		const id = addRunner(t, { lastSeen: null });
		const effects = recordDispatchEffects();
		const later = NOW + 60_000;
		const { cameOnline, response } = await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, id),
			effects,
			{ owned_runs: [] },
			later
		);
		expect(cameOnline).toBe(true);
		expect(response).toEqual({ assignments: [], cancels: [] });
		expect(runnerById(t, id).last_seen_at).toBe(later);
		expect(effects.count()).toBe(1);
		// A fresh poll from an online runner is not "coming online".
		const again = await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, id),
			effects,
			{ owned_runs: [] },
			later + 1000
		);
		expect(again.cameOnline).toBe(false);
		expect(effects.count()).toBe(1);
	});

	it('signals immediately after the heartbeat commit, before later reads can fail', async () => {
		const t = world();
		const id = addRunner(t, { lastSeen: null });
		let signals = 0;
		await expect(
			pollRunner(
				t.db,
				t.env,
				await runnerRow(t, id),
				{
					signalDispatch() {
						signals++;
						t.sqlite.exec('DROP TABLE agent_run');
					}
				},
				{ owned_runs: [] },
				NOW + 1
			)
		).rejects.toThrow();
		expect(signals).toBe(1);
		expect(runnerById(t, id).last_seen_at).toBe(NOW + 1);
	});

	it("adopts the daemon's max_concurrent: row updated, event recorded, capRaised on an increase", async () => {
		const t = world();
		const id = addRunner(t, { maxConcurrent: 1 });
		const raised = await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, id),
			TEST_NOOP_DISPATCH_EFFECTS,
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
			TEST_NOOP_DISPATCH_EFFECTS,
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
			TEST_NOOP_DISPATCH_EFFECTS,
			{ owned_runs: [], max_concurrent: 2 },
			NOW + 3
		);
		expect(lowered.capRaised).toBe(false);
		expect(runnerById(t, id).max_concurrent).toBe(2);
		await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, id),
			TEST_NOOP_DISPATCH_EFFECTS,
			{ owned_runs: [] },
			NOW + 4
		);
		expect(runnerById(t, id).max_concurrent).toBe(2);
	});

	it('draining is stated per poll: set while true, cleared when absent, and leaving it frees capacity', async () => {
		const t = world();
		const id = addRunner(t);
		const entering = await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, id),
			TEST_NOOP_DISPATCH_EFFECTS,
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
			TEST_NOOP_DISPATCH_EFFECTS,
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
			TEST_NOOP_DISPATCH_EFFECTS,
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
					TEST_NOOP_DISPATCH_EFFECTS,
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
			TEST_NOOP_DISPATCH_EFFECTS,
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
					TEST_NOOP_DISPATCH_EFFECTS,
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
					TEST_NOOP_DISPATCH_EFFECTS,
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
			TEST_NOOP_DISPATCH_EFFECTS,
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
			TEST_NOOP_DISPATCH_EFFECTS,
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
			TEST_NOOP_DISPATCH_EFFECTS,
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

	it('delivers a title-only assignment when the settings row is missing', async () => {
		const t = world();
		t.sqlite.exec(`DELETE FROM supervisor_settings WHERE user_id = '${USER}'`);
		const runnerId = addRunner(t);
		const issue = addIssue(t, { title: 'Title only', description: '' });
		const runId = addRun(t, { issueId: issue, runnerId });

		const { response } = await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			TEST_NOOP_DISPATCH_EFFECTS,
			{ owned_runs: [] },
			NOW + 1
		);
		expect(response.assignments.map((assignment) => assignment.run.id)).toEqual([runId]);
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
			TEST_NOOP_DISPATCH_EFFECTS,
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

	it('cancels and redispatches when an enforced claim reaches a downgraded daemon', async () => {
		const t = world();
		const effects = recordDispatchEffects();
		const runnerId = addRunner(t, { harness: 'codex' });
		const issue = addIssue(t);
		const runId = addRun(t, { issueId: issue, runnerId, model: 'gpt-5.6' });
		t.sqlite
			.prepare(
				`UPDATE agent_run SET resolved_effort = 'low', effort_source = ?, effort_application_status = 'pending' WHERE id = ?`
			)
			.run(JSON.stringify({ kind: 'runner_tier', runner_id: runnerId, tier: 'balanced' }), runId);

		const { response } = await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			effects,
			{ owned_runs: [], instance_id: 'legacy-boot' },
			NOW + 1
		);
		expect(response.assignments).toEqual([]);
		expect(runById(t, runId)?.status).toBe('canceled');
		expect(runById(t, runId)?.error).toContain('not supported');
		expect(keyForRun(t, runId)).toBeUndefined();
		expect(effects.count()).toBe(1);
	});

	it('reclaims a legacy-tier claim after an effort-capable daemon upgrade', async () => {
		const t = world();
		const effects = recordDispatchEffects();
		const runnerId = addRunner(t, { harness: 'codex' });
		const issue = addIssue(t);
		const runId = addRun(t, { issueId: issue, runnerId, model: 'gpt-5.6' });
		t.sqlite
			.prepare(
				`UPDATE agent_run SET resolved_effort = 'low', effort_source = ?, effort_application_status = 'legacy_not_applied' WHERE id = ?`
			)
			.run(JSON.stringify({ kind: 'runner_tier', runner_id: runnerId, tier: 'balanced' }), runId);

		const { response } = await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			effects,
			{
				owned_runs: [],
				instance_id: 'upgraded-boot',
				effort_capabilities: {
					version: 1,
					daemon_version: '0.0.194',
					harness: 'codex',
					harness_version: '0.153.4',
					catalog_digest: 'catalog-a',
					models: [{ model: 'gpt-5.6', efforts: ['low'] }]
				}
			},
			NOW + 1
		);
		expect(response.assignments).toEqual([]);
		expect(runById(t, runId)?.status).toBe('canceled');
		expect(runById(t, runId)?.error).toContain('changed after claim');
		expect(keyForRun(t, runId)).toBeUndefined();
		expect(effects.count()).toBe(1);
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
			TEST_NOOP_DISPATCH_EFFECTS,
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
			TEST_NOOP_DISPATCH_EFFECTS,
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
			TEST_NOOP_DISPATCH_EFFECTS,
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
			TEST_NOOP_DISPATCH_EFFECTS,
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
		const effects = recordDispatchEffects();
		const { reconciled } = await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			effects,
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
		expect(effects.count()).toBe(2);
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
			TEST_NOOP_DISPATCH_EFFECTS,
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
			TEST_NOOP_DISPATCH_EFFECTS,
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
			TEST_NOOP_DISPATCH_EFFECTS,
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
			TEST_NOOP_DISPATCH_EFFECTS,
			runId,
			{ status: 'completed' },
			NOW + 30
		);
		expect(run.status).toBe('completed');
		expect(issueById(t, issue).attempt_count).toBe(1);
		const ended = eventsOfType(t, 'agent_run.ended');
		expect(ended[ended.length - 1].payload.outcome).toBe('stalled');
	});

	it('recovers the last effort milestone in the terminal CAS and freezes it', async () => {
		const t = world();
		const runnerId = addRunner(t);
		const issue = addIssue(t);
		const runId = await delivered(t, { runnerId, issueId: issue });
		t.sqlite
			.prepare(
				`UPDATE agent_run SET resolved_effort = 'high', effort_application_status = 'pending' WHERE id = ?`
			)
			.run(runId);
		const run = await finishRun(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			TEST_NOOP_DISPATCH_EFFECTS,
			runId,
			{
				status: 'completed',
				effort_application: {
					status: 'accepted_unconfirmed',
					transport: 'argv',
					attempted_effort: 'high'
				}
			},
			NOW + 30
		);
		expect(run.effort_application_status).toBe('accepted_unconfirmed');
		expect(run.effort_application_evidence).toMatchObject({
			milestones: [expect.objectContaining({ attempted_effort: 'high' })]
		});
		await expect(
			appendRunLog(t.db, t.env, await runnerRow(t, runnerId), runId, '', NOW + 40, undefined, {
				status: 'rejected',
				transport: 'argv',
				attempted_effort: 'high',
				reason: 'late request'
			})
		).rejects.toMatchObject({ code: 'run_already_ended' });
		expect(runById(t, runId)?.effort_application_status).toBe('accepted_unconfirmed');
	});

	it('atomically stores and emits a reproducible Codex estimate', async () => {
		const t = world();
		const runnerId = addRunner(t);
		const issue = addIssue(t);
		const runId = await delivered(t, { runnerId, issueId: issue });
		const claimed = Date.parse('2026-09-11T03:30:00Z');
		t.sqlite
			.prepare('UPDATE agent_run SET model = ?, created_at = ? WHERE id = ?')
			.run('gpt-5.6-sol', claimed, runId);
		await appendRunLog(t.db, t.env, await runnerRow(t, runnerId), runId, 'working\n', claimed + 1);
		const run = await finishRun(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			TEST_NOOP_DISPATCH_EFFECTS,
			runId,
			{
				status: 'completed',
				usage: {
					input_tokens: 80_000,
					cache_read_tokens: 210_000,
					cache_write_tokens: 10_000,
					output_tokens: 3_000
				},
				pricing_evidence: {
					version: 1,
					harness: 'codex',
					model: 'gpt-5.6-sol',
					identity_source: 'launch_argument',
					usage_scope: 'thread_total',
					session_mode: 'cold',
					normalization: 'codex-jsonl-v1',
					raw_usage: {
						input_tokens: 300_000,
						cached_input_tokens: 210_000,
						cache_write_input_tokens: 10_000,
						output_tokens: 3_000
					},
					model_rerouted: false,
					measurement_status: 'complete',
					terminal_snapshots: 1,
					daemon_version: '0.0.1',
					request_context: {
						version: 1,
						normalization: 'codex-rollout-delta-v1',
						harness_version: '0.153.4',
						status: 'complete',
						request_count: 2,
						max_request_input_tokens: 150_000,
						reconciled_usage: {
							input_tokens: 300_000,
							cached_input_tokens: 210_000,
							cache_write_input_tokens: 10_000,
							output_tokens: 3_000
						}
					}
				}
			},
			claimed + 2
		);
		expect(run.usage).toMatchObject({
			cost_usd: 0.514,
			cost_source: 'priced',
			pricing: {
				status: 'calculated',
				evidence: { request_context: { status: 'complete', request_count: 2 } },
				basis: { cost_usd_exact: '0.514' }
			}
		});
		const ended = eventsOfType(t, 'agent_run.ended').at(-1)!;
		expect(ended.payload.usage).toEqual(run.usage);
		const sameRunner = await runnerRow(t, runnerId);
		await expectFail(
			() =>
				finishRun(
					t.db,
					t.env,
					sameRunner,
					TEST_NOOP_DISPATCH_EFFECTS,
					runId,
					{ status: 'completed', usage: { cost_usd: 99, cost_source: 'provider' } },
					claimed + 3
				),
			'run_already_ended'
		);
		expect(JSON.parse(runById(t, runId)?.usage as string)).toEqual(run.usage);
	});

	it('accounts cold retry attempts independently and refuses a synthetic resumed total', async () => {
		const t = world();
		const runnerId = addRunner(t, { maxConcurrent: 3 });
		const issue = addIssue(t);
		const claimed = Date.parse('2026-09-11T03:30:00Z');
		const finish = (runId: string, total: number, resumed = false) => {
			const read = Math.floor(total / 2);
			const write = 0;
			const input = total - read;
			if (resumed)
				t.sqlite
					.prepare('UPDATE agent_run SET resumed_from_run_id = ? WHERE id = ?')
					.run(ids[0]!, runId);
			return finishRun(
				t.db,
				t.env,
				awaitRunner,
				TEST_NOOP_DISPATCH_EFFECTS,
				runId,
				{
					status: 'completed',
					usage: {
						input_tokens: input,
						cache_read_tokens: read,
						cache_write_tokens: write,
						output_tokens: 1
					},
					pricing_evidence: {
						version: 1,
						harness: 'codex',
						model: 'gpt-5.6-sol',
						identity_source: 'launch_argument',
						usage_scope: 'thread_total',
						session_mode: resumed ? 'resumed' : 'cold',
						normalization: 'codex-jsonl-v1',
						raw_usage: {
							input_tokens: total,
							cached_input_tokens: read,
							cache_write_input_tokens: write,
							output_tokens: 1
						},
						model_rerouted: false,
						measurement_status: 'complete',
						terminal_snapshots: 1
					}
				},
				claimed + total
			);
		};
		const awaitRunner = await runnerRow(t, runnerId);
		const ids = [10, 20, 30].map((total) =>
			addRun(t, {
				id: `arun_attempt_${total}`,
				issueId: issue,
				runnerId,
				status: 'running',
				model: 'gpt-5.6-sol',
				createdAt: claimed,
				startedAt: claimed
			})
		);

		const first = await finish(ids[0]!, 10);
		const retry = await finish(ids[1]!, 20);
		const resumed = await finish(ids[2]!, 30, true);
		expect(first.usage?.pricing).toMatchObject({ status: 'calculated' });
		expect(retry.usage?.pricing).toMatchObject({ status: 'calculated' });
		expect(first.usage?.cost_usd).not.toBe(retry.usage?.cost_usd);
		expect(resumed.usage?.pricing).toMatchObject({
			status: 'unpriced',
			reason: 'attempt_scope_unknown'
		});
		expect(eventsOfType(t, 'agent_run.ended')).toHaveLength(3);
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
			TEST_NOOP_DISPATCH_EFFECTS,
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
			TEST_NOOP_DISPATCH_EFFECTS,
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
			TEST_NOOP_DISPATCH_EFFECTS,
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
				TEST_NOOP_DISPATCH_EFFECTS,
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
				TEST_NOOP_DISPATCH_EFFECTS,
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
			TEST_NOOP_DISPATCH_EFFECTS,
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
				TEST_NOOP_DISPATCH_EFFECTS,
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
			TEST_NOOP_DISPATCH_EFFECTS,
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
			TEST_NOOP_DISPATCH_EFFECTS,
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
			TEST_NOOP_DISPATCH_EFFECTS,
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

	it('persists a local provider session id alongside token-only usage', async () => {
		const t = world();
		const runnerId = addRunner(t);
		const runId = await delivered(t, { runnerId, issueId: addIssue(t) });
		const session = 's'.repeat(255);
		const run = await finishRun(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			TEST_NOOP_DISPATCH_EFFECTS,
			runId,
			{
				status: 'completed',
				provider_session_id: session,
				usage: { input_tokens: 4, cache_read_tokens: 6, output_tokens: 1 }
			},
			NOW + 30
		);
		expect(run.provider_session_id).toBe(session);
		expect(run.usage).toEqual({
			input_tokens: 4,
			cache_read_tokens: 6,
			output_tokens: 1,
			pricing: {
				version: 1,
				evaluated_at: NOW + 30,
				status: 'unpriced',
				reason: 'pricing_evidence_missing'
			}
		});
	});

	it('an older daemon omitting accounting preserves fields already on the run', async () => {
		const t = world();
		const runnerId = addRunner(t);
		const runId = await delivered(t, { runnerId, issueId: addIssue(t) });
		t.sqlite
			.prepare('UPDATE agent_run SET provider_session_id = ?, usage = ? WHERE id = ?')
			.run('existing-session', '{"output_tokens":7}', runId);
		const run = await finishRun(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			TEST_NOOP_DISPATCH_EFFECTS,
			runId,
			{ status: 'completed' },
			NOW + 30
		);
		expect(run.provider_session_id).toBe('existing-session');
		expect(run.usage).toEqual({ output_tokens: 7 });
	});

	it('rejects malformed usage before mutating the run', async () => {
		const t = world();
		const runnerId = addRunner(t);
		const runId = await delivered(t, { runnerId, issueId: addIssue(t) });
		await expectFail(
			async () =>
				finishRun(
					t.db,
					t.env,
					await runnerRow(t, runnerId),
					TEST_NOOP_DISPATCH_EFFECTS,
					runId,
					{
						status: 'completed',
						provider_session_id: 'would-have-been-stored',
						usage: { input_tokens: -1 }
					} as never,
					NOW + 30
				),
			'invalid_field'
		);
		const unchanged = runById(t, runId);
		expect(unchanged?.status).toBe('launching');
		expect(unchanged?.provider_session_id).toBeNull();
		expect(unchanged?.usage).toBeNull();
	});

	it.each([null, '', '   ', 'bad\nvalue', 'x'.repeat(256), 42])(
		'rejects malformed provider session ids without mutating the run: %j',
		async (providerSessionId) => {
			const t = world();
			const runnerId = addRunner(t);
			const runId = await delivered(t, { runnerId, issueId: addIssue(t) });
			await expectFail(
				async () =>
					finishRun(
						t.db,
						t.env,
						await runnerRow(t, runnerId),
						TEST_NOOP_DISPATCH_EFFECTS,
						runId,
						{
							status: 'completed',
							provider_session_id: providerSessionId,
							usage: { output_tokens: 1 }
						} as never,
						NOW + 30
					),
				'invalid_field'
			);
			const unchanged = runById(t, runId);
			expect(unchanged?.status).toBe('launching');
			expect(unchanged?.provider_session_id).toBeNull();
			expect(unchanged?.usage).toBeNull();
		}
	);

	it('finishing a settled run 422s (the cancels path reports nothing)', async () => {
		const t = world();
		const runnerId = addRunner(t);
		const issue = addIssue(t);
		const runId = addRun(t, { issueId: issue, runnerId, status: 'canceled' });
		const row = await runnerRow(t, runnerId);
		await expectFail(
			() =>
				finishRun(
					t.db,
					t.env,
					row,
					TEST_NOOP_DISPATCH_EFFECTS,
					runId,
					{ status: 'completed' },
					NOW
				),
			'run_already_ended'
		);
	});
});

// ---------------------------------------------------------------------------

describe('pause and kill-switch cancels', () => {
	it('keeps the runner-write signal when the first pause cancellation fails', async () => {
		const t = world();
		const runnerId = addRunner(t);
		const runId = addRun(t, { issueId: addIssue(t), runnerId });
		const realBatch = t.env.DB.batch.bind(t.env.DB);
		let batches = 0;
		t.env.DB.batch = async (statements) => {
			batches += 1;
			if (batches === 2) throw new Error('injected first pause cancellation failure');
			return realBatch(statements);
		};
		const effects = recordDispatchEffects();

		await expect(
			updateRunner(t.db, t.env, actor, effects, runnerId, { status: 'paused' })
		).rejects.toThrow('injected first pause cancellation failure');

		expect(runnerById(t, runnerId).status).toBe('paused');
		expect(runById(t, runId)?.status).toBe('assigned');
		expect(eventsOfType(t, 'runner.updated')).toHaveLength(1);
		expect(effects.count()).toBe(1);
	});

	it('keeps a prior pause cancellation signal when a later cancellation fails', async () => {
		const t = world();
		const runnerId = addRunner(t, { maxConcurrent: 2 });
		const first = addRun(t, { issueId: addIssue(t), runnerId });
		const second = addRun(t, { issueId: addIssue(t), runnerId });
		const realBatch = t.env.DB.batch.bind(t.env.DB);
		let batches = 0;
		t.env.DB.batch = async (statements) => {
			batches += 1;
			// Runner = 1; first endRun flip/dependents = 2/3; fail the next flip.
			if (batches === 4) throw new Error('injected later pause cancellation failure');
			return realBatch(statements);
		};
		const effects = recordDispatchEffects();

		await expect(
			updateRunner(t.db, t.env, actor, effects, runnerId, { status: 'paused' })
		).rejects.toThrow('injected later pause cancellation failure');

		expect(runnerById(t, runnerId).status).toBe('paused');
		expect([runById(t, first)?.status, runById(t, second)?.status].sort()).toEqual([
			'assigned',
			'canceled'
		]);
		expect(eventsOfType(t, 'runner.updated')).toHaveLength(1);
		expect(eventsOfType(t, 'agent_run.ended')).toHaveLength(1);
		// The runner write and the independently committed cancellation both signal.
		expect(effects.count()).toBe(2);
	});

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
		const effects = recordDispatchEffects();
		await updateRunner(t.db, t.env, actor, effects, runnerId, {
			status: 'paused'
		});
		expect(runById(t, assigned)?.status).toBe('canceled');
		expect(runById(t, assigned)?.error).toBe('runner paused');
		expect(runById(t, running)?.status).toBe('running');
		// The runner write and each cancellation are distinct domain wins.
		expect(effects.count()).toBe(2);
	});

	it('keeps settings and prior cancellation signals when a later assigned cancellation fails', async () => {
		const t = world();
		const runnerId = addRunner(t, { maxConcurrent: 3 });
		const first = addRun(t, { issueId: addIssue(t), runnerId });
		const second = addRun(t, { issueId: addIssue(t), runnerId });
		const realBatch = t.env.DB.batch.bind(t.env.DB);
		let batches = 0;
		t.env.DB.batch = async (statements) => {
			batches += 1;
			// Settings = 1; first endRun flip/dependents = 2/3; fail the next flip.
			if (batches === 4) throw new Error('injected later settings cancellation failure');
			return realBatch(statements);
		};
		const effects = recordDispatchEffects();

		await expect(
			updateSupervisorSettings(t.db, t.env, actor, effects, { enabled: false })
		).rejects.toThrow('injected later settings cancellation failure');

		expect((await getSupervisorSettings(t.db, USER)).enabled).toBe(false);
		expect(eventsOfType(t, 'settings.updated')).toHaveLength(1);
		expect([runById(t, first)?.status, runById(t, second)?.status].sort()).toEqual([
			'assigned',
			'canceled'
		]);
		expect(effects.count()).toBe(2);
	});

	it('keeps the settings-write signal when the first assigned cancellation fails', async () => {
		const t = world();
		const runnerId = addRunner(t);
		const runId = addRun(t, { issueId: addIssue(t), runnerId });
		const realBatch = t.env.DB.batch.bind(t.env.DB);
		let batches = 0;
		t.env.DB.batch = async (statements) => {
			batches += 1;
			if (batches === 2) throw new Error('injected first settings cancellation failure');
			return realBatch(statements);
		};
		const effects = recordDispatchEffects();

		await expect(
			updateSupervisorSettings(t.db, t.env, actor, effects, { enabled: false })
		).rejects.toThrow('injected first settings cancellation failure');

		expect((await getSupervisorSettings(t.db, USER)).enabled).toBe(false);
		expect(runById(t, runId)?.status).toBe('assigned');
		expect(eventsOfType(t, 'settings.updated')).toHaveLength(1);
		expect(effects.count()).toBe(1);
	});

	it('keeps a direct in-flight cancellation signal when a later cancellation fails', async () => {
		const t = world();
		t.sqlite.prepare('UPDATE supervisor_settings SET enabled = 0 WHERE user_id = ?').run(USER);
		const runnerId = addRunner(t, { maxConcurrent: 2 });
		const first = addRun(t, {
			issueId: addIssue(t),
			runnerId,
			status: 'running',
			startedAt: NOW
		});
		const second = addRun(t, {
			issueId: addIssue(t),
			runnerId,
			status: 'running',
			startedAt: NOW
		});
		const realBatch = t.env.DB.batch.bind(t.env.DB);
		let batches = 0;
		t.env.DB.batch = async (statements) => {
			batches += 1;
			// First endRun flip/dependents = 1/2; fail the next run's flip.
			if (batches === 3) throw new Error('injected later in-flight cancellation failure');
			return realBatch(statements);
		};
		const effects = recordDispatchEffects();

		await expect(
			updateSupervisorSettings(t.db, t.env, actor, effects, {
				enabled: false,
				cancel_in_flight: true
			})
		).rejects.toThrow('injected later in-flight cancellation failure');

		expect((await getSupervisorSettings(t.db, USER)).enabled).toBe(false);
		expect(eventsOfType(t, 'settings.updated')).toHaveLength(0);
		expect([runById(t, first)?.status, runById(t, second)?.status].sort()).toEqual([
			'canceled',
			'running'
		]);
		expect(eventsOfType(t, 'agent_run.ended')).toHaveLength(1);
		// No settings write occurred, so this can only be the committed cancellation's signal.
		expect(effects.count()).toBe(1);
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

		const effects = recordDispatchEffects();
		const off = await updateSupervisorSettings(t.db, t.env, actor, effects, {
			enabled: false
		});
		expect(off.enabled).toBe(false);
		expect(off.canceled_runs).toBe(2);
		expect(runById(t, assignedA)?.status).toBe('canceled');
		expect(runById(t, assignedB)?.status).toBe('canceled');
		expect(runById(t, running)?.status).toBe('running');
		expect(effects.count()).toBe(3);

		// The bulk-cancel option: plain individual cancels, strikes and all.
		const bulk = await updateSupervisorSettings(t.db, t.env, actor, effects, {
			enabled: false,
			cancel_in_flight: true
		});
		expect(bulk.canceled_runs).toBe(1);
		expect(runById(t, running)?.status).toBe('canceled');
		expect(issueById(t, runningIssue).attempt_count).toBe(1);
		expect(effects.count()).toBe(4);
	});

	it('cancel_in_flight is rejected while enabling', async () => {
		const t = world();
		await expectFail(
			() =>
				updateSupervisorSettings(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, {
					enabled: true,
					cancel_in_flight: true
				}),
			'invalid_field'
		);
	});
});

// ---------------------------------------------------------------------------

describe('resume (retention and delivery)', () => {
	function resumeRunner(t: TestDb, opts: { windowHours?: number; maxTurns?: number } = {}) {
		const runnerId = addRunner(t);
		t.sqlite
			.prepare(
				'UPDATE runner SET resume_enabled = 1, resume_window_hours = ?, resume_max_turns = ? WHERE id = ?'
			)
			.run(opts.windowHours ?? 48, opts.maxTurns ?? 60, runnerId);
		return runnerId;
	}

	async function deliver(t: TestDb, runnerId: string, issueId: string, now = NOW + 1) {
		const runId = addRun(t, { issueId, runnerId });
		const { response } = await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			TEST_NOOP_DISPATCH_EFFECTS,
			{ owned_runs: [] },
			now
		);
		const assignment = response.assignments.find((a) => a.run.id === runId);
		if (!assignment) throw new Error(`run ${runId} was not delivered`);
		return { runId, assignment };
	}

	/** Ends a delivered run having advanced its issue into Human Review. */
	async function finishAdvanced(
		t: TestDb,
		runnerId: string,
		issueId: string,
		runId: string,
		body: Record<string, unknown> = {},
		to: string = REVIEW
	) {
		await appendRunLog(t.db, t.env, await runnerRow(t, runnerId), runId, 'working…\n', NOW + 10);
		const keyId = keyForRun(t, runId)?.id as string;
		addTransitionEvent(t, { issueId, apiKeyId: keyId, at: NOW + 20, to });
		t.sqlite.prepare('UPDATE issue SET state_id = ? WHERE id = ?').run(to, issueId);
		return finishRun(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			TEST_NOOP_DISPATCH_EFFECTS,
			runId,
			{
				status: 'completed',
				provider_session_id: 'sess-abc',
				workspace_path: '/tmp/ws/run1',
				turn_count: 12,
				conversation_turn_count: 12,
				...body
			} as Parameters<typeof finishRun>[5],
			NOW + 30
		);
	}

	function resources(t: TestDb) {
		return t.sqlite.prepare('SELECT * FROM run_resource').all() as Array<Record<string, unknown>>;
	}

	it('a run that advances its issue into an awaiting state retains its session and workspace', async () => {
		const t = world();
		const runnerId = resumeRunner(t);
		const issue = addIssue(t);
		const { runId } = await deliver(t, runnerId, issue);
		const run = await finishAdvanced(t, runnerId, issue, runId);

		expect(run.outcome).toBe('advanced');
		const rows = resources(t);
		expect(rows).toHaveLength(1);
		expect(rows[0]!).toMatchObject({
			kind: 'local_claude',
			state: 'available',
			owner_run_id: runId,
			issue_id: issue,
			runner_id: runnerId,
			provider_session_id: 'sess-abc',
			workspace_path: '/tmp/ws/run1',
			expires_at: NOW + 30 + 48 * 60 * 60 * 1000
		});
		// The run row is what the daemon reads to hold the workspace.
		expect(runById(t, runId)!.resume_expires_at).toBe(NOW + 30 + 48 * 60 * 60 * 1000);
		expect(runById(t, runId)!.turn_count).toBe(12);
		expect(runById(t, runId)!.workspace_path).toBe('/tmp/ws/run1');
	});

	it('retains nothing for a stalled run, an active end state, or an opted-out runner', async () => {
		// Stalled: no transition at all, so the run never advanced.
		const t = world();
		const runnerId = resumeRunner(t);
		const stalledIssue = addIssue(t);
		const stalled = await deliver(t, runnerId, stalledIssue);
		await finishRun(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			TEST_NOOP_DISPATCH_EFFECTS,
			stalled.runId,
			{
				status: 'completed',
				provider_session_id: 'sess-stalled',
				workspace_path: '/tmp/ws/stalled'
			} as Parameters<typeof finishRun>[5],
			NOW + 30
		);
		expect(resources(t)).toHaveLength(0);

		// Advanced, but into an active state: there is no human gap to resume across.
		const activeIssue = addIssue(t);
		const active = await deliver(t, runnerId, activeIssue);
		await finishAdvanced(t, runnerId, activeIssue, active.runId, {}, OPEN);
		expect(resources(t)).toHaveLength(0);

		// Advanced into awaiting, but the runner is not opted in.
		const offIssue = addIssue(t);
		const offRunner = addRunner(t, { name: 'no-resume' });
		const offRun = addRun(t, { issueId: offIssue, runnerId: offRunner });
		await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, offRunner),
			TEST_NOOP_DISPATCH_EFFECTS,
			{ owned_runs: [] },
			NOW + 1
		);
		await finishAdvanced(t, offRunner, offIssue, offRun);
		expect(resources(t)).toHaveLength(0);
	});

	it('retains nothing when a human, not the run, moved the issue into the awaiting state', async () => {
		// The end state is awaiting_human either way; what differs is who
		// authored the transition. Only a run that handed the work back has a
		// conversation worth continuing — one a human closed out around has
		// no idea it happened.
		const t = world();
		const runnerId = resumeRunner(t);
		const issue = addIssue(t);
		const { runId } = await deliver(t, runnerId, issue);
		// A human moves it; the run itself never transitions anything.
		addTransitionEvent(t, { issueId: issue, apiKeyId: null, at: NOW + 20, to: REVIEW });
		t.sqlite.prepare('UPDATE issue SET state_id = ? WHERE id = ?').run(REVIEW, issue);
		const run = await finishRun(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			TEST_NOOP_DISPATCH_EFFECTS,
			runId,
			{
				status: 'completed',
				provider_session_id: 'sess-abc',
				workspace_path: '/tmp/ws/run1'
			} as Parameters<typeof finishRun>[5],
			NOW + 30
		);
		expect(run.outcome).not.toBe('advanced');
		expect(resources(t)).toHaveLength(0);
	});

	it('a rate-limited finish is held to its reset, never counted as an interruption', async () => {
		// `endRun` takes a rate-limited finish as `interrupted`, so the arms
		// below it stay one chain rather than two `if`s. Splitting them is a
		// behavioural no-op today — `noteInterruption` returns early while a
		// backoff window is live — which is exactly why the outcome deserves
		// an assertion of its own: this is what must stay true if that guard
		// ever moves.
		const t = world();
		const runnerId = resumeRunner(t);
		const issue = addIssue(t);
		const { runId } = await deliver(t, runnerId, issue);
		await finishRun(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			TEST_NOOP_DISPATCH_EFFECTS,
			runId,
			{
				status: 'failed',
				error: 'usage limit reached',
				judgment: 'rate_limited',
				resume_at: NOW + 60 * 60 * 1000
			} as Parameters<typeof finishRun>[5],
			NOW + 30
		);
		const runner = await runnerRow(t, runnerId);
		expect(runner.launch_failures).toBe(0);
		expect(runner.backoff_until).toBeGreaterThanOrEqual(NOW + 60 * 60 * 1000);
	});

	it('a send-back on the same runner is delivered as a resume with the reduced prompt', async () => {
		const t = world();
		const runnerId = resumeRunner(t);
		const issue = addIssue(t);
		const first = await deliver(t, runnerId, issue);
		const coldPrompt = first.assignment.prompt;
		await finishAdvanced(t, runnerId, issue, first.runId);
		// The send-back itself: a human moves the issue back into an active
		// state, which is what makes it dispatchable again.
		t.sqlite.prepare('UPDATE issue SET state_id = ? WHERE id = ?').run(OPEN, issue);

		const second = await deliver(t, runnerId, issue, NOW + 40);
		expect(second.assignment.resume).toEqual({
			previous_run_id: first.runId,
			provider_session_id: 'sess-abc',
			workspace_path: '/tmp/ws/run1',
			prior_turn_count: 12
		});
		// The continuation, not the cold launch prompt.
		expect(second.assignment.prompt).toContain('# Supervisor run (resumed)');
		expect(second.assignment.prompt).toContain(`It continues run ${first.runId}`);
		expect(coldPrompt).toContain('# Supervisor run\n');
		expect(second.assignment.prompt.length).toBeLessThan(coldPrompt.length);

		const row = runById(t, second.runId)!;
		expect(row.resumed_from_run_id).toBe(first.runId);
		// Lineage only: this run's own workspace is not what was retained, so
		// it must not tell the daemon to keep it.
		expect(row.resume_expires_at).toBeNull();
		expect(row.workspace_path).toBe('/tmp/ws/run1');
		// The resource is claimed, so a GC sweep cannot take it underneath.
		expect(resources(t)[0]!.state).toBe('claimed');
		expect(resources(t)[0]!.claim_run_id).toBe(second.runId);
	});

	it('launches fresh outside the window, recording why', async () => {
		const t = world();
		const runnerId = resumeRunner(t, { windowHours: 1 });
		const issue = addIssue(t);
		const first = await deliver(t, runnerId, issue);
		await finishAdvanced(t, runnerId, issue, first.runId);
		// The window has closed by the time the send-back arrives.
		t.sqlite.prepare('UPDATE run_resource SET expires_at = ?').run(NOW + 30 + 60 * 60 * 1000);
		t.sqlite.prepare('UPDATE issue SET state_id = ? WHERE id = ?').run(OPEN, issue);

		const runId = addRun(t, { issueId: issue, runnerId });
		const { response } = await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			TEST_NOOP_DISPATCH_EFFECTS,
			{ owned_runs: [] },
			NOW + 30 + 2 * 60 * 60 * 1000
		);
		const assignment = response.assignments.find((a) => a.run.id === runId);
		expect(assignment?.resume).toBeUndefined();
		expect(assignment!.prompt).toContain('# Supervisor run\n');
		expect(runById(t, runId)!.resume_fallback_reason).toBe('expired');
		expect(runById(t, runId)!.resumed_from_run_id).toBeNull();
	});

	it('launches fresh when the previous conversation is already long', async () => {
		const t = world();
		const runnerId = resumeRunner(t, { maxTurns: 10 });
		const issue = addIssue(t);
		const first = await deliver(t, runnerId, issue);
		await finishAdvanced(t, runnerId, issue, first.runId, { conversation_turn_count: 40 });
		t.sqlite.prepare('UPDATE issue SET state_id = ? WHERE id = ?').run(OPEN, issue);

		const runId = addRun(t, { issueId: issue, runnerId });
		const { response } = await pollRunner(
			t.db,
			t.env,
			await runnerRow(t, runnerId),
			TEST_NOOP_DISPATCH_EFFECTS,
			{ owned_runs: [] },
			NOW + 40
		);
		const assignment = response.assignments.find((a) => a.run.id === runId);
		expect(assignment?.resume).toBeUndefined();
		expect(runById(t, runId)!.resume_fallback_reason).toBe('long_context');
		// Declining leaves the resource claimable for a later, smaller send-back.
		expect(resources(t)[0]!.state).toBe('available');
	});
});
