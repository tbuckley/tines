/**
 * The sweep's managed-run poll arm: log/usage/cursor application, per-run
 * token caps, provider-reported ends, and the per-runner housekeeping hook —
 * all against the fake adapter (the Claude adapter's own tests cover the
 * provider request shapes).
 */
import { describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../api/test-db';
import { pollManagedRuns, sweepSupervisor } from './engine';
import { createFakeAdapter, type FakeAdapter } from './fake-adapter';
import {
	addIssue,
	addRun,
	addRunner,
	NOW,
	runById,
	seedBase,
	setSettings,
	USER
} from './test-fixtures';

function world(runnerOpts: Parameters<typeof addRunner>[1] = {}): {
	t: TestDb;
	fake: FakeAdapter;
	runId: string;
} {
	const t = createTestDb();
	seedBase(t);
	setSettings(t);
	const runnerId = addRunner(t, { id: 'rnr_m', ...runnerOpts });
	const issueId = addIssue(t, {});
	const runId = addRun(t, {
		issueId,
		runnerId,
		status: 'running',
		providerSessionId: 'sesn_1',
		providerMeta: JSON.stringify({ vault_id: 'vlt_1' }),
		startedAt: NOW,
		log: 'earlier\n'
	});
	return { t, fake: createFakeAdapter(), runId };
}

describe('pollManagedRuns', () => {
	it('appends the log chunk, replaces usage, and advances provider_meta', async () => {
		const { t, fake, runId } = world();
		fake.nextPoll({
			logChunk: '[agent] hello\n',
			usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.5, cost_source: 'provider' },
			provider_meta: JSON.stringify({ vault_id: 'vlt_1', events_cursor: 'c1' })
		});
		await pollManagedRuns(t.db, t.env, NOW + 1000, { local: fake });

		expect(fake.polls).toHaveLength(1);
		expect(fake.polls[0]).toMatchObject({ id: runId, provider_session_id: 'sesn_1' });
		const run = runById(t, runId)!;
		expect(run.status).toBe('running');
		expect(run.log).toBe('earlier\n[agent] hello\n');
		expect(JSON.parse(run.usage as string)).toMatchObject({
			cost_usd: 0.5,
			cost_source: 'provider'
		});
		expect(JSON.parse(run.provider_meta as string)).toMatchObject({ events_cursor: 'c1' });
	});

	it('ends the run with the ordinary judgment when the provider reports it ended', async () => {
		const { t, fake, runId } = world();
		fake.nextPoll({ status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } });
		await pollManagedRuns(t.db, t.env, NOW + 1000, { local: fake });
		const run = runById(t, runId)!;
		// No transition authored by the run's key: completed, but judged a strike.
		expect(run.status).toBe('completed');
		expect(run.ended_at).toBe(NOW + 1000);
	});

	it('enforces the per-run dollar cap from table-priced usage the provider cannot stop at', async () => {
		const { t, fake, runId } = world({ budget: { max_run_cost_usd: 2 } });
		fake.nextPoll({
			usage: { input_tokens: 1000, output_tokens: 500, cost_usd: 2.5, cost_source: 'priced' }
		});
		await pollManagedRuns(t.db, t.env, NOW + 1000, { local: fake });
		const run = runById(t, runId)!;
		expect(run.status).toBe('failed');
		expect(run.error).toMatch(/max_run_cost_usd \(\$2\)/);
		expect(fake.cancels).toHaveLength(1);
		// The poll passes the resolved model along, for table-priced adapters.
		expect(fake.polls[0]).toMatchObject({ id: runId, model: 'claude-sonnet-5' });
	});

	it('leaves a run under its dollar cap alone', async () => {
		const { t, fake, runId } = world({ budget: { max_run_cost_usd: 2 } });
		fake.nextPoll({ usage: { input_tokens: 10, output_tokens: 5, cost_usd: 1.99 } });
		await pollManagedRuns(t.db, t.env, NOW + 1000, { local: fake });
		expect(runById(t, runId)!.status).toBe('running');
		expect(fake.cancels).toHaveLength(0);
	});

	it('enforces the per-run token cap by cancelling and failing the run', async () => {
		const { t, fake, runId } = world({ budget: { max_run_tokens: 100 } });
		fake.nextPoll({ usage: { input_tokens: 90, output_tokens: 20, cost_source: 'provider' } });
		await pollManagedRuns(t.db, t.env, NOW + 1000, { local: fake });
		const run = runById(t, runId)!;
		expect(run.status).toBe('failed');
		expect(run.error).toContain('max_run_tokens');
		expect(fake.cancels).toHaveLength(1);
	});

	it('leaves a run under its token cap running', async () => {
		const { t, fake, runId } = world({ budget: { max_run_tokens: 1000 } });
		fake.nextPoll({ usage: { input_tokens: 90, output_tokens: 20, cost_source: 'provider' } });
		await pollManagedRuns(t.db, t.env, NOW + 1000, { local: fake });
		expect(runById(t, runId)!.status).toBe('running');
		expect(fake.cancels).toHaveLength(0);
	});

	it('a throwing poll skips the run and touches nothing', async () => {
		const { t, fake, runId } = world();
		fake.poll = () => Promise.reject(new Error('provider down'));
		await pollManagedRuns(t.db, t.env, NOW + 1000, { local: fake });
		const run = runById(t, runId)!;
		expect(run.status).toBe('running');
		expect(run.log).toBe('earlier\n');
	});
});

describe('sweep housekeeping hook', () => {
	it('calls sweepRunner once per runner whose adapter has one', async () => {
		const { t, fake } = world();
		const swept: string[] = [];
		fake.sweepRunner = (runner) => {
			swept.push(runner.id);
			return Promise.resolve();
		};
		await sweepSupervisor(t.db, t.env, NOW + 1000, { local: fake });
		expect(swept).toEqual(['rnr_m']);
	});

	it('a throwing sweepRunner does not break the sweep', async () => {
		const { t, fake, runId } = world();
		fake.sweepRunner = () => Promise.reject(new Error('boom'));
		fake.nextPoll({ status: 'completed' });
		await sweepSupervisor(t.db, t.env, NOW + 1000, { local: fake });
		// The poll arm still ran and settled the run.
		expect(runById(t, runId)!.status).toBe('completed');
		expect(t.all('SELECT * FROM agent_run WHERE user_id = ?', USER)).toHaveLength(1);
	});
});
