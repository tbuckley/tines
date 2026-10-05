/**
 * `tines packs`, through the real bin against a fake API: offline validation
 * of a folder and an archive, the install review → confirm flow and the
 * bodies it sends, the browser-only stop, export to a folder or archive,
 * typed input values, and replace from source.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
	type PackDetail,
	type PackExport,
	type PackInputView,
	type PackModel,
	type PackReview,
	type PackSummary
} from '@tines/shared';
import {
	packDigest,
	packFilesFromRecord,
	parsePack,
	readPackArchive,
	writePackArchive
} from '@tines/shared/packs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineeringPack } from '../../shared/src/packs/engineering-fixture.js';
import { CLI_BIN, NODE } from './test-bin.js';

type Handler = (body: Record<string, unknown> | null) => { status?: number; body: unknown };

let server: Server;
let baseUrl: string;
let routes: Record<string, Handler> = {};
let requests: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
const dir = mkdtempSync(join(tmpdir(), 'tines-packs-cli-'));

/** The spec's engineering pack, with QA's state narrowed so an API key may install it. */
function narrowPack(): Record<string, string> {
	const record = engineeringPack();
	record['workflows/qa/workflow.yaml'] = record['workflows/qa/workflow.yaml'].replace(
		'run_scope: organization',
		'run_scope: issue'
	);
	return record;
}

function writeFolder(root: string, record: Record<string, string>): void {
	for (const [path, text] of Object.entries(record)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	}
}

const project = { id: 'prj_1', name: 'acme', archived_at: null, owner: null };

function summary(over: Partial<PackSummary> = {}): PackSummary {
	return {
		id: 'pack_1',
		pack_key: 'tbuckley/engineering',
		name: 'Engineering',
		description: '',
		kind: 'installed',
		version: 4,
		digest: 'd'.repeat(64),
		position: 0,
		project_id: 'prj_1',
		source: { kind: 'file', pack_id: null, project_id: null, project_name: null },
		derived_from: null,
		needs_setup: [],
		newer_version_available: false,
		changed_since_export: false,
		workflow_count: 2,
		item_count: 14,
		schedule_count: 2,
		revision: 7,
		created_at: 0,
		updated_at: 0,
		...over
	};
}

function inputViews(model: PackModel): PackInputView[] {
	return Object.entries(model.manifest.inputs).map(([name, decl]) => ({
		name,
		decl,
		value: null,
		missing:
			(decl.type === 'text' && decl.required !== false && decl.default === undefined) ||
			decl.type === 'repo' ||
			(decl.type === 'workflow' && decl.default === undefined)
	}));
}

async function review(record: Record<string, string>, over: Partial<PackReview> = {}) {
	const parsed = await parsePack(packFilesFromRecord(record));
	const model = parsed.model!;
	const r: PackReview = {
		action: 'install',
		digest: parsed.digest,
		errors: [],
		warnings: [],
		model,
		adds: {
			workflows: model.workflows.map((w) => ({
				key: w.key,
				name: w.name,
				states: w.states.map((s) => ({ key: s.key, name: s.name }))
			})),
			project_items: [{ kind: 'prompt', name: 'conventions' }],
			env: [],
			fixed_repos: [{ name: 'docs', url: 'https://github.com/acme/docs', branch: 'main' }],
			wide_states: [],
			schedules: model.schedules.map((s) => ({ key: s.key, name: s.name }))
		},
		replacements: [],
		inputs: inputViews(model),
		requires_browser: false,
		already_installed: null,
		...over
	};
	return r;
}

function detail(over: Partial<PackDetail> = {}): PackDetail {
	return {
		...summary(),
		readme: null,
		changelog: null,
		inputs: [
			{
				name: 'staging_url',
				decl: { type: 'text', description: 'Staging' },
				value: null,
				missing: true
			},
			{
				name: 'github_token',
				decl: { type: 'secret', description: 'Token' },
				value: null,
				missing: false
			},
			{ name: 'app_repo', decl: { type: 'repo', description: 'Repo' }, value: null, missing: true },
			{ name: 'bugs', decl: { type: 'workflow', description: 'Bugs' }, value: null, missing: true }
		],
		workflows: [],
		items: [],
		schedules: [],
		project_addition_count: 0,
		...over
	};
}

