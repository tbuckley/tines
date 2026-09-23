import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_BIN, NODE } from './test-bin.js';

const project = { id: 'prj_1', name: 'demo' };
const issue = (number: number) => ({
	id: `iss_${number}`,
	project_id: project.id,
	project_name: project.name,
	number,
	title: `Issue ${number}`,
	state: { id: 'open', name: 'Open', category: 'active' },
	effective_state: { id: 'open', name: 'Open', category: 'active' },
	links: { blocked_by: [], blocks: [], duplicate_of: null, duplicated_by: [] },
	open_blockers: [],
	duplicate_of: null,
	labels: [],
	allowed_transitions: [],
	comments: []
});

let server: Server;
let baseUrl: string;
const createBodies: Record<string, unknown>[] = [];

beforeAll(async () => {
	server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		res.setHeader('content-type', 'application/json');
		if (url.pathname === '/api/v1/projects')
			return res.end(JSON.stringify({ items: [project], next_cursor: null }));
		const match = url.pathname.match(/^\/api\/v1\/projects\/prj_1\/issues\/(\d+)$/);
		if (match) return res.end(JSON.stringify(issue(Number(match[1]))));
		if (req.method === 'POST' && url.pathname === '/api/v1/projects/prj_1/issues') {
			let raw = '';
			req.on('data', (chunk) => (raw += chunk));
			return req.on('end', () => {
				createBodies.push(JSON.parse(raw) as Record<string, unknown>);
				res.statusCode = 201;
				res.end(JSON.stringify(issue(9)));
			});
		}
		if (req.method === 'POST' && /^\/api\/v1\/issues\/iss_[12]\/links$/.test(url.pathname)) {
			let raw = '';
			req.on('data', (chunk) => (raw += chunk));
			return req.on('end', () => {
				const kind = (JSON.parse(raw) as { kind: string }).kind;
				res.statusCode = 422;
				res.end(
					JSON.stringify({
						error:
							kind === 'duplicate_of'
								? {
										code: 'already_duplicate',
										message: 'demo/1 is already a duplicate of demo/3 — remove that link first',
										details: { duplicate_of: { project_name: 'demo', number: 3, title: 'Issue 3' } }
									}
								: {
										code: 'link_cycle',
										message: 'Adding this link would create a cycle: demo/1 → demo/2 → demo/1',
										details: { path: [issue(1), issue(2), issue(1)] }
									}
					})
				);
			});
		}
		res.statusCode = 404;
		res.end(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(
			NODE,
			[CLI_BIN, ...args],
			{ env: { ...process.env, TINES_API_URL: baseUrl, TINES_API_KEY: 'test' }, timeout: 60_000 },
			(error, stdout, stderr) =>
				resolve({
					code:
						typeof (error as { code?: unknown } | null)?.code === 'number'
							? (error as { code: number }).code
							: 0,
					stdout,
					stderr
				})
		);
	});
}

describe('issue-link CLI diagnostics', () => {
	it('resolves repeatable create relationship refs and preserves their order', async () => {
		createBodies.length = 0;
		const result = await cli([
			'issues',
			'create',
			'demo',
			'--title',
			'Linked',
			'--blocked-by',
			'demo/2',
			'--blocked-by',
			'demo/2',
			'--blocks',
			'demo/3',
			'--duplicate-of',
			'demo/4',
			'--json'
		]);
		expect(result.code).toBe(0);
		expect(createBodies).toHaveLength(1);
		expect(createBodies[0]).toMatchObject({
			title: 'Linked',
			blocked_by: ['iss_2', 'iss_2'],
			blocks: ['iss_3'],
			duplicate_of: 'iss_4'
		});
	});

	it('omits relationship properties when create flags are absent', async () => {
		createBodies.length = 0;
		const result = await cli(['issues', 'create', 'demo', '--title', 'Plain', '--json']);
		expect(result.code).toBe(0);
		expect(createBodies).toHaveLength(1);
		expect(createBodies[0]).not.toHaveProperty('blocked_by');
		expect(createBodies[0]).not.toHaveProperty('blocks');
		expect(createBodies[0]).not.toHaveProperty('duplicate_of');
	});

	it('prints the server-provided canonical cycle path and no success line', async () => {
		const result = await cli(['issues', 'block', 'demo/1', 'demo/2']);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('demo/1 → demo/2 → demo/1');
		expect(result.stderr).toContain('(link_cycle)');
		expect(result.stdout).not.toContain('now blocks');
	});

	it('preserves the second-canonical diagnostic', async () => {
		const result = await cli(['issues', 'duplicate', 'demo/1', 'demo/2']);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('already a duplicate of demo/3');
		expect(result.stderr).toContain('(already_duplicate)');
		expect(result.stdout).not.toContain('is now a duplicate');
	});
});
