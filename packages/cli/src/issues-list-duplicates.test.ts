import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CLI_BIN, NODE } from './test-bin.js';

function issue(number: number, duplicate = false) {
	return {
		id: `iss_${number}`,
		project_name: 'Stub',
		number,
		title: duplicate ? 'Duplicate issue' : 'Ordinary issue',
		description: '',
		effective_state: { name: 'Backlog', category: 'active' },
		last_activity_at: 0,
		open_blockers: [],
		labels: [],
		duplicate_of: duplicate ? { project_name: 'Stub', number: 1, title: 'Ordinary issue' } : null
	};
}

let server: Server;
let baseUrl: string;
const requests: URL[] = [];

beforeAll(async () => {
	server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		requests.push(url);
		res.writeHead(200, { 'content-type': 'application/json' });
		if (url.pathname === '/api/v1/projects') {
			res.end(JSON.stringify({ items: [{ id: 'prj_1', name: 'Stub' }], next_cursor: null }));
			return;
		}
		if (url.pathname === '/api/v1/projects/prj_1/issues/2') {
			res.end(JSON.stringify({ ...issue(2, true), canonical: 'direct detail response' }));
			return;
		}
		if (url.pathname === '/api/v1/issues') {
			if (url.searchParams.get('q') === 'none') {
				res.end(JSON.stringify({ items: [], next_cursor: null }));
				return;
			}
			const showing = url.searchParams.get('hide_duplicates') === 'false';
			const cursor = url.searchParams.get('cursor');
			if (showing && url.searchParams.has('limit') && cursor === null) {
				res.end(JSON.stringify({ items: [issue(1)], next_cursor: 'next' }));
				return;
			}
			res.end(
				JSON.stringify({
					items: showing ? (cursor ? [issue(2, true)] : [issue(1), issue(2, true)]) : [issue(1)],
					next_cursor: null
				})
			);
			return;
		}
		res.statusCode = 404;
		res.end(JSON.stringify({ error: { code: 'not_found', message: 'not found' } }));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => requests.splice(0));

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

describe('issues list duplicate visibility', () => {
	it('hides duplicates by default and keeps --all independent', async () => {
		const result = await cli(['issues', 'list', '--all', '--json']);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).items.map((item: { id: string }) => item.id)).toEqual([
			'iss_1'
		]);
		expect(requests[0].searchParams.get('hide_duplicates')).toBe('true');
		expect(requests[0].searchParams.get('hide_done')).toBe('false');
	});

	it('includes duplicates in JSON and preserves the dup table marker', async () => {
		const json = await cli(['issues', 'list', '--show-duplicates', '--json']);
		expect(JSON.parse(json.stdout).items.map((item: { id: string }) => item.id)).toEqual([
			'iss_1',
			'iss_2'
		]);
		expect(requests[0].searchParams.get('hide_duplicates')).toBe('false');

		requests.splice(0);
		const table = await cli(['issues', 'list', '--show-duplicates']);
		expect(table.stdout).toContain('Duplicate issue');
		expect(table.stdout).toContain('dup');
	});

	it('sends the inclusion filter on every --all-pages request', async () => {
		const result = await cli([
			'issues',
			'list',
			'--show-duplicates',
			'--all-pages',
			'--limit',
			'1',
			'--json'
		]);
		expect(result.code).toBe(0);
		expect(requests).toHaveLength(2);
		expect(requests.every((url) => url.searchParams.get('hide_duplicates') === 'false')).toBe(true);
	});

	it('keeps empty output based on the filtered response', async () => {
		const result = await cli(['issues', 'list', '--search', 'none']);
		expect(result.stdout.trim()).toBe('no issues');
	});

	it('shows a duplicate through the direct detail route without listing issues', async () => {
		const result = await cli(['issues', 'show', 'Stub/2', '--json']);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			id: 'iss_2',
			canonical: 'direct detail response'
		});
		expect(requests.map((url) => url.pathname)).toEqual([
			'/api/v1/projects',
			'/api/v1/projects/prj_1/issues/2'
		]);
	});
});
