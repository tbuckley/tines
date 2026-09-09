import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const fixtureDir = mkdtempSync(join(tmpdir(), 'tines-project-starters-'));
const promptFile = join(fixtureDir, 'prompt.md');
const emptyPromptFile = join(fixtureDir, 'empty.md');
writeFileSync(promptFile, '# Family conventions\n\nKeep walks short.');
writeFileSync(emptyPromptFile, '');

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
			if (req.url === '/api/v1/workflows') {
				return res.end(JSON.stringify({ items: [{ id: 'wf_standard', name: 'Standard' }] }));
			}
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

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	rmSync(fixtureDir, { recursive: true, force: true });
});
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

	it('renders discovery metadata in text mode through common connection flags', async () => {
		const result = await cli(['projects', 'starters', '--url', baseUrl, '--api-key', 'override']);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('blank — Blank');
		expect(result.stdout).toContain('requires --prompt or --no-prompt when creating');
		expect(result.stdout).toContain('--repo (required)');
		expect(result.stdout).toContain('--branch (optional)');
		expect(result.stdout).toContain('workflow: Code change (default)');
		expect(result.stdout).toContain('prompt: planning-guide');
		expect(result.stdout).toContain('first issue: Scout {{ brief }} — Scouting (Scout)');
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

	it.each([
		[undefined, { repo_url: 'https://example.test/acme/site.git' }],
		['release', { repo_url: 'https://example.test/acme/site.git', repo_branch: 'release' }]
	] as const)('creates Code with branch %s in the shared request', async (branch, inputs) => {
		const args = [
			'projects',
			'create',
			'Site',
			'--starter',
			'code',
			'--repo',
			'https://example.test/acme/site.git',
			'--json'
		];
		if (branch) args.splice(-1, 0, '--branch', branch);
		const result = await cli(args);
		expect(result.code).toBe(0);
		expect(requests.at(-1)).toEqual({
			method: 'POST',
			path: '/api/v1/projects',
			body: { name: 'Site', starter: { id: 'code', inputs } }
		});
	});

	it('preserves omitted and explicit Blank creation semantics', async () => {
		const omitted = await cli(['projects', 'create', 'Empty one', '--no-prompt', '--json']);
		expect(omitted.code).toBe(0);
		expect(requests).toEqual([
			{
				method: 'POST',
				path: '/api/v1/projects',
				body: { name: 'Empty one', initial_prompt: '' }
			}
		]);

		requests = [];
		const explicit = await cli([
			'projects',
			'create',
			'Empty two',
			'--starter',
			'blank',
			'--prompt',
			'Own conventions',
			'--json'
		]);
		expect(explicit.code).toBe(0);
		expect(requests.map((request) => request.path)).toEqual([
			'/api/v1/projects/starters',
			'/api/v1/projects'
		]);
		expect(requests.at(-1)?.body).toEqual({
			name: 'Empty two',
			initial_prompt: 'Own conventions',
			starter: { id: 'blank', inputs: {} }
		});
	});

	it.each([
		[['--prompt', 'inline'], 'inline'],
		[['--prompt', `@${promptFile}`], '# Family conventions\n\nKeep walks short.'],
		[['--prompt', `@${emptyPromptFile}`], ''],
		[['--prompt', 'first', '--no-prompt'], ''],
		[['--no-prompt', '--prompt', 'last'], 'last']
	] as const)('honors explicit prompt override %j', async (flags, initialPrompt) => {
		const result = await cli([
			'projects',
			'create',
			'Weekend',
			'--starter',
			'plan',
			'--brief',
			'day out',
			...flags,
			'--json'
		]);
		expect(result.code).toBe(0);
		expect(requests.at(-1)?.body).toMatchObject({ initial_prompt: initialPrompt });
	});

	it('resolves a default workflow only when the starter does not supply one', async () => {
		const result = await cli([
			'projects',
			'create',
			'Blank workflow',
			'--no-prompt',
			'--default-workflow',
			'Standard',
			'--json'
		]);
		expect(result.code).toBe(0);
		expect(requests.map((request) => request.path)).toEqual([
			'/api/v1/workflows',
			'/api/v1/projects'
		]);
		expect(requests.at(-1)?.body).toEqual({
			name: 'Blank workflow',
			initial_prompt: '',
			default_workflow_id: 'wf_standard'
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
