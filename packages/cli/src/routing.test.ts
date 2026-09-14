import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_BIN, NODE } from './test-bin.js';

let server: Server;
let baseUrl: string;
const requests: Array<{ method: string; path: string; body: unknown }> = [];

beforeAll(async () => {
	server = createServer((req, res) => {
		let raw = '';
		req.on('data', (chunk) => (raw += chunk));
		req.on('end', () => {
			const url = new URL(req.url ?? '/', 'http://localhost');
			const body = raw ? JSON.parse(raw) : null;
			requests.push({ method: req.method ?? '', path: url.pathname, body });
			res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' });
			if (url.pathname === '/api/v1/projects') {
				res.end(
					JSON.stringify({
						items: [{ id: 'prj_demo', name: 'demo', archived_at: null }],
						next_cursor: null
					})
				);
			} else if (url.pathname === '/api/v1/routing-rules' && req.method === 'GET') {
				res.end(JSON.stringify({ items: [], next_cursor: null }));
			} else {
				res.end(
					JSON.stringify({
						id: 'rul_1',
						scope: {
							project_id: 'prj_demo',
							workflow_state_id: null,
							label_id: null,
							label: 'project demo'
						},
						targets: [{ runner_id: '*', runner_name: '*', runner_status: null, tier: 'smartest' }],
						warnings: []
					})
				);
			}
		});
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
			{ env: { ...process.env, TINES_API_URL: baseUrl, TINES_API_KEY: 'k' }, timeout: 60_000 },
			(err, stdout, stderr) =>
				resolve({
					code:
						typeof (err as { code?: number } | null)?.code === 'number'
							? Number((err as { code: number }).code)
							: 0,
					stdout,
					stderr
				})
		);
	});
}

describe('routing tier-only rules', () => {
	it('rejects global, incomplete, and mixed wildcard forms before any request', async () => {
		for (const args of [
			['routing', 'set', '*:smartest'],
			['routing', 'set', '*', '--project', 'demo'],
			['routing', 'set', '*:smartest', 'runner:balanced', '--project', 'demo']
		]) {
			requests.length = 0;
			expect((await cli(args)).code).not.toBe(0);
			expect(requests).toEqual([]);
		}
	}, 60_000);

	it('serializes a scoped wildcard without attempting runner resolution', async () => {
		requests.length = 0;
		const result = await cli(['routing', 'set', '*:smartest', '--project', 'demo']);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('created the project demo rule: 1. *:smartest');
		expect(requests.map((request) => request.path)).toEqual([
			'/api/v1/projects',
			'/api/v1/routing-rules',
			'/api/v1/routing-rules'
		]);
		expect(requests.at(-1)).toMatchObject({
			method: 'POST',
			body: {
				project_id: 'prj_demo',
				workflow_state_id: null,
				label_id: null,
				targets: [{ runner_id: '*', tier: 'smartest' }]
			}
		});
	}, 60_000);

	it('maps repeatable 1-based effort flags onto ordered targets', async () => {
		requests.length = 0;
		const result = await cli([
			'routing',
			'set',
			'*:smartest',
			'--project',
			'demo',
			'--effort',
			'1=high'
		]);
		expect(result.code).toBe(0);
		expect(requests.at(-1)).toMatchObject({
			body: { targets: [{ runner_id: '*', tier: 'smartest', effort: 'high' }] }
		});
	});

	it('rejects invalid effort indices and tokens before network access', async () => {
		for (const effort of ['0=low', '2=low', '1=High', '1=']) {
			requests.length = 0;
			expect(
				(await cli(['routing', 'set', '*:smartest', '--project', 'demo', '--effort', effort])).code
			).not.toBe(0);
			expect(requests).toEqual([]);
		}
	}, 60_000);
});
