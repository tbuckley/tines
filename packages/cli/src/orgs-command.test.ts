/**
 * Organizations in the CLI, through the real bin against a fake API: the
 * `tines orgs` group and the bodies it sends, `<org>` resolution and its
 * ambiguity, the browser-only stops (transfer, delete, project move confirm,
 * Share this project), `--org` on the create commands, the projects list's
 * organization column, and the organizations scope of `api-keys create`.
 */
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OrganizationDetail, OrganizationSummary, ProjectMovePreview } from '@tines/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CLI_BIN, NODE } from './test-bin.js';

type Handler = (body: Record<string, unknown> | null) => { status?: number; body: unknown };

let server: Server;
let baseUrl: string;
let routes: Record<string, Handler> = {};
let requests: { method: string; path: string; body: Record<string, unknown> | null }[] = [];

function org(over: Partial<OrganizationSummary>): OrganizationSummary {
	return {
		id: 'org_x',
		name: 'X',
		kind: 'shared',
		role: 'owner',
		owner: { id: 'usr_me', name: 'Tom' },
		member_count: 1,
		project_count: 0,
		revision: 1,
		created_at: 0,
		...over
	};
}

const personal = org({ id: 'org_usr_me', name: 'Tom', kind: 'personal', project_count: 1 });
const acme = org({ id: 'org_acme', name: 'Acme', member_count: 2, project_count: 2, revision: 4 });
const guild = org({
	id: 'org_guild',
	name: 'Guild',
	role: 'manager',
	owner: { id: 'usr_ann', name: 'Ann' },
	member_count: 3,
	project_count: 5
});
const dupA = org({ id: 'org_dup_a', name: 'Dup', owner: { id: 'usr_me', name: 'Tom' } });
const dupB = org({ id: 'org_dup_b', name: 'Dup', owner: { id: 'usr_ann', name: 'Ann' } });

const acmeDetail: OrganizationDetail = {
	...acme,
	members: [
		{
			user_id: 'usr_me',
			name: 'Tom',
			email: 'tom@example.test',
			role: 'owner',
			joined_at: 0,
			revision: 1
		},
		{
			user_id: 'usr_bob',
			name: 'Bob',
			email: 'Bob@Example.test',
			role: 'manager',
			joined_at: 1000,
			revision: 2
		}
	],
	invitations: [
		{
			id: 'oinv_1',
			email: 'cara@example.test',
			expires_at: 0,
			created_at: 0,
			delivery_status: 'sent'
		}
	],
	projects: [
		{ id: 'prj_2', name: 'Site', archived_at: null, issue_count: 4 },
		{ id: 'prj_3', name: 'Docs', archived_at: null, issue_count: 0 }
	]
};

function project(id: string, name: string, o: OrganizationSummary) {
	return {
		id,
		name,
		description: '',
		default_workflow_id: null,
		created_at: 0,
		updated_at: 0,
		issue_count: 0,
		archived_at: null,
		organization: { id: o.id, name: o.name, kind: o.kind }
	};
}

const projects = [
	project('prj_1', 'Site', personal),
	project('prj_2', 'Site', acme),
	project('prj_3', 'Docs', acme)
];

const preview: ProjectMovePreview = {
	project: { id: 'prj_3', name: 'Docs' },
	from: { id: 'org_acme', name: 'Acme', kind: 'shared' },
	to: { id: 'org_usr_me', name: 'Tom', kind: 'personal' },
	people: { gain: [], lose: [{ id: 'usr_bob', name: 'Bob' }] },
	workflows: [
		{ id: 'wf_eng', name: 'Engineering', handling: 'copy', issues: 3, schedules: 1 },
		{ id: 'wf_std', name: 'Standard', handling: 'system', issues: 1, schedules: 0 },
		{ id: 'wf_own', name: 'Docs flow', handling: 'moves', issues: 2, schedules: 0 }
	],
	labels: [
		{ id: 'lbl_1', name: 'bug', handling: 'use_existing' },
		{ id: 'lbl_2', name: 'docs', handling: 'copy' }
	],
	context_lost: [{ id: 'ctx_1', kind: 'prompt', name: 'house-style' }],
	blockers: [{ code: 'run_active', message: 'Run arun_1 is running; hold the issue' }],
	digest: 'd'.repeat(64)
};

