import { describe, expect, it } from 'vitest';
import { ApiFail, type ActorContext } from './core';
import { deleteRunner, planRunnerRemoval, requireTier, runnerOnline, type RunnerRemovalRefs } from './runners';
import { createTestDb, type TestDb } from './test-db';

const runner = { id: 'rnr_1', name: 'laptop-m4' };

const noRefs: RunnerRemovalRefs = { activeRuns: 0, rules: [], pins: [] };
const refs: RunnerRemovalRefs = {
	activeRuns: 0,
	rules: [
		{
			id: 'rul_1',
			label: 'global',
			targets: [{ runner_id: 'rnr_1' }, { runner_id: 'rnr_2', tier: 'cheapest' }]
		},
		{ id: 'rul_2', label: 'project acme', targets: [{ runner_id: 'rnr_1', tier: 'smartest' }] }
	],
	pins: [{ issue_id: 'iss_1', project_id: 'prj_1', ref: 'demo/12' }]
};

describe('planRunnerRemoval', () => {
	it('removes an unreferenced runner without force', () => {
		expect(planRunnerRemoval(runner, noRefs, false)).toEqual({ ruleUpdates: [], pinClears: [] });
	});

	it('always refuses while runs are active — force is about references, not live work', () => {
		for (const force of [false, true]) {
			try {
				planRunnerRemoval(runner, { ...refs, activeRuns: 2 }, force);
				throw new Error('expected a 422');
			} catch (e) {
				expect(e).toBeInstanceOf(ApiFail);
				expect((e as ApiFail).code).toBe('runner_busy');
				expect((e as ApiFail).message).toContain('2 active runs');
			}
		}
	});

	it('rejects by default, naming the referencing rules and pins', () => {
		try {
			planRunnerRemoval(runner, refs, false);
			throw new Error('expected a 422');
		} catch (e) {
			expect(e).toBeInstanceOf(ApiFail);
			const fail = e as ApiFail;
			expect(fail.code).toBe('runner_referenced');
			expect(fail.message).toContain('project acme');
			expect(fail.message).toContain('demo/12');
			expect(fail.details).toMatchObject({
				rules: [
					{ rule_id: 'rul_1', label: 'global' },
					{ rule_id: 'rul_2', label: 'project acme' }
				],
				pins: [{ issue_id: 'iss_1', ref: 'demo/12' }]
			});
		}
	});

	it('force strips targets and clears pins, flagging (not deleting) emptied rules', () => {
		const plan = planRunnerRemoval(runner, refs, true);
		expect(plan.ruleUpdates).toEqual([
			{
				id: 'rul_1',
				label: 'global',
				targets: [{ runner_id: 'rnr_2', tier: 'cheapest' }],
				emptied: false
			},
			{ id: 'rul_2', label: 'project acme', targets: [], emptied: true }
		]);
		expect(plan.pinClears).toEqual(refs.pins);
	});
});

describe('requireTier', () => {
	it('accepts exactly the closed set', () => {
		expect(requireTier('smartest', 't')).toBe('smartest');
		expect(requireTier('balanced', 't')).toBe('balanced');
		expect(requireTier('cheapest', 't')).toBe('cheapest');
	});

	it('rejects anything else with the allowed set in the details', () => {
		try {
			requireTier('opus', 'pinned_tier');
			throw new Error('expected a 422');
		} catch (e) {
			expect(e).toBeInstanceOf(ApiFail);
			expect((e as ApiFail).code).toBe('unknown_tier');
			expect((e as ApiFail).details?.allowed_tiers).toEqual(['smartest', 'balanced', 'cheapest']);
		}
	});
});

