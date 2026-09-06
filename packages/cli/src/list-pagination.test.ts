import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_BIN, NODE } from './test-bin.js';

/** Every list command reachable through withList(), and the route it pages. */
const LIST_COMMANDS: { argv: string[]; path: string }[] = [
	{ argv: ['projects', 'list'], path: '/api/v1/projects' },
	{ argv: ['workflows', 'list'], path: '/api/v1/workflows' },
	{ argv: ['issues', 'list'], path: '/api/v1/issues' },
	{ argv: ['context', 'list'], path: '/api/v1/context' },
	{ argv: ['schedules', 'list'], path: '/api/v1/schedules' },
	{ argv: ['runs', 'list'], path: '/api/v1/runs' },
	{ argv: ['events', 'list'], path: '/api/v1/events' }
];

const TOTAL = 120;
const PAGE = 50;

/**
 * The names the CLI's own lookups search for, parked on the last page (offset
 * >= 100) so a first-page-only fetch cannot find them.
 */
const LATE_CONTEXT_NAMES: Record<number, string> = { 110: 'agent-guidelines', 115: 'journal' };

/**
 * A row is `{id}` plus just enough shape for the renderers and name lookups
 * that read it: the issue fields `issues list`'s table prints, a `name` for the
 * project/schedule/context resolvers, and `states` for `--state <wf>/<state>`.
 * --json prints the envelope verbatim, so nothing else is ever read.
 */
function row(path: string, n: number): Record<string, unknown> {
	let name = `item${n}`;
	if (path === '/api/v1/projects') name = `proj${n}`;
	if (path === '/api/v1/context') name = LATE_CONTEXT_NAMES[n] ?? name;
	return {
		id: `x${n}`,
		name,
		issue_count: 0,
		created_at: 0,
		project_name: 'Stub',
		number: n,
		title: `issue ${n}`,
		effective_state: { name: 'Backlog', category: 'active' },
		last_activity_at: 0,
		open_blockers: [],
		labels: [],
		duplicate_of: null,
		kind: 'prompt',
		version: 1,
		scope: { label: 'global' },
		updated_at: 0,
		states: [{ id: `s${n}`, name: 'Backlog' }],
		// `supervisor status` prints a runner table in text mode, and a cell it
		// cannot stringify crashes the formatter rather than reading empty.
		type: 'local',
		status: 'active',
		active_runs: 0,
		max_concurrent: 1
	};
}

/**
 * The non-list routes the internal-lookup pins pass through on their way to a
 * paged one. Shaped only as far as the code under test reads them.
 */
const FIXED_ROUTES: Record<string, unknown> = {
	// resolveIssue('proj0/1'), for `journal show`.
	'/api/v1/projects/x0/issues/1': {
		id: 'i1',
		project_id: 'x0',
		project_name: 'proj0',
		number: 1,
		state: { id: 's0', name: 'Backlog' },
		workflow: { id: 'x0', name: 'item0' }
	},
	// `supervisor status` reads these before it prints; only its run walk is under test.
	'/api/v1/supervisor/settings': {
		enabled: true,
		quota: { type: 'state_roster', default_limit: 2, overrides: {} },
		attempt_limit: 3
	},
	'/api/v1/supervisor/queue': {
		generated_at: 0,
		automation_enabled: true,
		quota: { type: 'state_roster', default_limit: 2, overrides: {} },
		groups: [
			{
				state_id: 's0',
				state_name: 'Backlog',
				workflow_id: 'x0',
				workflow_name: 'item0',
				verdict: 'offline',
				detail: 'the daemon has not polled recently',
				runner_id: 'rnr_1',
				runner_name: 'macbook',
				rule_id: 'rul_1',
				ambiguous_rule_ids: [],
				binding: null,
				count: 2,
				oldest_entered_at: 0,
				issues: []
			},
			{
				state_id: 's1',
				state_name: 'Design',
				workflow_id: 'x0',
				workflow_name: 'item0',
				verdict: 'at_capacity',
				detail: 'at max_concurrent (3/3)',
				runner_id: 'rnr_1',
				runner_name: 'macbook',
				rule_id: 'rul_1',
				ambiguous_rule_ids: [],
				binding: {
					kind: 'max_concurrent',
					runner_id: 'rnr_1',
					runner_name: 'macbook',
					current: 3,
					limit: 3
				},
				count: 1,
				oldest_entered_at: 0,
				issues: []
			}
		],
		waiting: 3,
		parked: { count: 0, oldest_entered_at: null, issues: [] },
		awaiting_human: { count: 4, oldest_entered_at: 0 }
	}
};

