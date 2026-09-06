import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_BIN, NODE } from './test-bin.js';

/**
 * The handoff sections of `issues show` and the awaiting-human `issues list`
 * table, driven through the real bin against a stub API. Neither is reachable
 * from a worker-side test: the round is derived there, but the decision of
 * *which half to print* — and the columns — live only in the CLI.
 */

const HUMAN = { user_id: 'u1', user_name: 'Tom Buckley', api_key_id: null, api_key_name: null };
const AGENT = { user_id: 'u1', user_name: 'Tom Buckley', api_key_id: 'ak_1', api_key_name: 'run' };
// Ages are rendered against the wall clock in the child process, so the
// fixture's timestamps are offsets from now rather than fixed instants.
const NOW = Date.now();

const ROUND = {
	boundary: {
		action: 'Send back to implementation',
		from_state: { id: 's_hr', name: 'Human Review' },
		to_state: { id: 's_impl', name: 'Implementation' },
		actor: HUMAN,
		at: NOW - 7_200_000
	},
	boundary_at: NOW - 7_200_000,
	stages: [
		{
			state: { id: 's_impl', name: 'Implementation', position: 3 },
			runs: [
				{
					run_id: 'arun_late',
					runner_name: 'macbook',
					status: 'completed',
					outcome: 'advanced',
					started_at: NOW - 3_600_000,
					ended_at: NOW - 3_000_000,
					usage: null,
					transition: {
						action: 'Submit for automated review',
						from_state: { id: 's_impl', name: 'Implementation' },
						to_state: { id: 's_ar', name: 'Automated Review' },
						actor: AGENT,
						at: NOW - 3_000_000
					},
					summary_comment: { id: 'cmt_sum', body: 'Implementation — landed it.', created_at: NOW },
					earlier_comment_ids: [],
					artifacts: [
						{
							name: 'impl-pr',
							artifact_type: 'pr',
							from_version: null,
							to_version: 1,
							pr_url: 'https://github.com/tbuckley/tines/pull/129',
							files: null
						}
					],
					returned_via: null
				}
			]
		}
	],
	run_count: 1
};

const SINCE = {
	previous_run: {
		run_id: 'arun_prev',
		ended_at: NOW - 7_200_000,
		state_at_start_name: 'Human Review'
	},
	transition: {
		action: 'Send back to implementation',
		from_state: { id: 's_hr', name: 'Human Review' },
		to_state: { id: 's_impl', name: 'Implementation' },
		actor: HUMAN,
		at: NOW - 3_600_000
	},
	comments: [
		{
			id: 'cmt_h',
			issue_id: 'iss_1',
			body: 'CI is red on the e2e job.',
			actor: HUMAN,
			created_at: NOW - 3_500_000,
			updated_at: null
		}
	],
	comment_count: 1,
	stale_artifacts: ['impl-pr']
};

/** An IssueDetail, shaped as far as printIssueDetail reads it. */
function detail(over: Record<string, unknown>): Record<string, unknown> {
	return {
		id: 'iss_1',
		project_name: 'Stub',
		project_archived_at: null,
		number: 7,
		title: 'Ship the handoff',
		description: 'Do it well.',
		labels: [],
		links: { blocked_by: [], blocks: [], duplicated_by: [] },
		duplicate_of: null,
		workflow: { id: 'wf_1', name: 'Engineering' },
		state: { id: 's_impl', name: 'Implementation', category: 'active' },
		effective_state: { id: 's_impl', name: 'Implementation', category: 'active' },
		allowed_transitions: [],
		comments: [],
		updated_at: NOW,
		round: null,
		since_last_run: null,
		...over
	};
}

/** One awaiting-human list row, as the swapped table reads it. */
function awaitingRow(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'iss_1',
		project_name: 'Stub',
		number: 7,
		title: 'Ship the handoff',
		effective_state: { name: 'Human Review', category: 'awaiting_human' },
		state_entered_at: Date.now() - 2 * 86_400_000,
		arrived_via: {
			action: 'Automated review passed',
			from_state_name: 'Automated Review',
			by_run: true,
			at: Date.now() - 2 * 86_400_000
		},
		round_summary: {
			pr_url: 'https://github.com/tbuckley/tines/pull/129',
			artifacts: [{ name: 'review-notes', artifact_type: 'text', version: 2 }]
		},
		last_activity_at: 0,
		open_blockers: [],
		labels: [],
		duplicate_of: null,
		...over
	};
}

