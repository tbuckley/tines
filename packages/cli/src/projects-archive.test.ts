/**
 * The CLI half of project archiving, against a stub API: that `archive` and
 * `unarchive` reach their endpoints and report the drain, that `list` hides
 * archived projects until `--archived`, and — the one that bites — that every
 * ref still resolves against an archived project, which only works because
 * `resolveProject` asks for `archived=all`.
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

const ARCHIVED_AT = Date.parse('2026-09-05T09:00:00Z');

const archived = {
	id: 'prj_1',
	name: 'Paris 2026',
	description: '',
	default_workflow_id: null,
	created_at: 0,
	updated_at: 0,
	issue_count: 91,
	archived_at: ARCHIVED_AT
};
const live = { ...archived, id: 'prj_2', name: 'Tines', issue_count: 3, archived_at: null };

let server: Server;
let baseUrl: string;
/** Every request the CLI made, so the wiring can be read off it. */
const seen: { method: string; path: string; search: string }[] = [];

beforeAll(async () => {
	server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		seen.push({ method: req.method ?? '', path: url.pathname, search: url.search });
		const send = (body: unknown) => {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify(body));
		};
		if (url.pathname === '/api/v1/projects') {
			// The stub honours the filter the way the worker does.
			const filter = url.searchParams.get('archived') ?? 'false';
			const items = filter === 'all' ? [archived, live] : filter === 'true' ? [archived] : [live];
			return send({ items, next_cursor: null });
		}
		if (url.pathname === '/api/v1/projects/prj_1/archive') {
			return send({
				project: archived,
				schedules_paused: 2,
				draining_runs: [
					{ run_id: 'arun_1', runner_name: 'macbook-claude', issue_id: 'iss_1', issue_number: 12 }
				],
				issues_read_only: 91
			});
		}
		if (url.pathname === '/api/v1/projects/prj_1/unarchive') {
			return send({ project: { ...archived, archived_at: null }, schedules_resumed: 2 });
		}
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

describe('tines projects archive/unarchive', () => {
	it('resolves an archived project by name and reports the drain', async () => {
		seen.length = 0;
		const res = await cli(['projects', 'archive', 'Paris 2026']);
		expect(res.stderr).toBe('');
		expect(res.code).toBe(0);
		// Only `archived=all` finds a project the default list hides.
		expect(seen[0].search).toContain('archived=all');
		expect(seen[1]).toMatchObject({ method: 'POST', path: '/api/v1/projects/prj_1/archive' });
		expect(res.stdout.trim()).toBe(
			'archived project "Paris 2026" (prj_1): 2 schedules paused, ' +
				'1 run draining (macbook-claude on Paris 2026/12), 91 issues read-only'
		);
	}, 60_000);

	it('unarchives and says how many schedules resumed', async () => {
		const res = await cli(['projects', 'unarchive', 'prj_1']);
		expect(res.code).toBe(0);
		expect(res.stdout.trim()).toBe('unarchived project "Paris 2026" (prj_1): 2 schedules resumed');
	}, 60_000);
});

describe('tines projects list', () => {
	it('hides archived projects by default', async () => {
		seen.length = 0;
		const res = await cli(['projects', 'list']);
		expect(res.code).toBe(0);
		expect(seen[0].search).not.toContain('archived');
		expect(res.stdout).toContain('Tines');
		expect(res.stdout).not.toContain('Paris 2026');
		expect(res.stdout).not.toContain('ARCHIVED');
	}, 60_000);

	it('--archived adds them and dates them in their own column', async () => {
		seen.length = 0;
		const res = await cli(['projects', 'list', '--archived']);
		expect(res.code).toBe(0);
		expect(seen[0].search).toContain('archived=all');
		expect(res.stdout).toContain('ARCHIVED');
		expect(res.stdout).toContain('2026-09-05');
		expect(res.stdout).toContain('Paris 2026');
	}, 60_000);
});

describe('tines projects show', () => {
	it('prints the archived date for an archived project', async () => {
		const res = await cli(['projects', 'show', 'Paris 2026']);
		expect(res.code).toBe(0);
		expect(res.stdout).toContain('archived: 2026-09-05');
	}, 60_000);

	it('prints no archived line for a live one', async () => {
		const res = await cli(['projects', 'show', 'Tines']);
		expect(res.code).toBe(0);
		expect(res.stdout).not.toContain('archived:');
	}, 60_000);
});
