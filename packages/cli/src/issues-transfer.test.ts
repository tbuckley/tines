/**
 * `tines issues transfer` against a stub API: that a dry run never POSTs, that
 * a noninteractive commit refuses rather than moving unreviewed, that `--yes`
 * confirms the exact token it fetched, and that a conflict comes back as a
 * structured JSON error instead of a silent repost.
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

const source = {
	id: 'prj_src',
	name: 'demo',
	description: '',
	default_workflow_id: null,
	created_at: 0,
	updated_at: 0,
	issue_count: 2,
	archived_at: null
};
const destination = { ...source, id: 'prj_dst', name: 'platform', issue_count: 7 };

const scope = (label: string) => ({
	project_id: null,
	project_name: null,
	workflow_state_id: null,
	workflow_state_name: null,
	workflow_id: null,
	workflow_name: null,
	label_id: null,
	label_name: null,
	label_color: null,
	issue_id: null,
	issue_ref: null,
	label
});

const preview = {
	issue_id: 'iss_1',
	source: { id: 'prj_src', name: 'demo', archived: false },
	destination: { id: 'prj_dst', name: 'platform', archived: false },
	old_ref: { project_id: 'prj_src', project_name: 'demo', number: 4, ref: 'demo/4' },
	new_ref: null,
	number_notice: 'Number assigned when you move.',
	preserved: {
		title: 'Port the importer',
		workflow_id: 'wf_1',
		state_id: 'wfs_1',
		state_entered_at: 0,
		created_at: 0,
		labels: [{ id: 'lbl_1', name: 'tooling' }],
		pinned_runner_id: 'rnr_1',
		pinned_tier: 'premium',
		attempt_count: 1,
		parked: false,
		comment_count: 3,
		artifact_count: 2,
		artifact_version_count: 4,
		run_count: 1,
		link_count: 1
	},
	context: {
		before: {
			prompt: { text: '', parts: [], journal: null },
			skills: [],
			repos: [],
			overridden: [],
			conflicts: []
		},
		after: {
			prompt: {
				text: '',
				parts: [
					{
						item_id: 'ctx_dest',
						name: 'platform-context',
						scope: scope('project platform'),
						body: 'Deploy on Fridays.',
						version: 1,
						is_journal: false,
						inherited_from: null
					}
				],
				journal: null
			},
			skills: [],
			repos: [],
			overridden: [],
			conflicts: []
		},
		changes: [
			{
				item_id: 'ctx_src',
				name: 'demo-context',
				kind: 'prompt',
				change: 'removed',
				scope_before: scope('project demo'),
				scope_after: null,
				effective_before: true,
				effective_after: false
			},
			{
				item_id: 'ctx_dest',
				name: 'platform-context',
				kind: 'prompt',
				change: 'added',
				scope_before: null,
				scope_after: scope('project platform'),
				effective_before: false,
				effective_after: true
			}
		]
	},
	routing: { before: null, after: null },
	schedule: null,
	noop: false,
	can_commit: true,
	blockers: [],
	preview_token: 'tok_reviewed',
	previewed_at: 0
};

const issue = {
	id: 'iss_1',
	project_id: 'prj_src',
	project_name: 'demo',
	number: 4,
	title: 'Port the importer',
	state: { id: 'wfs_1', name: 'Backlog', category: 'active' },
	labels: [],
	updated_at: 0,
	created_at: 0
};

let server: Server;
let baseUrl: string;
const seen: { method: string; path: string; body: string }[] = [];
/** Flipped by a test to make the commit lose a race. */
let conflict = false;

