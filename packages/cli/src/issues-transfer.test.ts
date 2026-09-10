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

const scope = (label: string, extra: Record<string, string | null> = {}) => ({
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
	label,
	...extra
});

const sourceScope = scope('project demo', { project_id: 'prj_src', project_name: 'demo' });
const destinationScope = scope('project platform', {
	project_id: 'prj_dst',
	project_name: 'platform'
});
const issueScope = scope('issue demo/4', { issue_id: 'iss_1', issue_ref: 'demo/4' });

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
			prompt: {
				text: 'Retained instructions',
				parts: [
					{
						item_id: 'ctx_retained_prompt',
						name: 'issue-guidance',
						scope: issueScope,
						body: 'Retained instructions',
						version: 1,
						is_journal: false,
						inherited_from: null
					}
				],
				journal: null
			},
			skills: [
				{
					item_id: 'ctx_retained_skill',
					name: 'release-skill',
					scope: issueScope,
					description: '',
					version: 1,
					files: [
						{ path: 'SKILL.md', content: 'Release safely' },
						{ path: 'checklist.md', content: 'Verify rollback' }
					]
				}
			],
			repos: [
				{
					item_id: 'ctx_issue_repo',
					name: 'app',
					scope: issueScope,
					url: 'https://example.test/issue-override.git',
					branch: 'research',
					dir: 'app'
				},
				{
					item_id: 'ctx_docs_repo',
					name: 'docs',
					scope: sourceScope,
					url: 'https://example.test/docs.git',
					branch: null,
					dir: 'app'
				}
			],
			overridden: [
				{
					item_id: 'ctx_source_repo',
					kind: 'repo',
					name: 'app',
					scope: sourceScope,
					overridden_by: 'ctx_issue_repo',
					repo: { url: 'https://example.test/source.git', branch: null, dir: 'app' }
				}
			],
			conflicts: [{ dir: 'app', item_ids: ['ctx_issue_repo', 'ctx_docs_repo'] }]
		},
		after: {
			prompt: {
				text: 'Retained instructions\n\nDeploy on Fridays.',
				parts: [
					{
						item_id: 'ctx_retained_prompt',
						name: 'issue-guidance',
						scope: issueScope,
						body: 'Retained instructions',
						version: 1,
						is_journal: false,
						inherited_from: null
					},
					{
						item_id: 'ctx_dest',
						name: 'platform-context',
						scope: destinationScope,
						body: 'Deploy on Fridays.',
						version: 1,
						is_journal: false,
						inherited_from: null
					}
				],
				journal: null
			},
			skills: [
				{
					item_id: 'ctx_retained_skill',
					name: 'release-skill',
					scope: issueScope,
					description: '',
					version: 1,
					files: [
						{ path: 'SKILL.md', content: 'Release safely' },
						{ path: 'checklist.md', content: 'Verify rollback' }
					]
				}
			],
			repos: [
				{
					item_id: 'ctx_issue_repo',
					name: 'app',
					scope: issueScope,
					url: 'https://example.test/issue-override.git',
					branch: 'research',
					dir: 'app'
				},
				{
					item_id: 'ctx_ops_repo',
					name: 'ops',
					scope: destinationScope,
					url: 'https://example.test/ops.git',
					branch: null,
					dir: 'app'
				}
			],
			overridden: [
				{
					item_id: 'ctx_destination_repo',
					kind: 'repo',
					name: 'app',
					scope: destinationScope,
					overridden_by: 'ctx_issue_repo',
					repo: { url: 'https://example.test/destination.git', branch: 'main', dir: 'app' }
				}
			],
			conflicts: [{ dir: 'app', item_ids: ['ctx_issue_repo', 'ctx_ops_repo'] }]
		},
		changes: [
			{
				item_id: 'ctx_retained_prompt',
				name: 'issue-guidance',
				kind: 'prompt',
				change: 'retained',
				scope_before: issueScope,
				scope_after: issueScope,
				effective_before: true,
				effective_after: true
			},
			{
				item_id: 'ctx_retained_skill',
				name: 'release-skill',
				kind: 'skill',
				change: 'retained',
				scope_before: issueScope,
				scope_after: issueScope,
				effective_before: true,
				effective_after: true
			},
			{
				item_id: 'ctx_issue_repo',
				name: 'app',
				kind: 'repo',
				change: 'retained',
				scope_before: issueScope,
				scope_after: issueScope,
				effective_before: true,
				effective_after: true,
				repo_before: {
					url: 'https://example.test/issue-override.git',
					branch: 'research',
					dir: 'app'
				},
				repo_after: {
					url: 'https://example.test/issue-override.git',
					branch: 'research',
					dir: 'app'
				}
			},
			{
				item_id: 'ctx_source_repo',
				name: 'app',
				kind: 'repo',
				change: 'removed',
				scope_before: sourceScope,
				scope_after: null,
				effective_before: false,
				effective_after: false
			},
			{
				item_id: 'ctx_destination_repo',
				name: 'app',
				kind: 'repo',
				change: 'added',
				scope_before: null,
				scope_after: destinationScope,
				effective_before: false,
				effective_after: false
			},
			{
				item_id: 'ctx_src',
				name: 'demo-context',
				kind: 'prompt',
				change: 'removed',
				scope_before: sourceScope,
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
				scope_after: destinationScope,
				effective_before: false,
				effective_after: true
			}
		]
	},
	routing: {
		before: {
			eligible: false,
			verdict: 'Automation is off.',
			checks: [
				{ name: 'automation_enabled', ok: false, detail: 'Automation is off.' },
				{
					name: 'routed',
					ok: false,
					detail: 'No routing rule matches this issue.',
					action: { label: 'Add a rule', cli: 'tines routing-rules create' }
				}
			],
			pin: { runner_id: 'rnr_missing', runner_name: null, tier: 'premium' },
			matched_rule: null,
			runner_rule: null,
			tier_override: null,
			ambiguous_rules: [
				{ rule_id: 'rrl_a', scope_label: 'project demo' },
				{ rule_id: 'rrl_b', scope_label: 'label urgent' }
			],
			targets: [
				{
					runner_id: 'rnr_missing',
					runner_name: 'Unavailable runner',
					tier: 'premium',
					model: null,
					verdict: 'offline',
					detail: 'No recent heartbeat.'
				}
			],
			parked: true,
			attempt_count: 3,
			attempt_limit: 3,
			active_run: null,
			queue_position: null
		},
		after: {
			eligible: false,
			verdict: 'A matching rule is tied.',
			checks: [{ name: 'routed', ok: false, detail: 'Two equally specific routing rules match.' }],
			pin: { runner_id: 'rnr_missing', runner_name: null, tier: 'premium' },
			matched_rule: null,
			runner_rule: { rule_id: 'rrl_runner', scope_label: 'project platform' },
			tier_override: 'premium',
			ambiguous_rules: [
				{ rule_id: 'rrl_a', scope_label: 'project platform' },
				{ rule_id: 'rrl_b', scope_label: 'label urgent' }
			],
			targets: [
				{
					runner_id: 'rnr_missing',
					runner_name: 'Unavailable runner',
					tier: 'premium',
					model: null,
					verdict: 'offline',
					detail: 'No recent heartbeat.'
				}
			],
			parked: false,
			attempt_count: 3,
			attempt_limit: 5,
			active_run: { id: 'arun_existing', runner_name: 'Unavailable runner', status: 'running' },
			queue_position: 2
		}
	},
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
/** Flipped by a test to make the reviewed configuration go stale. */
let stale = false;
let blocker: 'project_archived' | 'issue_busy' | 'run_key_forbidden' | null = null;

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
					return send(
						200,
						blocker
							? {
									...preview,
									can_commit: false,
									preview_token: null,
									blockers: [{ code: blocker, message: `${blocker} blocked`, remedy: 'fix it' }]
								}
							: preview
					);
				}
				if (url.pathname === '/api/v1/issues/iss_1/transfer' && req.method === 'POST') {
					if (stale) {
						return send(409, {
							error: {
								code: 'transfer_preview_stale',
								message: 'The guidance changed since you reviewed it; review it again',
								details: null
							}
						});
					}
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
	stale = false;
	blocker = null;
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
const previews = () =>
	seen.filter((r) => r.method === 'GET' && r.path === '/api/v1/issues/iss_1/transfer');

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
		expect(res.stdout).toContain('prompt "issue-guidance" — retained');
		expect(res.stdout).toContain('skill "release-skill" — retained');
		expect(res.stdout).toContain('https://example.test/issue-override.git');
		expect(res.stdout).toContain('branch research; directory app');
		expect(res.stdout).toContain('https://example.test/source.git');
		expect(res.stdout).toContain('https://example.test/destination.git');
		expect(res.stdout).toContain('Repository checkout conflicts:');
		expect(res.stdout).toContain('Automation is off.');
		expect(res.stdout).toContain('No routing rule matches this issue.');
		expect(res.stdout).toContain('tied rule label urgent');
		expect(res.stdout).toContain('Unavailable runner');
		expect(res.stdout).toContain('tier override premium');
		expect(res.stdout).toContain('active run arun_existing');
		expect(res.stdout).toContain('queue position 2');
		expect(res.stdout).toContain('attempts 3/3; parked yes');
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
			'0'
		]);
		expect(res.code).toBe(0);
		expect(res.stdout).toContain('Retained instructions');
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

	it('does not re-review a stale preview for --yes, and posts exactly once', async () => {
		stale = true;
		const res = await cli(['issues', 'transfer', 'demo/4', '--project', 'platform', '--yes']);
		expect(res.code).not.toBe(0);
		// Nobody is there to answer a refreshed review, so it stops rather than
		// confirming guidance the operator never saw.
		expect(posts()).toHaveLength(1);
		expect(previews()).toHaveLength(1);
		expect(res.stderr).toContain('changed');
	}, 60_000);

	it('keeps stdout free of the review under --json', async () => {
		const res = await cli([
			'issues',
			'transfer',
			'demo/4',
			'--project',
			'platform',
			'--yes',
			'--json'
		]);
		expect(res.code).toBe(0);
		// Exactly one object, and none of the human review, on stdout.
		expect(JSON.parse(res.stdout).new_ref.ref).toBe('platform/8');
		expect(res.stdout).not.toContain('Preserved:');
	}, 60_000);

	for (const code of ['project_archived', 'issue_busy', 'run_key_forbidden'] as const) {
		it(`returns a failing JSON error for ${code}`, async () => {
			blocker = code;
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
			expect(posts()).toHaveLength(0);
			expect(JSON.parse(res.stdout)).toMatchObject({ error: { code } });
		}, 60_000);
	}
});