beforeAll(async () => {
	server = createServer((req, res) => {
		let raw = '';
		req.on('data', (chunk) => (raw += chunk));
		req.on('end', () => {
			const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
			const path = req.url ?? '';
			requests.push({ method: req.method ?? '', path, body });
			const key = `${req.method} ${path.split('?')[0]}`;
			const handler =
				routes[key] ??
				(key.startsWith('GET /api/v1/projects') && path.split('?')[0] === '/api/v1/projects'
					? () => ({ body: { items: [project], next_cursor: null } })
					: undefined);
			if (!handler) {
				res.writeHead(404, { 'content-type': 'application/json' });
				return res.end(JSON.stringify({ error: { code: 'not_found', message: `no ${key}` } }));
			}
			const out = handler(body);
			res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
			res.end(JSON.stringify(out.body));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	requests = [];
	routes = {
		'GET /api/v1/projects/prj_1/packs': () => ({ body: { items: [summary()], next_cursor: null } })
	};
});

function cli(
	args: string[],
	opts: { stdin?: string; cwd?: string } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(NODE, [CLI_BIN, ...args], {
			cwd: opts.cwd,
			env: { ...process.env, TINES_API_URL: baseUrl, TINES_API_KEY: 'test', TZ: 'UTC' }
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (c) => (stdout += c));
		child.stderr.on('data', (c) => (stderr += c));
		child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
		child.stdin.end(opts.stdin ?? '');
	});
}

const posts = (suffix: string) =>
	requests.filter((r) => r.method !== 'GET' && r.path.endsWith(suffix));

describe('packs validate (offline)', () => {
	it('validates a folder, skipping clutter and .git, with the library digest', async () => {
		const root = join(dir, 'folder', 'engineering');
		writeFolder(root, engineeringPack());
		writeFileSync(join(root, '.DS_Store'), 'junk');
		mkdirSync(join(root, '.git'), { recursive: true });
		writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
		const expected = await packDigest(packFilesFromRecord(engineeringPack()));

		// validate never calls the API: the fake server records nothing.
		const result = await cli(['packs', 'validate', root, '--json']);
		expect(result.code).toBe(0);
		const json = JSON.parse(result.stdout);
		expect(json.digest).toBe(expected);
		expect(json.errors).toEqual([]);
		expect(json.files).not.toContain('.DS_Store');
		expect(json.files.some((f: string) => f.startsWith('.git'))).toBe(false);
		expect(json.model.manifest.id).toBe('tbuckley/engineering');
		expect(requests).toEqual([]);

		const text = await cli(['packs', 'validate', root]);
		expect(text.stdout).toContain('valid pack tbuckley/engineering "Engineering" (version 4)');
		expect(text.stdout).toContain(`digest: ${expected}`);
		expect(text.stdout).toContain('workflows: 2 (engineering: 4 states, qa: 3 states)');
		expect(text.stdout).toContain('items by reach: project 2, pack 7, workflow 1, state 4');
		expect(text.stdout).toContain('schedules: 2 (nightly, weekly-triage)');
	});

	it('validates a .tinespack archive to the same digest', async () => {
		const files = packFilesFromRecord(engineeringPack());
		const archive = join(dir, 'engineering.tinespack');
		writeFileSync(archive, writePackArchive(files, 'engineering'));
		const result = await cli(['packs', 'validate', archive, '--json']);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).digest).toBe(await packDigest(files));
	});

	it('prints errors with their paths and exits 1', async () => {
		const record = engineeringPack();
		record['shared/house-style.md'] = 'Hello {{ inputs.nobody }}\n';
		const root = join(dir, 'broken');
		writeFolder(root, record);
		const result = await cli(['packs', 'validate', root]);
		expect(result.code).toBe(1);
		expect(result.stdout).toContain('invalid pack: 1 error');
		expect(result.stdout).toMatch(
			/error shared\/house-style\.md: .*inputs\.nobody.*\[unknown_input\]/
		);
	});
});

describe('packs install', () => {
	it('reviews, then installs with --yes, binding the reviewed digest', async () => {
		const record = narrowPack();
		const root = join(dir, 'narrow');
		writeFolder(root, record);
		const rev = await review(record);
		routes['POST /api/v1/projects/prj_1/packs/install/prepare'] = () => ({ body: rev });
		routes['POST /api/v1/projects/prj_1/packs/install'] = () => ({
			status: 201,
			body: {
				id: 'prc_1',
				action: 'install',
				pack: summary(),
				digest: rev.digest,
				version: 4,
				created_at: 0,
				schedules_created: [{ id: 'sch_1', name: 'Nightly QA' }]
			}
		});

		const result = await cli(
			[
				'packs',
				'install',
				root,
				'acme',
				'--value',
				'staging_url=https://staging.acme.test',
				'--repo',
				'app_repo=https://github.com/acme/app#develop',
				'--workflow',
				'bugs=pack:engineering/triage',
				'--workflow',
				'escalation=wf_esc',
				'--secret-stdin',
				'github_token',
				'--schedule',
				'nightly',
				'--schedule',
				'weekly-triage@Europe/London',
				'--yes'
			],
			{ stdin: 'ghp_secret\n' }
		);
		expect(result.stderr).toBe('');
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('Install Engineering (tbuckley/engineering) version 4');
		expect(result.stdout).toContain('README:');
		expect(result.stdout).toContain('project-wide prompt "conventions" — applies to every issue');
		expect(result.stdout).toContain('fixed repo docs: https://github.com/acme/docs#main');
		expect(result.stdout).toContain('staging_url (text) — set by this command');
		expect(result.stdout).toContain('installed Engineering [pack_1]');
		expect(result.stdout).toContain('created schedule Nightly QA');

		const [prepare] = posts('/install/prepare');
		const [install] = posts('/install');
		const files = prepare.body!.files as { path: string }[];
		expect(files.map((f) => f.path).sort()).toEqual(Object.keys(record).sort());
		expect(install.body).toEqual({
			files: prepare.body!.files,
			expected_digest: rev.digest,
			values: {
				staging_url: { text: 'https://staging.acme.test' },
				app_repo: { repo_url: 'https://github.com/acme/app', repo_branch: 'develop' },
				bugs: { workflow_id: 'pack:engineering/triage' },
				escalation: { workflow_id: 'wf_esc', state_id: null }
			},
			my_secrets: { github_token: 'ghp_secret' },
			schedules: [
				{ key: 'nightly', timezone: 'UTC' },
				{ key: 'weekly-triage', timezone: 'Europe/London' }
			]
		});
	});

	it('sends an archive as archive_b64 and --json prints only the receipt', async () => {
		const record = narrowPack();
		const archive = join(dir, 'narrow.tinespack');
		writeFileSync(archive, writePackArchive(packFilesFromRecord(record), 'engineering'));
		const rev = await review(record);
		routes['POST /api/v1/projects/prj_1/packs/install/prepare'] = () => ({ body: rev });
		routes['POST /api/v1/projects/prj_1/packs/install'] = () => ({
			status: 201,
			body: { id: 'prc_1', pack: summary(), schedules_created: [] }
		});
		const result = await cli([
			'packs',
			'install',
			archive,
			'acme',
			'--authored',
			'--yes',
			'--json'
		]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).id).toBe('prc_1');
		expect(result.stderr).toContain('Install Engineering');
		const [install] = posts('/install');
		expect(install.body).toEqual({
			archive_b64: readFileSync(archive).toString('base64'),
			expected_digest: rev.digest,
			authored: true
		});
	});

	it('stops before confirming a pack only a browser may install', async () => {
		const record = engineeringPack();
		const root = join(dir, 'wide');
		writeFolder(root, record);
		const rev = await review(record, {
			requires_browser: true,
			adds: {
				workflows: [],
				project_items: [],
				env: [],
				fixed_repos: [],
				wide_states: [{ workflow: 'QA', state: 'Test', run_scope: 'organization' }],
				schedules: []
			}
		});
		routes['POST /api/v1/projects/prj_1/packs/install/prepare'] = () => ({ body: rev });
		const result = await cli(['packs', 'install', root, 'acme', '--yes']);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('HIGH RISK: state QA / Test has run_scope organization');
		expect(result.stderr).toContain('install it from the web UI');
		expect(result.stderr).toContain('An API key cannot');
		expect(posts('/install')).toEqual([]);
	});

	it('refuses to install without a confirmation when stdin is not a terminal', async () => {
		const record = narrowPack();
		const root = join(dir, 'noconfirm');
		writeFolder(root, record);
		const rev = await review(record);
		routes['POST /api/v1/projects/prj_1/packs/install/prepare'] = () => ({ body: rev });
		const result = await cli(['packs', 'install', root, 'acme']);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('rerun with --yes');
		expect(posts('/install')).toEqual([]);
	});

	it('names the right flag for an input of another type', async () => {
		const record = narrowPack();
		const root = join(dir, 'wrongflag');
		writeFolder(root, record);
		const rev = await review(record);
		routes['POST /api/v1/projects/prj_1/packs/install/prepare'] = () => ({ body: rev });
		const result = await cli(['packs', 'install', root, 'acme', '--value', 'app_repo=x', '--yes']);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('"app_repo" is a repo input; set it with --repo');
		expect(posts('/install')).toEqual([]);
	});

	it('installs from another project with --from', async () => {
		const rev = await review(narrowPack());
		routes['GET /api/v1/packs/sources'] = () => ({
			body: {
				items: [
					{
						pack_id: 'pack_src',
						pack_key: 'tbuckley/engineering',
						name: 'Engineering',
						description: '',
						kind: 'authored',
						version: 4,
						project_id: 'prj_2',
						project_name: 'home'
					}
				],
				next_cursor: null
			}
		});
		routes['POST /api/v1/projects/prj_1/packs/install/prepare'] = () => ({ body: rev });
		routes['POST /api/v1/projects/prj_1/packs/install'] = () => ({
			status: 201,
			body: { id: 'prc_2', pack: summary(), schedules_created: [] }
		});
		const result = await cli([
			'packs',
			'install',
			'--from',
			'tbuckley/engineering',
			'acme',
			'--yes'
		]);
		expect(result.code).toBe(0);
		expect(posts('/install/prepare')[0].body).toEqual({ source_pack_id: 'pack_src' });
		expect(posts('/install')[0].body).toEqual({
			source_pack_id: 'pack_src',
			expected_digest: rev.digest
		});
	});
});