let server: Server;
let baseUrl: string;
/** Every path the CLI requested, so the wiring pin can prove which route it paged. */
const requested: string[] = [];
/** Every non-GET the CLI made, so a lookup can be shown to have found rather than created. */
const writes: string[] = [];

/**
 * A stand-in API that pages any list route by offset. Deliberately not the real
 * worker: this pins the CLI's cursor-following and the wiring of each list
 * action, both of which are the CLI's own, and CI never runs the e2e suite.
 */
beforeAll(async () => {
	server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		requested.push(url.pathname);
		if (req.method !== 'GET') writes.push(`${req.method} ${url.pathname}`);
		const fixed = FIXED_ROUTES[url.pathname];
		// A single context item, fetched by id once a name lookup has found it.
		const contextItem = /^\/api\/v1\/context\/(x\d+)$/.exec(url.pathname);
		if (fixed || contextItem) {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(
				JSON.stringify(
					fixed ?? {
						...row('/api/v1/context', Number(contextItem![1].slice(1))),
						body: '- a lesson'
					}
				)
			);
			return;
		}
		const offset = Number(url.searchParams.get('cursor') ?? '0');
		const limit = Math.min(Number(url.searchParams.get('limit') ?? PAGE), PAGE);
		const end = Math.min(offset + limit, TOTAL);
		const items = Array.from({ length: end - offset }, (_, i) => row(url.pathname, offset + i));
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ items, next_cursor: end < TOTAL ? String(end) : null }));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Runs the built CLI against the stub; never rejects, so exit codes can be asserted. */
function cli(args: string[]): Promise<CliResult> {
	return new Promise((resolve) => {
		const child = execFile(
			NODE,
			[CLI_BIN, ...args],
			{ env: { ...process.env, TINES_API_URL: baseUrl, TINES_API_KEY: 'k' }, timeout: 60_000 },
			(err, stdout, stderr) => {
				const code = (err as { code?: number } | null)?.code ?? 0;
				resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr });
			}
		);
		child.stdin?.end();
	});
}

