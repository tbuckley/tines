/**
 * The CLI half of the issue-transition precondition (Tines/608 Part D),
 * against a stub API: that `issues move --expect-revision` sends the caller's
 * decision revision with the transition id and state from this command's read,
 * that without the flag the request is unchanged, that `issues show` prints
 * the revision to pass, and that a refusal says how to recover.
 */
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const tsx = join(here, '..', 'node_modules', '.bin', 'tsx');
const entry = join(here, 'index.ts');

const project = { id: 'prj_1', name: 'demo', shared_at: null, archived_at: null };
const open = { id: 'wfs_open', name: 'Open', category: 'active', position: 0 };
const review = { id: 'wfs_review', name: 'Review', category: 'awaiting_human', position: 1 };
const issue = {
	id: 'iss_1',
	project_id: project.id,
	project_name: project.name,
	project_archived_at: null,
	number: 1,
	title: 'Pinned',
	description: '',
	workflow_id: 'wf_1',
	workflow: { id: 'wf_1', name: 'Standard' },
	state: open,
	effective_state: open,
	duplicate_of: null,
	open_blockers: [],
	labels: [],
	attempt_count: 0,
	needs_attention: false,
	active_run: null,
	decision_revision: 6,
	workflow_revision: 2,
	comments: [],
	links: { blocked_by: [], blocks: [], duplicate_of: null, duplicated_by: [] },
	allowed_transitions: [{ transition_id: 'wft_submit', name: 'Submit', to_state: review }],
	context_summary: {},
	created_at: 0,
	updated_at: 0,
	last_activity_at: 0,
	state_entered_at: 0
};

let server: Server;
let baseUrl: string;
const writes: { path: string; body: Record<string, unknown> }[] = [];
/** When set, the next transition answers with this 409 instead of succeeding. */
let refusal: Record<string, unknown> | null = null;

beforeAll(async () => {
	server = createServer((req, res) => {
		const path = new URL(req.url ?? '/', 'http://localhost').pathname;
		const send = (status: number, body: unknown) => {
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(body));
		};
		if (req.method === 'GET') {
			if (path === '/api/v1/projects') return send(200, { items: [project], next_cursor: null });
			if (path === '/api/v1/projects/prj_1') return send(200, project);
			if (path === '/api/v1/projects/prj_1/issues/1') return send(200, issue);
			return send(404, { error: { code: 'not_found', message: 'no' } });
		}
		let raw = '';
		req.on('data', (chunk) => (raw += chunk));
		req.on('end', () => {
			writes.push({ path, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
			if (!path.endsWith('/transition'))
				return send(404, { error: { code: 'not_found', message: 'no' } });
			if (refusal)
				return send(409, {
					error: {
						code: 'decision_refresh_required',
						message:
							'The issue or its workflow changed after you read it; refresh and choose again',
						details: refusal
					}
				});
			send(200, { ...issue, state: review, effective_state: review, decision_revision: 7 });
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
	writes.length = 0;
	refusal = null;
});

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = execFile(
			tsx,
			[entry, ...args],
			{ env: { ...process.env, TINES_API_URL: baseUrl, TINES_API_KEY: 'k' }, timeout: 60_000 },
			(err, stdout, stderr) => {
				const code = (err as { code?: number } | null)?.code ?? 0;
				resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr });
			}
		);
		child.stdin?.end();
	});
}

describe('tines issues show', () => {
	it('prints the decision revision to pass to --expect-revision', async () => {
		const res = await cli(['issues', 'show', 'demo/1']);
		expect(res.stderr).toBe('');
		expect(res.code).toBe(0);
		expect(res.stdout.split('\n')).toContain('decision revision: 6');
	}, 60_000);
});

describe('tines issues move --expect-revision', () => {
	it('sends the flag with the transition id and state from its read', async () => {
		const res = await cli(['issues', 'move', 'demo/1', 'submit', '--expect-revision', '6']);
		expect(res.stderr).toBe('');
		expect(res.code).toBe(0);
		expect(writes).toEqual([
			{
				path: '/api/v1/issues/iss_1/transition',
				body: {
					transition_id: 'wft_submit',
					expected_state_id: 'wfs_open',
					expected_decision_revision: 6
				}
			}
		]);
	}, 60_000);

	it('accepts revision 0 and never fills the revision from its own read', async () => {
		const res = await cli(['issues', 'move', 'demo/1', 'Submit', '--expect-revision', '0']);
		expect(res.code).toBe(0);
		expect(writes[0].body.expected_decision_revision).toBe(0);
	}, 60_000);

	it('leaves the request unchanged without the flag', async () => {
		const res = await cli(['issues', 'move', 'demo/1', 'Submit']);
		expect(res.stderr).toBe('');
		expect(res.code).toBe(0);
		expect(writes).toEqual([
			{ path: '/api/v1/issues/iss_1/transition', body: { action: 'Submit' } }
		]);
	}, 60_000);

	it('rejects a value that is not a non-negative integer before any request', async () => {
		const res = await cli(['issues', 'move', 'demo/1', 'Submit', '--expect-revision', '-1']);
		expect(res.code).not.toBe(0);
		expect(writes).toEqual([]);
	}, 60_000);

	it('says how to recover from a refusal', async () => {
		refusal = { committed: false, reason: 'issue_moved', current_decision_revision: 8 };
		const res = await cli(['issues', 'move', 'demo/1', 'Submit', '--expect-revision', '6']);
		expect(res.code).not.toBe(0);
		expect(res.stderr).toContain('(decision_refresh_required)');
		expect(res.stderr).toContain('tines issues show demo/1');
		expect(res.stderr).toContain('--expect-revision 8');
	}, 60_000);
});
