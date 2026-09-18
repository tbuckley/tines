/**
 * `tines issues dispatch` against a stub API: that the explainer's remedies
 * reach the terminal. Text mode renders a check's `action.cli` as a fourth
 * `fix:` column and nothing for an href-only remedy (a link is useless
 * without an origin here); `--json` carries the whole `action` through.
 */
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const tsx = join(here, '..', 'node_modules', '.bin', 'tsx');
const entry = join(here, 'index.ts');

const project = {
	id: 'prj_1',
	name: 'Tines',
	description: '',
	default_workflow_id: 'wf_1',
	created_at: 0,
	updated_at: 0,
	issue_count: 1,
	archived_at: null
};

const issue = { id: 'iss_1', number: 12, title: 'Ship it', project_name: 'Tines' };

/** One of each shape: cli-only, cli+href, href-only, and a passing check. */
const explainer = {
	eligible: false,
	checks: [
		{
			name: 'automation_enabled',
			ok: false,
			detail: 'the kill switch is off',
			action: { label: 'Turn automation on', href: '/agents', cli: 'tines supervisor enable' }
		},
		{
			name: 'routed',
			ok: false,
			detail: 'no routing rule matches this issue',
			action: {
				label: 'Add a routing rule',
				href: '/agents#routing',
				cli: 'tines routing set <runner>'
			}
		},
		{
			name: 'ready',
			ok: false,
			detail: 'blocked by Tines/9',
			action: { label: 'Tines/#9', href: '/issues/Tines/9' }
		},
		{ name: 'no_active_run', ok: true, detail: 'no run in flight' }
	],
	pin: null,
	matched_rule: null,
	ambiguous_rules: [],
	targets: [],
	parked: false,
	attempt_count: 0,
	attempt_limit: 3,
	active_run: null,
	queue_position: null,
	verdict: 'Not dispatching: automation is off'
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
	server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		const send = (body: unknown) => {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify(body));
		};
		if (url.pathname === '/api/v1/projects') return send({ items: [project], next_cursor: null });
		if (url.pathname === '/api/v1/projects/prj_1/issues/12') return send(issue);
		if (url.pathname === '/api/v1/issues/iss_1/dispatch') return send(explainer);
		res.writeHead(404, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: { code: 'not_found', message: 'no' } }));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

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

describe('tines issues dispatch', () => {
	it('prints each remedy command in a fix: column beside its failing check', async () => {
		const res = await cli(['issues', 'dispatch', 'Tines/12']);
		expect(res.stderr).toBe('');
		expect(res.code).toBe(0);

		const row = (name: string) =>
			res.stdout.split('\n').find((l) => l.includes(name.replaceAll('_', ' ')))!;
		expect(row('automation_enabled')).toContain('fix: tines supervisor enable');
		expect(row('routed')).toContain('fix: tines routing set <runner>');
		// href-only: there is no origin to click here, so the column stays bare.
		expect(row('ready')).toContain('blocked by Tines/9');
		expect(row('ready')).not.toContain('fix:');
		// A passing check has no remedy at all.
		expect(row('no active run')).not.toContain('fix:');
	}, 60_000);

	it('--json carries the whole action, href included', async () => {
		const res = await cli(['issues', 'dispatch', 'Tines/12', '--json']);
		expect(res.code).toBe(0);
		const parsed = JSON.parse(res.stdout) as typeof explainer;
		expect(parsed.checks.find((c) => c.name === 'automation_enabled')?.action).toEqual({
			label: 'Turn automation on',
			href: '/agents',
			cli: 'tines supervisor enable'
		});
		expect(parsed.checks.find((c) => c.name === 'ready')?.action?.href).toBe('/issues/Tines/9');
		expect(parsed.checks.find((c) => c.name === 'no_active_run')?.action).toBeUndefined();
	}, 60_000);
});