beforeAll(async () => {
	server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			seen.push({ method: req.method ?? '', path: url.pathname, body });
			const send = (status: number, payload: unknown) => {
				res.writeHead(status, { 'content-type': 'application/json' });
				res.end(JSON.stringify(payload));
			};
			if (url.pathname === '/api/v1/projects') {
				return send(200, { items: [source, destination], next_cursor: null });
			}
			if (url.pathname === '/api/v1/projects/prj_src/issues/4') return send(200, issue);
			if (url.pathname === '/api/v1/issues' || url.pathname.startsWith('/api/v1/issues/iss_1')) {
				if (url.pathname === '/api/v1/issues/iss_1/transfer' && req.method === 'GET') {
					return send(200, preview);
				}
				if (url.pathname === '/api/v1/issues/iss_1/transfer' && req.method === 'POST') {
					if (conflict) {
						return send(409, {
							error: {
								code: 'transfer_conflict',
								message: 'The issue has already moved; start again',
								details: { current_ref: 'platform/8' }
							}
						});
					}
					return send(200, {
						status: 'transferred',
						issue_id: 'iss_1',
						source: preview.source,
						destination: preview.destination,
						old_ref: preview.old_ref,
						new_ref: {
							project_id: 'prj_dst',
							project_name: 'platform',
							number: 8,
							ref: 'platform/8'
						},
						event_id: 'evt_1',
						issue_path: '/issues/platform/8'
					});
				}
				return send(200, url.pathname === '/api/v1/issues' ? { items: [issue] } : issue);
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
	conflict = false;
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

const posts = () => seen.filter((r) => r.method === 'POST');

describe('tines issues transfer', () => {
	it('reviews without moving under --dry-run, even with --yes', async () => {
		const res = await cli([
			'issues',
			'transfer',
			'demo/4',
			'--project',
			'platform',
			'--dry-run',
			'--yes'
		]);
		expect(res.code).toBe(0);
		expect(posts()).toHaveLength(0);
		expect(res.stdout).toContain('Move demo/4 from demo to platform');
		expect(res.stdout).toContain('Number assigned when you move.');
		expect(res.stdout).toContain('removed with source');
		expect(res.stdout).toContain('added by destination');
		// The retained record is part of the review, not a promise of a lock.
		expect(res.stdout).toContain('3 comment(s), 2 artifact(s) in 4 version(s)');
	}, 60_000);

	it('emits the whole contract with a null new_ref under --dry-run --json', async () => {
		const res = await cli([
			'issues',
			'transfer',
			'demo/4',
			'--project',
			'platform',
			'--dry-run',
			'--json'
		]);
		expect(res.code).toBe(0);
		expect(posts()).toHaveLength(0);
		const parsed = JSON.parse(res.stdout);
		expect(parsed).toMatchObject({ issue_id: 'iss_1', new_ref: null, can_commit: true });
		expect(parsed.old_ref.ref).toBe('demo/4');
	}, 60_000);

	it('prints one reviewed item in full', async () => {
		const res = await cli([
			'issues',
			'transfer',
			'demo/4',
			'--project',
			'platform',
			'--inspect',
			'1'
		]);
		expect(res.code).toBe(0);
		expect(res.stdout).toContain('Deploy on Fridays.');
		expect(posts()).toHaveLength(0);
	}, 60_000);

	it('refuses to commit noninteractively without --yes and writes nothing', async () => {
		const res = await cli(['issues', 'transfer', 'demo/4', '--project', 'platform']);
		expect(res.code).not.toBe(0);
		expect(res.stderr).toContain('--yes');
		expect(res.stderr).toContain('--dry-run --json');
		expect(posts()).toHaveLength(0);
	}, 60_000);

	it('commits the fetched token under --yes and prints copyable refs', async () => {
		const res = await cli(['issues', 'transfer', 'demo/4', '--project', 'platform', '--yes']);
		expect(res.code).toBe(0);
		expect(posts()).toHaveLength(1);
		expect(JSON.parse(posts()[0].body)).toEqual({
			project_id: 'prj_dst',
			preview_token: 'tok_reviewed'
		});
		expect(res.stdout).toContain('moved demo/4 to platform/8');
		expect(res.stdout).toContain('demo/4 still resolves to this issue');
	}, 60_000);

	it('reports a competing move as a structured JSON error and never reposts', async () => {
		conflict = true;
		const res = await cli([
			'issues',
			'transfer',
			'demo/4',
			'--project',
			'platform',
			'--yes',
			'--json'
		]);
		expect(res.code).not.toBe(0);
		expect(posts()).toHaveLength(1);
		expect(JSON.parse(res.stdout)).toEqual({
			error: {
				code: 'transfer_conflict',
				message: 'The issue has already moved; start again',
				details: { current_ref: 'platform/8' }
			}
		});
	}, 60_000);
});
