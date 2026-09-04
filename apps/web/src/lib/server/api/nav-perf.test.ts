/**
 * NAVIGATION COST PROBE (Tines/32) — a measurement tool, not a behavioural
 * test. Excluded from `pnpm test`; run it with `pnpm --filter web perf:nav`.
 *
 * Runs the real route `load` functions against the migration-backed in-memory
 * DB, with every D1 statement wrapped in an artificial fixed latency. Because
 * the latency dominates, wall-clock / latency ≈ the number of *sequential*
 * round-trip waves on the critical path — the thing that actually sets
 * navigation time on a Worker talking to D1.
 */
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConcurrentD1Dialect } from '$lib/server/db';
import { createTestDb, instrumentLatency, type TestDb } from './test-db';
import {
	addIssue,
	addRunner,
	seedBase,
	setSettings,
	USER,
	PROJECT,
	OPEN
} from '../supervisor/test-fixtures';

const LATENCY_MS = 20;
// Reproduce the pre-Tines/32 baseline: force Kysely's connection mutex back on
// (`NAVPERF_SERIALIZE=1`), which is what kysely-d1's stock SqliteAdapter did
// before ConcurrentD1Dialect. Off by default, i.e. the default run measures
// the code as shipped.
const SERIALIZE = process.env.NAVPERF_SERIALIZE === '1';
// vitest 4 swallows console.log from these files, so the report is appended to
// a file the runner prints afterwards (see the `perf:nav` script).
const OUT = process.env.NAVPERF_OUT ?? '/tmp/navperf.txt';
const report = (s: string) => appendFileSync(OUT, s + '\n');
const depends = () => {};

const instrument = (t: TestDb) => instrumentLatency(t, LATENCY_MS);

function seed(t: TestDb) {
	seedBase(t);
	setSettings(t);
	addRunner(t);
	const id = addIssue(t, { id: 'iss_probe', state: OPEN, title: 'Probe issue' });
	const number = (t.all('SELECT number FROM issue WHERE id = ?', id)[0] as any).number as number;
	// A little ambient volume so list queries aren't degenerate.
	for (let i = 0; i < 20; i++) addIssue(t);
	for (let i = 0; i < 30; i++) {
		t.sqlite
			.prepare(
				`INSERT INTO comment (id, issue_id, body, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?)`
			)
			.run(`cmt_${i}`, id, 'hello world', USER, 1_723_000_000_000 + i);
		t.sqlite
			.prepare(
				`INSERT INTO event (id, user_id, type, actor_user_id, issue_id, project_id, payload, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(`evt_${i}`, USER, 'issue.commented', USER, id, PROJECT, '{}', 1_723_000_000_000 + i);
	}
	return { number };
}

async function measure(name: string, run: (env: Env) => Promise<unknown>) {
	const t = createTestDb();
	const { number } = seed(t);
	const { env, sqls, conc } = instrument(t);
	const started = performance.now();
	await run(env);
	const elapsed = performance.now() - started;
	const waves = elapsed / LATENCY_MS;
	report(
		`\n${name}\n  queries: ${sqls.length}\n  sequential waves (critical path): ~${waves.toFixed(1)}\n  modelled time @${LATENCY_MS}ms/query: ${elapsed.toFixed(0)}ms\n  peak concurrent queries: ${conc.max}`
	);
	return { queries: sqls.length, waves, number, sqls };
}

const user = { id: USER, name: 'alice', email: 'a@example.com' };

if (SERIALIZE) {
	// Patch the adapter ConcurrentD1Dialect actually hands Kysely, so the run
	// reproduces the stock kysely-d1 behaviour byte for byte.
	const adapterProto = Object.getPrototypeOf(
		new ConcurrentD1Dialect({ database: null as never }).createAdapter()
	);
	Object.defineProperty(adapterProto, 'supportsMultipleConnections', {
		get: () => false,
		configurable: true
	});
}

describe(`navigation cost probe (${SERIALIZE ? 'serialized baseline' : 'as shipped'})`, () => {
	it('issues list', async () => {
		const { load } = await import('../../../routes/(app)/issues/+page.server');
		const r = await measure('/issues', (env) =>
			(load as any)({
				locals: { user },
				platform: { env },
				depends,
				url: new URL('http://x/issues')
			})
		);
		expect(r.queries).toBeGreaterThan(0);
	});

	it('issue detail', async () => {
		const t = createTestDb();
		const { number } = seed(t);
		const { env, sqls, conc } = instrument(t);
		const { load } = await import('../../../routes/(app)/issues/[project]/[number]/+page.server');
		const started = performance.now();
		const result = await (load as any)({
			locals: { user },
			platform: { env },
			depends,
			params: { project: 'demo', number: String(number) },
			url: new URL(`http://x/issues/demo/${number}`)
		});
		// What blocks first paint: `load` has resolved, so SvelteKit can render
		// and the View Transition can commit. The streamed panels are still in
		// flight at this point.
		const elapsed = performance.now() - started;
		const awaitedQueries = sqls.length;
		const { deferred, ...eager } = result as Record<string, unknown>;
		const settled = await Promise.all(Object.values(deferred as Record<string, Promise<unknown>>));
		const fullElapsed = performance.now() - started;
		report(
			`\n/issues/[project]/[number]\n  queries: ${awaitedQueries} blocking, ${sqls.length} total\n  sequential waves (critical path): ~${(elapsed / LATENCY_MS).toFixed(1)} to first paint, ~${(fullElapsed / LATENCY_MS).toFixed(1)} to fully settled\n  modelled time @${LATENCY_MS}ms/query: ${elapsed.toFixed(0)}ms to first paint, ${fullElapsed.toFixed(0)}ms settled\n  peak concurrent queries: ${conc.max}\n  serialized payload: ${JSON.stringify(eager).length} bytes blocking, ${JSON.stringify({ ...eager, deferred: settled }).length} bytes total`
		);
		const counts = new Map<string, number>();
		for (const s of sqls) counts.set(s, (counts.get(s) ?? 0) + 1);
		const dupes = [...counts.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
		report(
			`  duplicated statements: ${dupes.length} distinct, ${dupes.reduce((a, [, n]) => a + n - 1, 0)} redundant executions`
		);
		for (const [sql, n] of dupes.slice(0, 8))
			report(`    ${n}x  ${sql.slice(0, 110).replace(/\s+/g, ' ')}`);
		expect(sqls.length).toBeGreaterThan(0);
	});

	it('projects', async () => {
		const { load } = await import('../../../routes/(app)/projects/+page.server');
		await measure('/projects', (env) =>
			(load as any)({ locals: { user }, platform: { env }, depends })
		);
	});

	it('activity', async () => {
		const { load } = await import('../../../routes/(app)/activity/+page.server');
		await measure('/activity', (env) =>
			(load as any)({
				locals: { user },
				platform: { env },
				depends,
				url: new URL('http://x/activity')
			})
		);
	});

	it('agents', async () => {
		const { load } = await import('../../../routes/(app)/agents/+page.server');
		await measure('/agents', (env) =>
			(load as any)({
				locals: { user },
				platform: { env },
				depends,
				url: new URL('http://x/agents')
			})
		);
	});

	it('context', async () => {
		const { load } = await import('../../../routes/(app)/context/+page.server');
		await measure('/context', (env) =>
			(load as any)({
				locals: { user },
				platform: { env },
				depends,
				url: new URL('http://x/context')
			})
		);
	});
});