beforeAll(async () => {
	server = createServer((req, res) => {
		let raw = '';
		req.on('data', (chunk) => (raw += chunk));
		req.on('end', () => {
			const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
			const path = req.url ?? '';
			requests.push({ method: req.method ?? '', path, body });
			const handler = routes[`${req.method} ${path.split('?')[0]}`];
			if (!handler) {
				res.writeHead(404, { 'content-type': 'application/json' });
				return res.end(
					JSON.stringify({ error: { code: 'not_found', message: `no ${req.method} ${path}` } })
				);
			}
			const out = handler(body);
			res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
			res.end(JSON.stringify(out.body));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let orgList: OrganizationSummary[];

beforeEach(() => {
	requests = [];
	orgList = [personal, acme, guild];
	routes = {
		'GET /api/v1/organizations': () => ({ body: { items: orgList, next_cursor: null } }),
		'GET /api/v1/organizations/org_acme': () => ({ body: acmeDetail }),
		'GET /api/v1/projects': () => ({ body: { items: projects, next_cursor: null } })
	};
});

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(NODE, [CLI_BIN, ...args], {
			env: { ...process.env, TINES_API_URL: baseUrl, TINES_API_KEY: 'test', TZ: 'UTC' }
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (c) => (stdout += c));
		child.stderr.on('data', (c) => (stderr += c));
		child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
		// Not a terminal: a confirmation prompt is refused, never guessed.
		child.stdin.end('');
	});
}

const writes = () => requests.filter((r) => r.method !== 'GET');

describe('tines orgs', () => {
	it('lists organizations with kind, your role, owner and counts', async () => {
		const result = await cli(['orgs', 'list']);
		expect(result.code).toBe(0);
		const lines = result.stdout.trim().split('\n');
		expect(lines[0]).toMatch(/^NAME\s+KIND\s+ROLE\s+OWNER\s+MEMBERS\s+PROJECTS\s+ID$/);
		expect(lines[1]).toMatch(/^Tom\s+personal\s+owner\s+Tom\s+1\s+1\s+org_usr_me$/);
		expect(lines[2]).toMatch(/^Acme\s+shared\s+owner\s+Tom\s+2\s+2\s+org_acme$/);
		expect(lines[3]).toMatch(/^Guild\s+shared\s+manager\s+Ann\s+3\s+5\s+org_guild$/);

		const json = await cli(['orgs', 'list', '--json']);
		expect(JSON.parse(json.stdout).items.map((o: OrganizationSummary) => o.id)).toEqual([
			'org_usr_me',
			'org_acme',
			'org_guild'
		]);
	});

	it('shows members with roles and emails, pending invitations and projects', async () => {
		const result = await cli(['orgs', 'show', 'Acme']);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('Acme  [org_acme]');
		expect(result.stdout).toContain('shared organization — owner Tom; you are owner');
		expect(result.stdout).toMatch(/Bob\s+Bob@Example\.test\s+manager\s+usr_bob/);
		expect(result.stdout).toMatch(/Tom\s+tom@example\.test\s+owner\s+usr_me/);
		expect(result.stdout).toContain('pending invitations (1):');
		expect(result.stdout).toMatch(/oinv_1\s+cara@example\.test\s+sent/);
		expect(result.stdout).toMatch(/Site\s+4\s+prj_2/);
		expect(result.stdout).toMatch(/Docs\s+0\s+prj_3/);
	});

	it('resolves <org> by id before name', async () => {
		const result = await cli(['orgs', 'show', 'org_acme', '--json']);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).members).toHaveLength(2);
		expect(requests.map((r) => r.path)).toEqual([
			'/api/v1/organizations',
			'/api/v1/organizations/org_acme'
		]);
	});

	it('refuses an ambiguous organization name, listing the ids', async () => {
		orgList = [personal, dupA, dupB];
		const result = await cli(['orgs', 'show', 'Dup']);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('organization name "Dup" is ambiguous; use an id');
		expect(result.stderr).toContain('org_dup_a (shared, owner Tom)');
		expect(result.stderr).toContain('org_dup_b (shared, owner Ann)');
	});

	it('names what it has when nothing matches', async () => {
		const result = await cli(['orgs', 'show', 'Nope']);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			'no organization "Nope" (have: Tom (personal) [org_usr_me], Acme [org_acme], Guild [org_guild])'
		);
	});

	it('creates a shared organization', async () => {
		routes['POST /api/v1/organizations'] = () => ({
			status: 201,
			body: { ...acmeDetail, id: 'org_new', name: 'New Co' }
		});
		const result = await cli(['orgs', 'create', 'New Co']);
		expect(result.code).toBe(0);
		expect(writes()).toEqual([
			{ method: 'POST', path: '/api/v1/organizations', body: { name: 'New Co' } }
		]);
		expect(result.stdout).toContain('created organization "New Co" (org_new)');
	});

	it('renames with the revision it resolved', async () => {
		routes['PATCH /api/v1/organizations/org_acme'] = () => ({
			body: { ...acmeDetail, name: 'Acme Inc' }
		});
		const result = await cli(['orgs', 'rename', 'Acme', 'Acme Inc']);
		expect(result.code).toBe(0);
		expect(writes()[0].body).toEqual({ name: 'Acme Inc', expected_revision: 4 });
		expect(result.stdout).toContain('renamed organization "Acme" to "Acme Inc" (org_acme)');
	});

	it('invites by email, and refuses a personal organization before any write', async () => {
		routes['POST /api/v1/organizations/org_acme/invitations'] = (body) => ({
			status: 201,
			body: { id: 'oinv_2', email: body?.email, expires_at: 0, delivery_status: 'sent' }
		});
		const result = await cli(['orgs', 'invite', 'Acme', 'dee@example.test']);
		expect(result.code).toBe(0);
		expect(writes()).toEqual([
			{
				method: 'POST',
				path: '/api/v1/organizations/org_acme/invitations',
				body: { email: 'dee@example.test' }
			}
		]);
		expect(result.stdout).toContain('Invited dee@example.test to Acme [oinv_2]');

		requests = [];
		const refused = await cli(['orgs', 'invite', 'Tom', 'dee@example.test']);
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain('Tom (personal) is a personal organization');
		expect(writes()).toEqual([]);
	});

	it('cancels an invitation', async () => {
		routes['DELETE /api/v1/organizations/org_acme/invitations/oinv_1'] = () => ({
			body: { id: 'oinv_1', canceled: true }
		});
		const result = await cli(['orgs', 'cancel-invite', 'Acme', 'oinv_1']);
		expect(result.code).toBe(0);
		expect(writes().map((r) => `${r.method} ${r.path}`)).toEqual([
			'DELETE /api/v1/organizations/org_acme/invitations/oinv_1'
		]);
		expect(result.stdout).toContain('canceled invitation oinv_1 to Acme');
	});

	it('removes a person named by email (any case) or user id', async () => {
		routes['DELETE /api/v1/organizations/org_acme/members/usr_bob'] = () => ({
			body: { organization_id: 'org_acme', user_id: 'usr_bob', removed: true }
		});
		const byEmail = await cli(['orgs', 'remove', 'Acme', 'bob@example.TEST']);
		expect(byEmail.code).toBe(0);
		expect(byEmail.stdout).toContain('removed Bob (usr_bob) from Acme');
		const byId = await cli(['orgs', 'remove', 'org_acme', 'usr_bob']);
		expect(byId.code).toBe(0);
		expect(writes().map((r) => `${r.method} ${r.path}`)).toEqual([
			'DELETE /api/v1/organizations/org_acme/members/usr_bob',
			'DELETE /api/v1/organizations/org_acme/members/usr_bob'
		]);

		requests = [];
		const missing = await cli(['orgs', 'remove', 'Acme', 'zed@example.test']);
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain('no one in Acme has the user id or email "zed@example.test"');
		expect(writes()).toEqual([]);
	});

	it('leaves only with a confirmation, and never as the owner', async () => {
		routes['POST /api/v1/organizations/org_guild/leave'] = () => ({
			body: { organization_id: 'org_guild', user_id: 'usr_me', removed: true }
		});
		const unconfirmed = await cli(['orgs', 'leave', 'Guild']);
		expect(unconfirmed.code).toBe(1);
		expect(unconfirmed.stderr).toContain('refusing to leave without a confirmation');
		expect(writes()).toEqual([]);

		const left = await cli(['orgs', 'leave', 'Guild', '-y']);
		expect(left.code).toBe(0);
		expect(left.stdout).toContain('left Guild');
		expect(writes()).toEqual([
			{ method: 'POST', path: '/api/v1/organizations/org_guild/leave', body: null }
		]);

		requests = [];
		const owner = await cli(['orgs', 'leave', 'Acme', '--yes']);
		expect(owner.code).toBe(1);
		expect(owner.stderr).toContain('you own Acme: transfer ownership to a manager first');
		expect(owner.stderr).toContain(`${baseUrl}/organizations/org_acme`);
		expect(writes()).toEqual([]);
	});

	it.each([
		['transfer', 'transferring Acme'],
		['delete', 'deleting Acme']
	])('%s points at the browser and exits 1 without writing', async (cmd, what) => {
		const result = await cli(['orgs', cmd, 'Acme']);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(`${what} needs your browser session`);
		expect(result.stderr).toContain(`${baseUrl}/organizations/org_acme`);
		expect(writes()).toEqual([]);
	});
});

describe('projects and organizations', () => {
	it('prints the move preview and never POSTs the move', async () => {
		routes['GET /api/v1/projects/prj_3/move'] = () => ({ body: preview });
		const result = await cli(['projects', 'move', 'Docs', 'Tom']);
		expect(result.code).toBe(0);
		expect(requests.some((r) => r.path === '/api/v1/projects/prj_3/move?to=org_usr_me')).toBe(true);
		expect(writes()).toEqual([]);
		const out = result.stdout;
		expect(out).toContain('Move "Docs" from Acme to Tom (personal)');
		expect(out).toContain('gain access: nobody');
		expect(out).toContain('lose access: Bob');
		expect(out).toContain(
			'Engineering [wf_eng] — organization-level here: a copy is brought into the project'
		);
		expect(out).toContain('(3 issues, 1 schedule)');
		expect(out).toContain('Standard [wf_std] — system workflow, stays available (1 issue)');
		expect(out).toContain('Docs flow [wf_own] — moves with the project (2 issues)');
		expect(out).toContain('bug — the destination’s label of the same name is used');
		expect(out).toContain('docs — copied to the project');
		expect(out).toContain('organization context the project stops reading:');
		expect(out).toContain('prompt "house-style" [ctx_1]');
		expect(out).toContain('blockers (the move cannot be confirmed until these are cleared):');
		expect(out).toContain('Run arun_1 is running; hold the issue [run_active]');
		expect(out).toContain(`open ${baseUrl}/projects/prj_3 in the browser and choose Move`);

		const json = await cli(['projects', 'move', 'Docs', 'Tom', '--json']);
		expect(json.code).toBe(0);
		expect(JSON.parse(json.stdout)).toEqual(preview);
		expect(writes()).toEqual([]);
	});

	it('share points at the browser without writing', async () => {
		const result = await cli(['projects', 'share', 'prj_1']);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			`sharing a project needs your browser session (API keys are refused): open ${baseUrl}/projects/prj_1 and choose Share`
		);
		const shared = await cli(['projects', 'share', 'Docs']);
		expect(shared.stderr).toContain('already in the shared organization Acme');
		expect(writes()).toEqual([]);
	});

	it('creates a project in --org', async () => {
		routes['POST /api/v1/projects'] = (body) => ({
			status: 201,
			body: { ...project('prj_9', String(body?.name), acme) }
		});
		const result = await cli(['projects', 'create', 'Ops', '--org', 'Acme', '--no-prompt']);
		expect(result.code).toBe(0);
		expect(writes()[0].body).toEqual({
			organization_id: 'org_acme',
			name: 'Ops',
			initial_prompt: ''
		});
		expect(result.stdout).toContain('created project "Ops" (prj_9) in Acme');
	});

	it('lists projects with their organization, filtered by --org', async () => {
		const all = await cli(['projects', 'list']);
		expect(all.stdout).toMatch(/^NAME\s+ORGANIZATION\s+ISSUES\s+ID\s+CREATED$/m);
		expect(all.stdout).toMatch(/Site\s+Tom \(personal\)\s+0\s+prj_1/);
		expect(all.stdout).toMatch(/Site\s+Acme\s+0\s+prj_2/);
		const acmeOnly = await cli(['projects', 'list', '--org', 'Acme', '--json']);
		expect(JSON.parse(acmeOnly.stdout).items.map((p: { id: string }) => p.id)).toEqual([
			'prj_2',
			'prj_3'
		]);
	});

	it('lists each organization for an ambiguous project name, and --org chooses', async () => {
		const ambiguous = await cli(['projects', 'show', 'Site']);
		expect(ambiguous.code).toBe(1);
		expect(ambiguous.stderr).toContain(
			'project name "Site" is ambiguous; use an id: prj_1 (Tom (personal) [org_usr_me]), prj_2 (Acme [org_acme])'
		);
		const chosen = await cli(['projects', 'show', 'Site', '--org', 'Acme']);
		expect(chosen.code).toBe(0);
		expect(chosen.stdout).toContain('Site  [prj_2]');
		expect(chosen.stdout).toContain('organization: Acme [org_acme]');
	});
});