describe('packs replace', () => {
	it('replaces from source with the mapping and version confirmation sent', async () => {
		const rev = await review(narrowPack(), {
			action: 'replace',
			current: { version: 5, digest: 'e'.repeat(64), kind: 'installed' },
			changelog: '## 4\n\n- Added QA.\n',
			files: [{ path: 'README.md', change: 'changed', before: 'a\nb\n', after: 'a\nc\n' }],
			adds_changed: null,
			state_mapping: [
				{
					state_id: 'wfs_old',
					workflow_key: 'engineering',
					state_key: 'qa-check',
					workflow_name: 'Engineering',
					state_name: 'QA check',
					issues: 2,
					additions: 0,
					schedules: 0,
					suggested: 'engineering/review'
				}
			],
			mapping_targets: [
				{ ref: 'engineering/review', label: 'Engineering / Human review' },
				{ ref: 'engineering/implement', label: 'Engineering / Implement' }
			],
			version_warning: 'lower_version'
		});
		routes['POST /api/v1/projects/prj_1/packs/pack_1/replace/prepare'] = () => ({ body: rev });
		routes['POST /api/v1/projects/prj_1/packs/pack_1/replace'] = () => ({
			body: { id: 'prc_3', pack: summary(), version: 4, issues_moved: 2, schedules_created: [] }
		});

		const refused = await cli([
			'packs',
			'replace',
			'--from-source',
			'acme',
			'Engineering',
			'--yes'
		]);
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain('--confirm-version');
		expect(posts('/replace')).toEqual([]);

		const result = await cli([
			'packs',
			'replace',
			'--from-source',
			'acme',
			'tbuckley/engineering',
			'--map',
			'engineering/qa-check=engineering/implement',
			'--confirm-version',
			'--diff',
			'--yes'
		]);
		expect(result.stderr).toBe('');
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('installed version 5 → 4');
		expect(result.stdout).toContain('WARNING: this version is lower');
		expect(result.stdout).toContain('changed README.md');
		expect(result.stdout).toContain('-b');
		expect(result.stdout).toContain('+c');
		expect(result.stdout).toContain('QA check [wfs_old] — 2 issue(s)');
		expect(result.stdout).toContain('2 issue(s) moved');
		expect(posts('/replace/prepare')[0].body).toEqual({ from_source: true });
		expect(posts('/replace')[0].body).toEqual({
			from_source: true,
			expected_digest: rev.digest,
			confirm_version: true,
			state_mapping: { wfs_old: 'engineering/implement' }
		});
	});
});

