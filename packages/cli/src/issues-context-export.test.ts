import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CLI_BIN, NODE } from './test-bin.js';

const project = { id: 'prj_1', name: 'demo' };
const issue = {
	id: 'iss_1',
	project_id: project.id,
	project_name: project.name,
	number: 1,
	title: 'Export',
	state: { id: 'open', name: 'Open', category: 'active' },
	effective_state: { id: 'open', name: 'Open', category: 'active' },
	links: { blocked_by: [], blocks: [], duplicate_of: null, duplicated_by: [] },
	open_blockers: [],
	duplicate_of: null,
	labels: [],
	allowed_transitions: [],
	comments: []
};
const scope = {
	project_id: null,
	project_name: null,
	workflow_state_id: null,
	workflow_state_name: null,
	workflow_id: null,
	workflow_name: null,
	label_id: null,
	label_name: null,
	label_color: null,
	issue_id: null,
	issue_ref: null,
	label: 'global'
};

let skills: Array<Record<string, unknown>> = [];
let repos: Array<Record<string, unknown>> = [];
let server: Server;
let baseUrl: string;
const dirs: string[] = [];

beforeAll(async () => {
	server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		res.setHeader('content-type', 'application/json');
		if (url.pathname === '/api/v1/projects') {
			return res.end(JSON.stringify({ items: [project], next_cursor: null }));
		}
		if (url.pathname === '/api/v1/projects/prj_1/issues/1') return res.end(JSON.stringify(issue));
		if (url.pathname === '/api/v1/issues/iss_1/context') {
			return res.end(
				JSON.stringify({
					prompt: { text: 'PROMPT', parts: [] },
					skills,
					repos,
					env: [],
					overridden: [],
					conflicts: []
				})
			);
		}
		res.statusCode = 404;
		res.end(JSON.stringify({ error: { code: 'not_found', message: url.pathname } }));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
afterEach(() => {
	skills = [];
	repos = [];
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function skill(name: string, content: string) {
	return {
		item_id: `ctx_${name}`,
		name,
		description: '',
		scope,
		files: [{ path: 'SKILL.md', content }],
		file_count: 1,
		version: 1,
		inherited_from: null
	};
}

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

function outputDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'tines-context-export-'));
	dirs.push(dir);
	return dir;
}

describe('issues context --out', () => {
	it('writes the canonical tree and --force removes stale skills only', async () => {
		const dir = outputDir();
		skills = [skill('old', 'old')];
		expect((await cli(['issues', 'context', 'demo/1', '--out', dir])).code).toBe(0);
		expect(readFileSync(join(dir, '.agents/skills/old/SKILL.md'), 'utf8')).toBe('old');
		writeFileSync(join(dir, 'keep.txt'), 'keep');

		skills = [skill('new', 'new')];
		const refused = await cli(['issues', 'context', 'demo/1', '--out', dir]);
		expect(refused.code).toBe(1);
		const forced = await cli(['issues', 'context', 'demo/1', '--out', dir, '--force']);
		expect(forced.code).toBe(0);
		expect(existsSync(join(dir, '.agents/skills/old'))).toBe(false);
		expect(readFileSync(join(dir, '.agents/skills/new/SKILL.md'), 'utf8')).toBe('new');
		expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('keep');
	});

	it('rejects a repository overlap before writing prompt or skills', async () => {
		const dir = outputDir();
		repos = [{ item_id: 'ctx_repo', name: 'bad', scope, url: 'x', dir: '.agents', version: 1 }];
		const result = await cli(['issues', 'context', 'demo/1', '--out', dir]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('overlaps generated skill directory');
		expect(existsSync(join(dir, 'prompt.md'))).toBe(false);
		expect(existsSync(join(dir, '.agents'))).toBe(false);
	});
});