describe('--org on library creates', () => {
	it('context create --org refuses a project or issue item before any request', async () => {
		for (const scope of [
			['--project', 'Docs'],
			['--issue', 'Docs/1']
		]) {
			const result = await cli([
				'context',
				'create',
				'-k',
				'prompt',
				'-n',
				'style',
				'--body',
				'x',
				'--org',
				'Acme',
				...scope
			]);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain('--org is for items with no --project or --issue');
		}
		expect(requests).toEqual([]);
	});

	it('context create --org sends organization_id', async () => {
		routes['POST /api/v1/context'] = (body) => ({ status: 201, body: { id: 'ctx_9', ...body } });
		const result = await cli([
			'context',
			'create',
			'-k',
			'prompt',
			'-n',
			'style',
			'--body',
			'Be brief.',
			'--org',
			'Acme',
			'--json'
		]);
		expect(result.code).toBe(0);
		expect(writes()[0].body).toMatchObject({
			kind: 'prompt',
			name: 'style',
			body: 'Be brief.',
			organization_id: 'org_acme'
		});
	});

	it('labels create --org sends organization_id', async () => {
		routes['POST /api/v1/labels'] = (body) => ({
			status: 201,
			body: { id: 'lbl_9', color: 'red', description: '', ...body }
		});
		const result = await cli(['labels', 'create', 'urgent', '--org', 'org_acme']);
		expect(result.code).toBe(0);
		expect(writes()[0].body).toMatchObject({ name: 'urgent', organization_id: 'org_acme' });
		expect(result.stdout).toContain('created label "urgent" (red) in Acme');
	});

	it('workflows create --org sends organization_id', async () => {
		routes['POST /api/v1/workflows'] = (body) => ({ status: 201, body: { id: 'wf_9', ...body } });
		const definition = JSON.stringify({
			name: 'Review',
			initial_state: 'Draft',
			states: [{ name: 'Draft', category: 'active', prompt: 'Draft it.' }],
			transitions: []
		});
		const result = await cli(['workflows', 'create', definition, '--org', 'Acme', '--json']);
		expect(result.code).toBe(0);
		expect(writes()[0].body).toMatchObject({ name: 'Review', organization_id: 'org_acme' });
	});
});