describe('runnerOnline', () => {
	const now = 1_723_000_000_000;

	it('managed runners are always online', () => {
		expect(runnerOnline({ type: 'claude_managed', last_seen_at: null }, now)).toBe(true);
	});

	it('local runners are online only while the daemon polled within the window', () => {
		expect(runnerOnline({ type: 'local', last_seen_at: null }, now)).toBe(false);
		expect(runnerOnline({ type: 'local', last_seen_at: now - 60_000 }, now)).toBe(true);
		expect(runnerOnline({ type: 'local', last_seen_at: now - 3 * 60_000 }, now)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// deleteRunner against a real SQLite with the actual migrations and foreign
// keys ON — the batch order (rule strips, pin clears, api_key provenance
// null-out, run deletes, runner delete) must hold up for real, not in mocks.

const actor: ActorContext = {
	userId: 'u1',
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

const NOW = 1_723_000_000_000;

function seedRemovalFixture(t: TestDb) {
	t.sqlite.exec(`
		INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
			VALUES ('u1', 'alice', 'a@example.com', 1, ${NOW}, ${NOW});
		INSERT INTO runner (id, user_id, type, name, config, created_at, updated_at) VALUES
			('rnr_1', 'u1', 'local', 'laptop-m4', '{}', ${NOW}, ${NOW}),
			('rnr_2', 'u1', 'local', 'desktop', '{}', ${NOW}, ${NOW});
		INSERT INTO project (id, user_id, name, created_at, updated_at)
			VALUES ('prj_1', 'u1', 'demo', ${NOW}, ${NOW});
		INSERT INTO issue (id, project_id, number, title, workflow_id, state_id, pinned_runner_id, pinned_tier, created_at, updated_at)
			VALUES ('iss_1', 'prj_1', 12, 'Fix it', 'wf_standard', 'wfs_std_open', 'rnr_1', 'smartest', ${NOW}, ${NOW});
		INSERT INTO routing_rule (id, user_id, project_id, workflow_state_id, targets, created_at, updated_at) VALUES
			('rul_1', 'u1', NULL, NULL, '[{"runner_id":"rnr_1"},{"runner_id":"rnr_2","tier":"cheapest"}]', ${NOW}, ${NOW}),
			('rul_2', 'u1', 'prj_1', NULL, '[{"runner_id":"rnr_1","tier":"smartest"}]', ${NOW}, ${NOW});
		INSERT INTO agent_run (id, user_id, issue_id, runner_id, status, tier, state_id_at_start, created_at)
			VALUES ('arun_1', 'u1', 'iss_1', 'rnr_1', 'completed', 'balanced', 'wfs_std_open', ${NOW});
		INSERT INTO api_key (id, user_id, name, key_hash, key_prefix, agent_run_id, expires_at, created_at)
			VALUES ('key_1', 'u1', 'run key', 'hash', 'tines_run', 'arun_1', ${NOW}, ${NOW});
	`);
}

describe('deleteRunner (db batch)', () => {
	it('force cascade lands in one batch with no FK failure', async () => {
		const t = createTestDb();
		seedRemovalFixture(t);

		await deleteRunner(t.db, t.env, actor, 'rnr_1', true);

		// Runner gone; the other survives.
		expect(t.all(`SELECT id FROM runner`).map((r) => r.id)).toEqual(['rnr_2']);
		// Its runs are gone, and the run key kept its row but lost provenance.
		expect(t.all(`SELECT id FROM agent_run WHERE runner_id = 'rnr_1'`)).toEqual([]);
		expect(t.all(`SELECT agent_run_id FROM api_key WHERE id = 'key_1'`)).toEqual([
			{ agent_run_id: null }
		]);
		// Pin cleared (tier too).
		expect(t.all(`SELECT pinned_runner_id, pinned_tier FROM issue WHERE id = 'iss_1'`)).toEqual([
			{ pinned_runner_id: null, pinned_tier: null }
		]);
		// Targets stripped; the emptied rule is kept, flagged by its empty list.
		const targets = Object.fromEntries(
			t.all(`SELECT id, targets FROM routing_rule`).map((r) => [r.id, JSON.parse(r.targets as string)])
		);
		expect(targets).toEqual({
			rul_1: [{ runner_id: 'rnr_2', tier: 'cheapest' }],
			rul_2: []
		});
		// Every cascade step recorded its event.
		const types = t.all(`SELECT type FROM event ORDER BY id`).map((r) => r.type);
		expect(types.filter((x) => x === 'routing_rule.updated')).toHaveLength(2);
		expect(types).toContain('issue.updated');
		expect(types).toContain('runner.removed');
	});

	it('refuses without force, and the db is untouched', async () => {
		const t = createTestDb();
		seedRemovalFixture(t);
		await expect(deleteRunner(t.db, t.env, actor, 'rnr_1', false)).rejects.toMatchObject({
			code: 'runner_referenced',
			// The referenced rules are named with the canonical scope label.
			details: {
				rules: [
					{ rule_id: 'rul_1', label: 'global' },
					{ rule_id: 'rul_2', label: 'project demo' }
				]
			}
		});
		expect(t.all(`SELECT id FROM runner`)).toHaveLength(2);
		expect(t.all(`SELECT pinned_runner_id FROM issue WHERE id = 'iss_1'`)).toEqual([
			{ pinned_runner_id: 'rnr_1' }
		]);
	});

	it('a run going active between the guard read and the batch no-ops everything (TOCTOU)', async () => {
		const t = createTestDb();
		seedRemovalFixture(t);
		// Simulate the race: the active run appears after deleteRunner's
		// pre-check read but before its batch executes.
		const d1 = (t.env as unknown as { DB: { batch: (s: unknown[]) => Promise<unknown[]> } }).DB;
		const realBatch = d1.batch.bind(d1);
		d1.batch = async (statements) => {
			t.sqlite.exec(`
				INSERT INTO agent_run (id, user_id, issue_id, runner_id, status, tier, state_id_at_start, created_at)
					VALUES ('arun_2', 'u1', 'iss_1', 'rnr_1', 'running', 'balanced', 'wfs_std_open', ${NOW + 1})
			`);
			return realBatch(statements);
		};

		await expect(deleteRunner(t.db, t.env, actor, 'rnr_1', true)).rejects.toMatchObject({
			code: 'runner_busy'
		});
		// The in-batch guards made every statement a no-op: nothing stripped,
		// nothing deleted, no events recorded.
		expect(t.all(`SELECT id FROM runner`).map((r) => r.id).sort()).toEqual(['rnr_1', 'rnr_2']);
		expect(t.all(`SELECT pinned_runner_id FROM issue WHERE id = 'iss_1'`)).toEqual([
			{ pinned_runner_id: 'rnr_1' }
		]);
		expect(
			JSON.parse(t.all(`SELECT targets FROM routing_rule WHERE id = 'rul_2'`)[0].targets as string)
		).toEqual([{ runner_id: 'rnr_1', tier: 'smartest' }]);
		expect(t.all(`SELECT agent_run_id FROM api_key WHERE id = 'key_1'`)).toEqual([
			{ agent_run_id: 'arun_1' }
		]);
		expect(t.all(`SELECT type FROM event`)).toEqual([]);
	});
});