describe('packs export', () => {
	const exported = async (): Promise<PackExport> => {
		const files = packFilesFromRecord(narrowPack());
		return {
			pack_key: 'tbuckley/engineering',
			version: 5,
			digest: await packDigest(files),
			filename: 'engineering-v5.tinespack',
			files: files.map((f) => ({
				path: f.path,
				content_b64: Buffer.from(f.bytes).toString('base64')
			})),
			new_version: true
		};
	};

	it('writes the files into a new folder, and refuses a non-empty one without --force', async () => {
		const out = await exported();
		routes['GET /api/v1/projects/prj_1/packs/pack_1/export'] = () => ({ body: out });
		const target = join(dir, 'exported', 'engineering');
		const result = await cli(['packs', 'export', 'acme', 'Engineering', '--dir', target]);
		expect(result.stderr).toBe('');
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('exported tbuckley/engineering version 5 (took a new version)');
		for (const [path, text] of Object.entries(narrowPack()))
			expect(readFileSync(join(target, path), 'utf8')).toBe(text);

		// The written folder validates offline to the exported digest.
		const check = await cli(['packs', 'validate', target, '--json']);
		expect(JSON.parse(check.stdout).digest).toBe(out.digest);

		requests = [];
		const again = await cli(['packs', 'export', 'acme', 'Engineering', '--dir', target]);
		expect(again.code).toBe(1);
		expect(again.stderr).toContain('is not empty; pass --force');
		expect(requests).toEqual([]);
		const forced = await cli([
			'packs',
			'export',
			'acme',
			'Engineering',
			'--dir',
			target,
			'--force'
		]);
		expect(forced.code).toBe(0);
	});

	it('writes the suggested archive name into the current folder by default', async () => {
		const out = await exported();
		routes['GET /api/v1/projects/prj_1/packs/pack_1/export'] = () => ({ body: out });
		const cwd = join(dir, 'cwd');
		mkdirSync(cwd, { recursive: true });
		const result = await cli(['packs', 'export', 'acme', 'pack_1'], { cwd });
		expect(result.code).toBe(0);
		const file = join(cwd, 'engineering-v5.tinespack');
		expect(existsSync(file)).toBe(true);
		const read = readPackArchive(new Uint8Array(readFileSync(file)));
		expect(read.errors).toEqual([]);
		expect(await packDigest(read.files)).toBe(out.digest);
	});
});