describe('api-keys organizations scope', () => {
	beforeEach(() => {
		routes['POST /api/v1/api-keys'] = (body) => ({
			status: 201,
			body: {
				id: 'key_1',
				name: body?.name,
				key: 'tines_secret',
				key_prefix: 'tines_se',
				created_at: 0,
				last_used_at: null,
				revoked_at: null,
				permissions: body?.permissions,
				effective_permissions: body?.permissions
			}
		});
	});

	const sent = () => writes()[0].body?.permissions as Record<string, unknown>;

	it('defaults to your personal organization only', async () => {
		const result = await cli(['api-keys', 'create', 'script', '--preset', 'read-only']);
		expect(result.code).toBe(0);
		expect(sent()).toMatchObject({ version: 2, organizations: ['org_usr_me'] });
		expect(result.stdout).toMatch(/ORGANIZATIONS/);
		expect(result.stdout).toMatch(/key_1\s+script\s+Tom\s+read:all/);
	});

	it('takes repeatable --org by name or id', async () => {
		const result = await cli([
			'api-keys',
			'create',
			'ci',
			'--preset',
			'full',
			'--org',
			'Guild',
			'--org',
			'org_acme'
		]);
		expect(result.code).toBe(0);
		expect(sent()).toMatchObject({ version: 2, organizations: ['org_acme', 'org_guild'] });
		expect(result.stdout).toMatch(/key_1\s+ci\s+Acme,Guild\s+delete:all/);
	});

	it('takes --all-orgs, and refuses it beside --org', async () => {
		const result = await cli(['api-keys', 'create', 'runner', '--preset', 'full', '--all-orgs']);
		expect(result.code).toBe(0);
		expect(sent()).toMatchObject({ version: 2, organizations: 'all' });
		expect(result.stdout).toContain('all (including ones joined later)');

		requests = [];
		const both = await cli([
			'api-keys',
			'create',
			'x',
			'--preset',
			'full',
			'--all-orgs',
			'--org',
			'Acme'
		]);
		expect(both.code).toBe(1);
		expect(both.stderr).toContain('pass only one of --org or --all-orgs');
		expect(writes()).toEqual([]);
	});

	it('shows a version-1 key as personal only', async () => {
		const v1 = {
			id: 'key_old',
			name: 'old',
			key_prefix: 'tines_ol',
			created_at: 0,
			last_used_at: null,
			revoked_at: null,
			permissions: {
				version: 1,
				projects: { access: 'read', scope: 'all' },
				workspace: 'read',
				control_plane: 'read'
			}
		};
		routes['GET /api/v1/api-keys'] = () => ({ body: { items: [v1], next_cursor: null } });
		const result = await cli(['api-keys', 'list']);
		expect(result.code).toBe(0);
		expect(result.stdout).toMatch(/key_old\s+old\s+personal only\s+read:all/);
	});
});