describe('list pagination', () => {
	// The bug this flag exists for: agents run `issues list --json` and treat
	// the result as the complete set. Without --all-pages they get one page.
	it('fetches every page under --all-pages, and only one without it', async () => {
		const all = await cli(['issues', 'list', '--all', '--all-pages', '--json']);
		expect(all.code).toBe(0);
		const parsed = JSON.parse(all.stdout);
		expect(parsed.items).toHaveLength(TOTAL);
		expect(parsed.next_cursor).toBeNull();
		expect(parsed.items[0].id).toBe('x0');
		expect(parsed.items[TOTAL - 1].id).toBe(`x${TOTAL - 1}`);

		const one = await cli(['issues', 'list', '--all', '--json']);
		expect(one.code).toBe(0);
		const first = JSON.parse(one.stdout);
		expect(first.items).toHaveLength(PAGE);
		expect(first.next_cursor).toBe(String(PAGE));
		// The warning goes to stderr so stdout stays parseable.
		expect(one.stderr).toContain('--all-pages');
	}, 60_000);

	it('rejects --all-pages with --cursor', async () => {
		const res = await cli(['issues', 'list', '--all-pages', '--cursor', 'abc', '--json']);
		expect(res.code).not.toBe(0);
		expect(res.stderr).toContain("cannot be used with option '--cursor");
	}, 60_000);

	it('keeps --limit meaning page size under --all-pages', async () => {
		const res = await cli(['issues', 'list', '--all-pages', '--limit', '10', '--json']);
		expect(JSON.parse(res.stdout).items).toHaveLength(TOTAL);
	}, 60_000);

	it('mentions --all-pages in the table-mode hint', async () => {
		const res = await cli(['issues', 'list', '--all']);
		expect(res.stdout).toContain('--all-pages');
	}, 60_000);

	// The internal lookups have no flag to opt in: `resolveSchedule` used to ask
	// for one page of 100 and report "no schedule" for anything after it.
	it('finds a name only present on a later page when resolving a reference', async () => {
		const res = await cli(['schedules', 'show', `proj0/item${TOTAL - 1}`, '--json']);
		expect(res.stderr).toBe('');
		expect(JSON.parse(res.stdout).id).toBe(`x${TOTAL - 1}`);
	}, 60_000);

	// The other three internal lookups, each of which used to ask for one page
	// of 100 and act on it as if it were the whole list.
	it('finds the existing agent-guidelines prompt on a later page instead of recreating it', async () => {
		writes.length = 0;
		const res = await cli(['context', 'init', '--json']);
		expect(res.code).toBe(0);
		expect(JSON.parse(res.stdout).name).toBe('agent-guidelines');
		expect(writes).toEqual([]);
	}, 60_000);

	it('finds the journal item on a later page', async () => {
		const res = await cli(['journal', 'show', 'proj0/1', '--state', 'item0/Backlog', '--json']);
		expect(res.stderr).toBe('');
		expect(JSON.parse(res.stdout).name).toBe('journal');
	}, 60_000);

	it('counts every active run, not just the first page, in supervisor status', async () => {
		requested.length = 0;
		const res = await cli(['supervisor', 'status', '--json']);
		expect(res.code).toBe(0);
		expect(JSON.parse(res.stdout).active_runs).toHaveLength(TOTAL);
		expect(requested.filter((p) => p === '/api/v1/runs')).toHaveLength(3);
	}, 60_000);

	// The Now row travels with the status read (Tines/256), in both modes.
	it('carries the fleet queue in supervisor status --json', async () => {
		const res = await cli(['supervisor', 'status', '--json']);
		expect(res.code).toBe(0);
		const parsed = JSON.parse(res.stdout);
		expect(parsed.queue.waiting).toBe(3);
		expect(parsed.queue.groups.map((g: { verdict: string }) => g.verdict)).toEqual([
			'offline',
			'at_capacity'
		]);
	}, 60_000);

	it('prints the waiting groups, each with its fix, in text mode', async () => {
		const res = await cli(['supervisor', 'status']);
		expect(res.stderr).toBe('');
		expect(res.code).toBe(0);
		expect(res.stdout).toContain('waiting: 3 issues');
		// Grouped per (verdict, runner), the state named by the workflow map.
		expect(res.stdout).toContain('macbook offline: item0/Backlog 2 (oldest');
		expect(res.stdout).toContain('fix: start the daemon on that machine — tines runner daemon');
		// The state is named by the workflow map, not by the group's own copy.
		expect(res.stdout).toContain('at capacity on macbook (3/3): item1/Backlog 1 (oldest');
		expect(res.stdout).toContain('parked: none');
		expect(res.stdout).toContain('awaiting you: 4 issues');
	}, 60_000);

	// Wiring pin: the flag is added once in withList(), but each action has to
	// route through fetchList() to honour it. Reverting any single call site
	// silently reintroduces the truncation, so pin all seven by behaviour.
	it('honours --all-pages on every list command', async () => {
		requested.length = 0;
		const results = await Promise.all(
			LIST_COMMANDS.map(async ({ argv }) => {
				const res = await cli([...argv, '--all-pages', '--json']);
				return [argv.join(' '), res.code, JSON.parse(res.stdout || '{}').items?.length] as const;
			})
		);
		expect(results).toEqual(LIST_COMMANDS.map(({ argv }) => [argv.join(' '), 0, TOTAL]));
		// ...by walking its own route: 120 items at 50 per page is three requests each.
		for (const { argv, path } of LIST_COMMANDS) {
			expect(
				requested.filter((p) => p === path),
				argv.join(' ')
			).toHaveLength(3);
		}
	}, 120_000);
});