describe('packs set-input', () => {
	beforeEach(() => {
		routes['GET /api/v1/projects/prj_1/packs/pack_1'] = () => ({ body: detail() });
		routes['PUT /api/v1/projects/prj_1/packs/pack_1/values'] = () => ({ body: detail() });
		routes['GET /api/v1/workflows'] = () => ({
			body: {
				items: [
					{
						id: 'wf_bugs',
						name: 'Bugs',
						states: [{ id: 'wfs_triage', name: 'Triage' }]
					}
				],
				next_cursor: null
			}
		});
	});

	const sent = () => posts('/values').map((r) => r.body);

	it('types the value by the declared input', async () => {
		const pack = 'tbuckley/engineering';
		expect(
			(await cli(['packs', 'set-input', 'acme', pack, 'staging_url', 'https://s.test'])).code
		).toBe(0);
		expect(
			(await cli(['packs', 'set-input', 'acme', pack, 'app_repo', 'https://github.com/a/b#dev']))
				.code
		).toBe(0);
		expect((await cli(['packs', 'set-input', 'acme', pack, 'bugs', 'Bugs/Triage'])).code).toBe(0);
		expect((await cli(['packs', 'set-input', 'acme', pack, 'bugs', 'pack:qa'])).code).toBe(0);
		expect((await cli(['packs', 'set-input', 'acme', pack, 'bugs', '--clear'])).code).toBe(0);
		expect(sent()).toEqual([
			{ values: { staging_url: { text: 'https://s.test' } } },
			{ values: { app_repo: { repo_url: 'https://github.com/a/b', repo_branch: 'dev' } } },
			{ values: { bugs: { workflow_id: 'wf_bugs', state_id: 'wfs_triage' } } },
			{ values: { bugs: { workflow_id: 'pack:qa' } } },
			{ values: { bugs: null } }
		]);
		expect(requests.find((r) => r.path.startsWith('/api/v1/workflows'))?.path).toBe(
			'/api/v1/workflows?project=prj_1'
		);
	});

	it('sends a secret to set-secret instead, and rejects unknown inputs', async () => {
		const secret = await cli(['packs', 'set-input', 'acme', 'Engineering', 'github_token', 'x']);
		expect(secret.code).toBe(1);
		expect(secret.stderr).toContain('tines packs set-secret');
		const unknown = await cli(['packs', 'set-input', 'acme', 'Engineering', 'nope', 'x']);
		expect(unknown.code).toBe(1);
		expect(unknown.stderr).toContain('declares no input "nope"');
		expect(sent()).toEqual([]);
	});

	it('set-secret reads a piped value', async () => {
		routes['PUT /api/v1/projects/prj_1/packs/pack_1/my-secrets'] = () => ({ body: detail() });
		const result = await cli(['packs', 'set-secret', 'acme', 'Engineering', 'github_token'], {
			stdin: 'ghp_x\n'
		});
		expect(result.code).toBe(0);
		expect(posts('/my-secrets')[0].body).toEqual({ secrets: { github_token: 'ghp_x' } });
	});
});

