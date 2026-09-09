import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CLI_BIN, NODE } from './test-bin.js';

const items = [
	{
		id: 'blank',
		name: 'Blank',
		description: 'Empty',
		inputs: [],
		conventions_template: null,
		creates: { workflows: [], context: [], first_issue: null }
	},
	{
		id: 'code',
		name: 'Code',
		description: 'Code work',
		inputs: [
			{ key: 'repo_url', label: 'Repo', required: true },
			{ key: 'repo_branch', label: 'Branch', required: false }
		],
		conventions_template: 'Test:',
		creates: {
			workflows: [{ name: 'Code change', default: true, states: ['Backlog', 'In progress'] }],
			context: [{ kind: 'repo', name: '{{ repo_name }}' }],
			first_issue: { title: 'Find a bug', workflow: 'Code change', state: 'In progress' }
		}
	},
	{
		id: 'plan',
		name: 'Plan',
		description: 'Plan work',
		inputs: [{ key: 'brief', label: 'Brief', required: true, max: 10_000 }],
		conventions_template: 'Brief: {{ brief }}',
		creates: {
			workflows: [{ name: 'Idea', default: true, states: ['New', 'Proposed'] }],
			context: [{ kind: 'prompt', name: 'planning-guide' }],
			first_issue: { title: 'Scout {{ brief }}', workflow: 'Scout', state: 'Scouting' }
		}
	}
];

let server: Server;
let baseUrl: string;
let requests: { method: string; path: string; body: unknown }[] = [];

beforeAll(async () => {
	server = createServer((req, res) => {
		let raw = '';
		req.on('data', (chunk) => (raw += chunk));
		req.on('end', () => {
			requests.push({
				method: req.method ?? '',
				path: req.url ?? '',
				body: raw ? JSON.parse(raw) : null
			});
			res.writeHead(req.url === '/api/v1/projects' ? 201 : 200, {
				'content-type': 'application/json'
			});
			if (req.url === '/api/v1/projects/starters') return res.end(JSON.stringify({ items }));
			res.end(
				JSON.stringify({
					id: 'prj_1',
					name: 'Weekend',
					starter: {
						id: 'plan',
						workflows: [{ id: 'wf_real', name: 'Idea (Weekend)', reused: false }],
						context: [{ id: 'ctx_1', kind: 'prompt', name: 'planning-guide' }],
						first_issue: { id: 'iss_1', number: 1, ref: 'Weekend/1', state_name: 'Scouting' }
					}
				})
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => (requests = []));

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(
			NODE,
			[CLI_BIN, ...args],
			{ env: { ...process.env, TINES_API_URL: baseUrl, TINES_API_KEY: 'test' } },
			(err, stdout, stderr) => {
				const code = (err as { code?: number } | null)?.code ?? 0;
				resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr });
			}
		);
	});
}

describe('projects starters', () => {
	it('discovers exact metadata as JSON', async () => {
		const result = await cli(['projects', 'starters', '--json']);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({ items });
		expect(requests.map((request) => request.path)).toEqual(['/api/v1/projects/starters']);
	});

	it('creates Plan through metadata and leaves its template prompt implicit', async () => {
		const result = await cli([
			'projects',
			'create',
			'Weekend',
			'--starter',
			'plan',
			'--brief',
			'line one\nline two',
			'--json'
		]);
		expect(result.code).toBe(0);
		expect(requests.at(-1)).toEqual({
			method: 'POST',
			path: '/api/v1/projects',
			body: { name: 'Weekend', starter: { id: 'plan', inputs: { brief: 'line one\nline two' } } }
		});
	});

	it('sends explicit no-prompt and prints truthful next steps', async () => {
		const result = await cli([
			'projects',
			'create',
			'Weekend',
			'--starter',
			'plan',
			'--brief',
			'day out',
			'--no-prompt'
		]);
		expect(result.code).toBe(0);
		expect(requests.at(-1)?.body).toMatchObject({ initial_prompt: '' });
		expect(result.stdout).toContain('Idea (Weekend) (wf_real)');
		expect(result.stdout).toContain('Weekend/1');
		expect(result.stdout).toContain(`${baseUrl}/agents`);
	});

	it.each([
		[['projects', 'create', 'X', '--brief', 'x'], 'require --starter'],
		[['projects', 'create', 'X', '--starter', 'plan', '--brief', ' '], 'requires --brief'],
		[['projects', 'create', 'X', '--starter', 'plan', '--brief', 'x', '--repo', 'url'], 'not used'],
		[
			['projects', 'create', 'X', '--starter', 'plan', '--brief', 'x', '--default-workflow', 'wf'],
			'sets the default workflow'
		],
		[['projects', 'create', 'X', '--starter', 'unknown'], 'unknown starter']
	] as const)('rejects invalid flags without POST: %s', async (args, message) => {
		const result = await cli([...args]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(message);
		expect(requests.some((request) => request.method === 'POST')).toBe(false);
	});
});
