import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const tsx = join(here, '..', 'node_modules', '.bin', 'tsx');
const entry = join(here, 'index.ts');

const dir = mkdtempSync(join(tmpdir(), 'tines-attach-'));
const prdPath = join(dir, 'prd.md');
writeFileSync(prdPath, '# The PRD\n');

const FIX = 'tines issues artifacts attach Stub/1 prd --text @prd.md';

/** The gated transition the stub issue offers: `prd` must be text/markdown. */
const requirement = {
	artifact: 'prd',
	type: 'text',
	content_type: 'text/markdown',
	description: 'The product requirements',
	status: 'missing',
	current_type: null,
	current_version: null,
	fix: FIX
};

const issue = {
	id: 'i1',
	project_name: 'Stub',
	number: 1,
	title: 'a gated issue',
	description: '',
	state: { name: 'Design', category: 'active' },
	effective_state: { name: 'Design', category: 'active' },
	duplicate_of: null,
	project_archived_at: null,
	labels: [],
	updated_at: 0,
	workflow: { name: 'Engineering' },
	comments: [],
	allowed_transitions: [
		{
			transition_id: 't1',
			name: 'Submit for review',
			to_state: { name: 'Review', category: 'active' },
			requires: [requirement]
		}
	],
	links: { blocked_by: [], blocks: [], duplicate_of: null, duplicated_by: [] },
	context_summary: {}
};

const textArtifact = {
	id: 'a1',
	name: 'prd',
	artifact_type: 'text',
	description: '',
	issue_id: 'i1',
	version_count: 1,
	fresh: true,
	created_at: 0,
	updated_at: 0,
	current_version: {
		version: 1,
		created_at: 0,
		filename: 'prd.md',
		content_type: 'text/markdown',
		size_bytes: 10,
		file_count: null,
		url: null,
		title: null,
		pr_repo_url: null,
		pr_number: null,
		reaffirmed_from: null,
		actor: { kind: 'user', id: 'u1', label: 'Tester' }
	}
};

const fileArtifact = {
	...textArtifact,
	artifact_type: 'file',
	current_version: { ...textArtifact.current_version, content_type: 'text/markdown' }
};

let server: Server;
let baseUrl: string;
/** Every request the CLI made, as `METHOD path`, so a refusal can be proved offline. */
let seen: string[] = [];
/** What `PUT …/artifacts/prd` is answered with, and what body it received. */
let putBodies: unknown[] = [];
let listItems: unknown[] = [];

beforeAll(async () => {
	server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		seen.push(`${req.method} ${url.pathname}`);
		const json = (value: unknown) => {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify(value));
		};
		if (url.pathname === '/api/v1/projects') {
			return json({ items: [{ id: 'p1', name: 'Stub', archived_at: null }], next_cursor: null });
		}
		if (url.pathname === '/api/v1/projects/p1/issues/1') return json(issue);
		if (url.pathname === '/api/v1/issues/i1/artifacts') return json({ items: listItems });
		if (url.pathname === '/api/v1/issues/i1/artifacts/prd/file') {
			req.resume();
			return req.on('end', () => json(fileArtifact));
		}
		if (url.pathname === '/api/v1/issues/i1/artifacts/prd') {
			const chunks: Buffer[] = [];
			req.on('data', (c) => chunks.push(c as Buffer));
			return req.on('end', () => {
				const raw = Buffer.concat(chunks).toString('utf8');
				if (raw) putBodies.push(JSON.parse(raw));
				json(textArtifact);
			});
		}
		res.writeHead(404, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: 'not_found' }));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
	seen = [];
	putBodies = [];
	listItems = [];
});

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

/** The two reads `resolveIssue` makes; anything after them is a write. */
const READS = ['GET /api/v1/projects', 'GET /api/v1/projects/p1/issues/1'];

describe('artifacts attach against a text gate', () => {
	it('types a positional path from the gate and says which transition it satisfies', async () => {
		const res = await cli(['issues', 'artifacts', 'attach', 'Stub/1', 'prd', prdPath]);
		expect(res.stderr).toBe('');
		expect(res.code).toBe(0);
		expect(seen).toEqual([...READS, 'PUT /api/v1/issues/i1/artifacts/prd']);
		expect(putBodies).toEqual([
			{ type: 'text', content: '# The PRD\n', content_type: 'text/markdown' }
		]);
		expect(res.stdout).toContain(
			'attached "prd" v1 (text, text/markdown) to Stub/1 — fresh; satisfies "Submit for review"'
		);
	});

	it('refuses --file before any network write, printing the gate fix verbatim', async () => {
		const res = await cli(['issues', 'artifacts', 'attach', 'Stub/1', 'prd', '--file', prdPath]);
		expect(res.code).toBe(1);
		// The whole point: the two reads happened, nothing was written.
		expect(seen).toEqual(READS);
		expect(res.stderr).toContain(
			'"prd" is gated by "Submit for review" as text (text/markdown); --file would create a file artifact that can never satisfy it.'
		);
		expect(res.stderr).toContain(`Use: ${FIX}`);
		expect(res.stderr).toContain('--ignore-gates');
	});

	it('--ignore-gates attaches the flagged type anyway, and says it does not satisfy the gate', async () => {
		const res = await cli([
			'issues',
			'artifacts',
			'attach',
			'Stub/1',
			'prd',
			'--file',
			prdPath,
			'--ignore-gates'
		]);
		expect(res.code).toBe(0);
		expect(seen).toContain('PUT /api/v1/issues/i1/artifacts/prd/file');
		expect(res.stdout).toContain('does not satisfy "Submit for review" (wants text)');
	});

	it('refuses a positional alongside a flag before reaching the network', async () => {
		const res = await cli([
			'issues',
			'artifacts',
			'attach',
			'Stub/1',
			'prd',
			prdPath,
			'--text',
			'x'
		]);
		expect(res.code).toBe(1);
		expect(seen).toEqual([]);
		expect(res.stderr).toContain('pass the source once');
	});
});

describe('the gate elsewhere in the CLI', () => {
	it('issues show lists each requirement with its status and fix', async () => {
		const res = await cli(['issues', 'show', 'Stub/1']);
		expect(res.code).toBe(0);
		expect(res.stdout).toContain(
			'"Submit for review" requires artifact "prd" (text, text/markdown): missing — The product requirements'
		);
		expect(res.stdout).toContain(`fix: ${FIX}`);
	});

	it('artifacts list marks a row the gate rejects', async () => {
		listItems = [{ ...textArtifact, artifact_type: 'link' }];
		const res = await cli(['issues', 'artifacts', 'list', 'Stub/1']);
		expect(res.stdout).toContain('GATE');
		expect(res.stdout).toContain('wants text');
	});

	it('leaves the GATE column out when nothing is rejected', async () => {
		listItems = [textArtifact];
		const res = await cli(['issues', 'artifacts', 'list', 'Stub/1']);
		expect(res.stdout).not.toContain('GATE');
	});
});