describe('packs list and remove', () => {
	it('lists packs with their badges', async () => {
		routes['GET /api/v1/projects/prj_1/packs'] = () => ({
			body: {
				items: [
					summary({
						needs_setup: [
							{
								pack_id: 'pack_1',
								pack_name: 'Engineering',
								input: 'app_repo',
								type: 'repo',
								description: ''
							}
						],
						newer_version_available: true
					}),
					summary({
						id: 'pack_2',
						pack_key: 'p-x',
						name: 'Mine',
						kind: 'authored',
						version: null,
						source: null,
						changed_since_export: true
					})
				],
				next_cursor: null
			}
		});
		const result = await cli(['packs', 'list', 'acme']);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('needs setup (app_repo); newer version available');
		expect(result.stdout).toContain('changed since export');
	});

	it('shows what remove deletes, and stops when issues still use the pack', async () => {
		routes['GET /api/v1/projects/prj_1/packs/pack_1/remove-preview'] = () => ({
			body: {
				blocked_by: { issues: [{ id: 'iss_1', ref: 'acme/3' }], schedules: [] },
				additions: [{ id: 'ctx_1', kind: 'prompt', name: 'notes', scope_label: 'acme · Review' }],
				unbound_inputs: [{ pack_id: 'pack_2', pack_name: 'QA', input: 'bugs' }]
			}
		});
		const result = await cli(['packs', 'remove', 'acme', 'Engineering', '--yes']);
		expect(result.code).toBe(1);
		expect(result.stdout).toContain('issue acme/3');
		expect(result.stdout).toContain('prompt "notes" (acme · Review)');
		expect(result.stdout).toContain('QA: bugs');
		expect(result.stderr).toContain('move them first');
		expect(requests.some((r) => r.method === 'DELETE')).toBe(false);
	});

	it('removes with the revision it reviewed', async () => {
		routes['GET /api/v1/projects/prj_1/packs/pack_1/remove-preview'] = () => ({
			body: { blocked_by: { issues: [], schedules: [] }, additions: [], unbound_inputs: [] }
		});
		routes['DELETE /api/v1/projects/prj_1/packs/pack_1'] = () => ({
			body: { removed: true, additions_deleted: 0, inputs_unbound: 0 }
		});
		const result = await cli(['packs', 'remove', 'acme', 'Engineering', '--yes']);
		expect(result.code).toBe(0);
		expect(requests.find((r) => r.method === 'DELETE')?.body).toEqual({ expected_revision: 7 });
	});
});
