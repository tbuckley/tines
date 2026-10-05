/**
 * The CLI half of the workflow save precondition (Tines/608), against a stub
 * API: that `workflows edit --expect-revision` reaches the PATCH body and wins
 * over the JSON body's own value, that the CLI never supplies a revision the
 * caller did not, that `workflows show` prints the revision to pass, and that
 * a `workflow_conflict` says how to recover.
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

const workflow = {
	id: 'wf_eng',
	name: 'Engineering',
	description: 'The main pipeline',
	is_system: false,
	revision: 4,
	initial_state_id: 'wfs_design',
	states: [
		{ id: 'wfs_design', name: 'Design', category: 'active', position: 0, inherits_from: null },
		{ id: 'wfs_done', name: 'Done', category: 'done', position: 1, inherits_from: null }
	],
	transitions: [
		{ id: 'wft_1', name: 'finish', from_state_id: 'wfs_design', to_state_id: 'wfs_done' }
	],
	issue_count: 0,
	created_at: 0,
	updated_at: 0
};

let server: Server;
let baseUrl: string;
const seen: { method: string; path: string; body: unknown }[] = [];
/** When set, the next PATCH answers with this 409 instead of succeeding. */
let conflict: Record<string, unknown> | null = null;

beforeAll(async () => {
	server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		let raw = '';
		req.on('data', (chunk) => (raw += chunk));
		req.on('end', () => {
			seen.push({
				method: req.method ?? '',
				path: url.pathname,
				body: raw ? JSON.parse(raw) : undefined
			});
			const send = (status: number, body: unknown) => {
				res.writeHead(status, { 'content-type': 'application/json' });
				res.end(JSON.stringify(body));
			};
			if (url.pathname === '/api/v1/workflows' && req.method === 'GET') {
				return send(200, { items: [workflow], next_cursor: null });
			}
			if (url.pathname === '/api/v1/workflows/wf_eng' && req.method === 'PATCH') {
				if (conflict) {
					return send(409, {
						error: {
							code: 'workflow_conflict',
							message:
								'This workflow changed after you read it. Reload it, review the changes, then save again.',
							details: conflict
						}
					});
				}
				return send(200, { ...workflow, revision: workflow.revision + 1 });
			}
			send(404, { error: { code: 'not_found', message: 'no' } });
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
	seen.length = 0;
	conflict = null;
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

const patches = () => seen.filter((r) => r.method === 'PATCH').map((r) => r.body);

describe('tines workflows show', () => {
	it('prints the revision to pass to --expect-revision', async () => {
		const res = await cli(['workflows', 'show', 'Engineering']);
		expect(res.stderr).toBe('');
		expect(res.code).toBe(0);
		expect(res.stdout.split('\n').slice(0, 3)).toEqual([
			'Engineering  [wf_eng]',
			'The main pipeline',
			'revision: 4'
		]);
	}, 60_000);
});

describe('tines workflows edit --expect-revision', () => {
	it('sends the flag as expected_revision', async () => {
		const res = await cli([
			'workflows',
			'edit',
			'Engineering',
			'-n',
			'Eng',
			'--expect-revision',
			'4'
		]);
		expect(res.stderr).toBe('');
		expect(res.code).toBe(0);
		expect(patches()).toEqual([{ name: 'Eng', expected_revision: 4 }]);
		// The result is printed at the revision the save produced.
		expect(res.stdout).toContain('revision: 5');
	}, 60_000);

	it('lets the flag win over the JSON body', async () => {
		const res = await cli([
			'workflows',
			'edit',
			'Engineering',
			'{"description":"d","expected_revision":2}',
			'--expect-revision',
			'4'
		]);
		expect(res.code).toBe(0);
		expect(patches()).toEqual([{ description: 'd', expected_revision: 4 }]);
	}, 60_000);

	it('passes a JSON expected_revision through when no flag is given', async () => {
		const res = await cli([
			'workflows',
			'edit',
			'Engineering',
			'{"description":"d","expected_revision":2}'
		]);
		expect(res.code).toBe(0);
		expect(patches()).toEqual([{ description: 'd', expected_revision: 2 }]);
	}, 60_000);

	it("never fills the revision in from the CLI's own read", async () => {
		const res = await cli(['workflows', 'edit', 'Engineering', '-n', 'Eng']);
		expect(res.code).toBe(0);
		expect(patches()).toEqual([{ name: 'Eng' }]);
	}, 60_000);

	it('still needs something to update', async () => {
		const res = await cli(['workflows', 'edit', 'Engineering', '--expect-revision', '4']);
		expect(res.code).toBe(1);
		expect(res.stderr).toContain('nothing to update');
		expect(patches()).toEqual([]);
	}, 60_000);

	it('refuses a revision that is not a positive integer', async () => {
		const res = await cli([
			'workflows',
			'edit',
			'Engineering',
			'-n',
			'Eng',
			'--expect-revision',
			'0'
		]);
		expect(res.code).toBe(1);
		expect(res.stderr).toContain('expect-revision must be a positive integer');
		expect(seen).toEqual([]);
	}, 60_000);

	it('says how to recover from a conflict, naming the current revision', async () => {
		conflict = {
			committed: false,
			expected_revision: 4,
			current_revision: 6,
			remedy: 'reload_workflow'
		};
		const res = await cli([
			'workflows',
			'edit',
			'Engineering',
			'-n',
			'Eng',
			'--expect-revision',
			'4'
		]);
		expect(res.code).toBe(1);
		expect(res.stdout).toBe('');
		expect(res.stderr.trimEnd()).toBe(
			'error: This workflow changed after you read it. Reload it, review the changes, then save again. (workflow_conflict)\n' +
				'hint: re-read with `tines workflows show wf_eng`, then retry with --expect-revision 6'
		);
		// One attempt: the CLI does not retry a refused save.
		expect(patches()).toHaveLength(1);
	}, 60_000);
});