let server: Server;
let baseUrl: string;
/** What `issues show` answers with next; the list rows are fixed. */
let nextDetail: Record<string, unknown> = detail({});

beforeAll(async () => {
	server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		res.writeHead(200, { 'content-type': 'application/json' });
		// `issues show <ref>` resolves the project by name first, then reads the
		// issue by number; `issues list` reads the collection.
		if (url.pathname.endsWith('/projects')) {
			res.end(JSON.stringify({ items: [{ id: 'prj_1', name: 'Stub' }], next_cursor: null }));
			return;
		}
		if (/\/issues\/\d+$/.test(url.pathname)) {
			res.end(JSON.stringify(nextDetail));
			return;
		}
		res.end(JSON.stringify({ items: [awaitingRow()], next_cursor: null }));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** Runs the built CLI against the stub; never rejects. */
function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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

describe('issues show', () => {
	it('prints the round for an awaiting-human issue, and not the steer', async () => {
		nextDetail = detail({
			state: { id: 's_hr', name: 'Human Review', category: 'awaiting_human' },
			effective_state: { id: 's_hr', name: 'Human Review', category: 'awaiting_human' },
			round: ROUND,
			since_last_run: SINCE
		});
		const { code, stdout, stderr } = await cli(['issues', 'show', 'Stub/7']);
		expect(stderr).toBe('');
		expect(code).toBe(0);
		expect(stdout).toContain('round (1 run since Tom Buckley moved "Send back to implementation"');
		expect(stdout).toContain('Implementation — arun_late on macbook');
		expect(stdout).toContain('impl-pr v1 (https://github.com/tbuckley/tines/pull/129)');
		expect(stdout).toContain('summary (cmt_sum):');
		// The reader of an awaiting issue is judging what came back, not being
		// steered — the other half stays out even when the payload carries it.
		expect(stdout).not.toContain('since the last run');
	});

	it('prints the steer for an active issue, and not the round', async () => {
		nextDetail = detail({ round: ROUND, since_last_run: SINCE });
		const { stdout } = await cli(['issues', 'show', 'Stub/7']);
		expect(stdout).toContain('since the last run (Human Review, arun_prev ended 2h ago):');
		expect(stdout).toContain('moved from Human Review via "Send back to implementation"');
		expect(stdout).toContain('CI is red on the e2e job.');
		expect(stdout).not.toContain('round (');
	});

	it('prints neither section when the payload carries neither', async () => {
		nextDetail = detail({});
		const { stdout } = await cli(['issues', 'show', 'Stub/7']);
		expect(stdout).toContain('Ship the handoff');
		expect(stdout).not.toContain('since the last run');
		expect(stdout).not.toContain('round (');
	});

	// An older worker sends no handoff fields at all; the renderer must not
	// invent a section (or crash) on their absence.
	it('survives a payload from a worker that knows nothing of the handoff', async () => {
		const bare = detail({});
		delete bare.round;
		delete bare.since_last_run;
		nextDetail = bare;
		const { code, stdout } = await cli(['issues', 'show', 'Stub/7']);
		expect(code).toBe(0);
		expect(stdout).not.toContain('since the last run');
	});
});

describe('issues list --category awaiting_human', () => {
	it('swaps in the waiting, via and round columns', async () => {
		const { code, stdout } = await cli(['issues', 'list', '-c', 'awaiting_human']);
		expect(code).toBe(0);
		expect(stdout).toContain('WAITING');
		expect(stdout).toContain('VIA');
		expect(stdout).toContain('ROUND');
		expect(stdout).toContain('2d');
		expect(stdout).toContain('Automated review passed');
		expect(stdout).toContain('PR 129 · review-notes v2');
	});

	it('leaves every other listing on the standard table', async () => {
		const { stdout } = await cli(['issues', 'list']);
		expect(stdout).toContain('CATEGORY');
		expect(stdout).not.toContain('WAITING');
		expect(stdout).not.toContain('PR 129');
	});
});
