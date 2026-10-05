/**
 * `tines projects guidance list|include|exclude` against a stub API: each
 * resolves the project by name, reaches its endpoint, and prints the receipt.
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
	name: 'Paris',
	description: '',
	default_workflow_id: null,
	created_at: 0,
	updated_at: 0,
	issue_count: 1,
	archived_at: null
};
const item = {
	item_id: 'ctx_1',
	kind: 'prompt',
	name: 'conventions',
	scope_label: 'global',
	version: 1,
	revision: 1,
	created_at: 0
};

let server: Server;
let baseUrl: string;
let included: (typeof item)[] = [];
const seen: { method: string; path: string; body: string }[] = [];

beforeAll(async () => {
	server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		let body = '';
		req.on('data', (chunk) => (body += chunk));
		req.on('end', () => {
			seen.push({ method: req.method ?? '', path: url.pathname, body });
			const send = (payload: unknown) => {
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify(payload));
			};
			if (url.pathname === '/api/v1/projects') return send({ items: [project], next_cursor: null });
			if (url.pathname === '/api/v1/projects/prj_1/guidance-inclusions') {
				if (req.method === 'POST') {
					included = [item];
					return send(item);
				}
				return send({ items: included, next_cursor: null });
			}
			if (url.pathname === '/api/v1/projects/prj_1/guidance-inclusions/ctx_1') {
				included = [];
				return send(item);
			}
			res.writeHead(404, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: { code: 'not_found', message: 'no' } }));
		});
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

describe('tines projects guidance', () => {
	it('lists nothing before anything is included', async () => {
		const res = await cli(['projects', 'guidance', 'list', 'Paris']);
		expect(res.code).toBe(0);
		expect(res.stdout.trim()).toBe('No library items included');
	}, 60_000);

	it('includes an item and prints the sharing receipt', async () => {
		seen.length = 0;
		const res = await cli(['projects', 'guidance', 'include', 'Paris', 'ctx_1']);
		expect(res.stderr).toBe('');
		expect(res.code).toBe(0);
		expect(seen.at(-1)).toMatchObject({
			method: 'POST',
			path: '/api/v1/projects/prj_1/guidance-inclusions'
		});
		expect(JSON.parse(seen.at(-1)!.body)).toEqual({ item_id: 'ctx_1' });
		expect(res.stdout.trim()).toBe(
			"Included prompt conventions in Paris's shared guidance. Everyone in this project and their agents can read it; future edits stay shared."
		);
	}, 60_000);

	it('lists the included item, and --json prints the envelope', async () => {
		const res = await cli(['projects', 'guidance', 'list', 'Paris']);
		expect(res.code).toBe(0);
		expect(res.stdout).toMatch(/prompt\s+conventions\s+global\s+ctx_1/);
		const json = await cli(['projects', 'guidance', 'list', 'Paris', '--json']);
		expect(JSON.parse(json.stdout)).toEqual({ items: [item], next_cursor: null });
	}, 60_000);

	it('excludes an item', async () => {
		seen.length = 0;
		const res = await cli(['projects', 'guidance', 'exclude', 'Paris', 'ctx_1']);
		expect(res.code).toBe(0);
		expect(seen.at(-1)).toMatchObject({
			method: 'DELETE',
			path: '/api/v1/projects/prj_1/guidance-inclusions/ctx_1'
		});
		expect(res.stdout.trim()).toBe("Removed prompt conventions from Paris's shared guidance.");
	}, 60_000);
});
