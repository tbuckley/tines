/**
 * NAVIGATION COST PROBE (Tines/32) — a measurement tool, not a behavioural
 * test. Excluded from `pnpm test`; run it with `pnpm --filter web perf:nav`,
 * which CI also runs (Tines/416). That gate covers that every page's `load`
 * still *executes* against a real event, that the issue-detail page issues no
 * duplicated statement, and that no page awaits more sequential waves than
 * its `WAVE_BUDGET`. Waves are counted (see `instrumentLatency`), so they are
 * exact on any machine; milliseconds are reported but never gated.
 *
 * Runs the real route `load` functions against the migration-backed in-memory
 * DB, with every D1 statement wrapped in an artificial fixed latency. Because
 * the latency dominates, wall-clock / latency ≈ the number of *sequential*
 * round-trip waves on the critical path — the thing that actually sets
 * navigation time on a Worker talking to D1.
 */
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Project } from '@tines/shared';
import { ConcurrentD1Dialect } from '$lib/server/db';
import { createTestDb, instrumentLatency, type TestDb } from './test-db';
import type { LayoutServerData } from '../../../routes/(app)/$types';
import {
	addIssue,
	addRunner,
	seedBase,
	setSettings,
	NOW,
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

const AMBIENT_ISSUES = 20;

function seed(t: TestDb) {
	t.env.BETTER_AUTH_SECRET = 'navigation-probe-secret';
	seedBase(t);
	setSettings(t);
	addRunner(t);
	const id = addIssue(t, { id: 'iss_probe', state: OPEN, title: 'Probe issue' });
	const number = (t.all('SELECT number FROM issue WHERE id = ?', id)[0] as any).number as number;
	// A little ambient volume so list queries aren't degenerate.
	for (let i = 0; i < AMBIENT_ISSUES; i++) addIssue(t);
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

/** The seeded user, shaped as `locals.user` (better-auth's `User`). */
const user = {
	id: USER,
	name: 'alice',
	email: 'a@example.com',
	emailVerified: true,
	createdAt: new Date(NOW),
	updatedAt: new Date(NOW)
};

/** The one project `seedBase` inserts, as `listProjects` would return it. */
const SEEDED_PROJECT: Project = {
	id: PROJECT,
	name: 'demo',
	description: '',
	default_workflow_id: null,
	created_at: NOW,
	updated_at: NOW,
	// The probe issue plus the ambient ones. Counted from the seed constants
	// rather than queried, so the stub costs no statement in any measurement.
	issue_count: 1 + AMBIENT_ISSUES,
	archived_at: null
};

/**
 * What `parent()` resolves to for a child of `(app)/+layout.server.ts`, typed
 * against that layout's actual output so a chrome contract change fails here
 * rather than at runtime inside a loader. Static on purpose: the layout's own
 * queries are not part of a page's number (see docs/PERFORMANCE.md), and
 * `focus: null` keeps /agents on its single runs query, which is what the
 * pre-`parent()` measurements recorded.
 */
const layoutData: LayoutServerData = {
	user,
	disclosureAcknowledged: false,
	sharedProjects: [],
	archivedSharedProjects: [],
	projects: [SEEDED_PROJECT],
	archivedProjects: [],
	focus: null,
	lastProjectId: null
};

type ProbeEvent = {
	locals: { user: typeof user };
	platform: { env: Env };
	params: Record<string, string>;
	url: URL;
	depends: typeof depends;
	parent: () => Promise<LayoutServerData>;
};

/**
 * One event shape for every page, so the next `load` signature change breaks
 * one place instead of six (Tines/416).
 */
const event = (env: Env, path: string, params: Record<string, string> = {}): ProbeEvent => ({
	locals: { user },
	platform: { env },
	params,
	url: new URL(`http://x${path}`),
	depends,
	parent: async () => layoutData
});

const callLoad = (load: unknown, input: ProbeEvent) =>
	(load as (event: ProbeEvent) => Promise<unknown>)(input);

/**
 * Sequential D1 round trips each page's `load` may await before it resolves
 * (for the issue page: before first paint; its streamed panels are not
 * counted). Counted, not timed, so the numbers are exact on any machine; a
 * page over budget fails the probe and CI. Lower a budget when a change
 * earns it; raising one needs a reason in docs/PERFORMANCE.md.
 */
const WAVE_BUDGET: Record<string, number> = {
	'/issues': 3,
	'/issues/[project]/[number]': 4,
	'/issues/[project]/[number] by name': 4,
	'/projects': 2,
	'/activity': 3,
	'/agents': 2,
	'/context': 3
};

function reportWaves(bySql: { sql: string; wave: number }[], upTo: number) {
	for (let wave = 1; wave <= upTo; wave++)
		for (const { sql } of bySql.filter((q) => q.wave === wave))
			report(`    w${wave}  ${sql.slice(0, 100).replace(/\s+/g, ' ')}`);
}

async function measure(name: string, run: (env: Env, number: number) => Promise<unknown>) {
	const t = createTestDb();
	const { number } = seed(t);
	const { env, sqls, conc, waves } = instrument(t);
	const started = performance.now();
	await run(env, number);
	const elapsed = performance.now() - started;
	report(
		`\n${name}\n  queries: ${sqls.length}\n  sequential waves (critical path): ${waves.max} (budget ${WAVE_BUDGET[name]})\n  modelled time @${LATENCY_MS}ms/query: ${elapsed.toFixed(0)}ms\n  peak concurrent queries: ${conc.max}`
	);
	if (waves.max > WAVE_BUDGET[name]) reportWaves(waves.bySql, waves.max);
	return { queries: sqls.length, waves: waves.max, number, sqls };
}

function expectWithinBudget(name: string, waves: number) {
	expect(waves, `${name}: sequential D1 waves over budget (see report)`).toBeLessThanOrEqual(
		WAVE_BUDGET[name]
	);
}

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
		const r = await measure('/issues', (env) => callLoad(load, event(env, '/issues')));
		expect(r.queries).toBeGreaterThan(0);
		expectWithinBudget('/issues', r.waves);
	});

	it('issue detail', async () => {
		const t = createTestDb();
		const { number } = seed(t);
		const { env, sqls, conc, waves } = instrument(t);
		const { load } = await import('../../../routes/(app)/issues/[project]/[number]/+page.server');
		const started = performance.now();
		const result = await callLoad(
			load,
			event(env, `/issues/${PROJECT}/${number}`, { project: PROJECT, number: String(number) })
		);
		// What blocks first paint: `load` has resolved, so SvelteKit can render
		// and the View Transition can commit. The streamed panels are still in
		// flight at this point.
		const elapsed = performance.now() - started;
		const awaitedQueries = sqls.length;
		const paintWaves = waves.max;
		const { deferred, ...eager } = result as Record<string, unknown>;
		const settled = await Promise.all(Object.values(deferred as Record<string, Promise<unknown>>));
		const fullElapsed = performance.now() - started;
		report(
			`\n/issues/[project]/[number]\n  queries: ${awaitedQueries} blocking, ${sqls.length} total\n  sequential waves (critical path): ${paintWaves} to first paint (budget ${WAVE_BUDGET['/issues/[project]/[number]']}), ${waves.max} to fully settled\n  modelled time @${LATENCY_MS}ms/query: ${elapsed.toFixed(0)}ms to first paint, ${fullElapsed.toFixed(0)}ms settled\n  peak concurrent queries: ${conc.max}\n  serialized payload: ${JSON.stringify(eager).length} bytes blocking, ${JSON.stringify({ ...eager, deferred: settled }).length} bytes total`
		);
		reportWaves(waves.bySql, waves.max);
		const counts = new Map<string, number>();
		for (const s of sqls) counts.set(s, (counts.get(s) ?? 0) + 1);
		const dupes = [...counts.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
		report(
			`  duplicated statements: ${dupes.length} distinct, ${dupes.reduce((a, [, n]) => a + n - 1, 0)} redundant executions`
		);
		for (const [sql, n] of dupes.slice(0, 8))
			report(`    ${n}x  ${sql.slice(0, 110).replace(/\s+/g, ' ')}`);
		expect(sqls.length).toBeGreaterThan(0);
		// The rule docs/PERFORMANCE.md states: the same statement twice in one
		// navigation is a missing shared promise. Reported above, so a failure
		// names the offenders.
		expect(dupes).toEqual([]);
		expectWithinBudget('/issues/[project]/[number]', paintWaves);
	});

	it('issue detail, addressed by project name as lists link it', async () => {
		const { load } = await import('../../../routes/(app)/issues/[project]/[number]/+page.server');
		// Resolved by name in the same statement as the id, so a list click
		// pays nothing extra; measured separately because most clicks take it.
		const r = await measure('/issues/[project]/[number] by name', (env, number) =>
			callLoad(load, {
				...event(env, `/issues/${SEEDED_PROJECT.name}/${number}`, {
					project: SEEDED_PROJECT.name,
					number: String(number)
				}),
				isDataRequest: true
			} as ProbeEvent)
		);
		expectWithinBudget('/issues/[project]/[number] by name', r.waves);
	});

	it('projects', async () => {
		const { load } = await import('../../../routes/(app)/projects/+page.server');
		const r = await measure('/projects', (env) => callLoad(load, event(env, '/projects')));
		expectWithinBudget('/projects', r.waves);
	});

	it('activity', async () => {
		const { load } = await import('../../../routes/(app)/activity/+page.server');
		const r = await measure('/activity', (env) => callLoad(load, event(env, '/activity')));
		expectWithinBudget('/activity', r.waves);
	});

	it('agents', async () => {
		const { load } = await import('../../../routes/(app)/agents/+page.server');
		const r = await measure('/agents', (env) => callLoad(load, event(env, '/agents')));
		expectWithinBudget('/agents', r.waves);
	});

	it('context', async () => {
		const { load } = await import('../../../routes/(app)/context/+page.server');
		const r = await measure('/context', (env) => callLoad(load, event(env, '/context')));
		expectWithinBudget('/context', r.waves);
	});
});
