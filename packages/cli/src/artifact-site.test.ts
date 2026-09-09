/**
 * The CLI's site surface: `artifacts site-link`, the `site:` line on `show`
 * and `attach`, and the attach-time HTML lint (Tines/272).
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CLI_BIN, NODE } from './test-bin.js';

const dir = mkdtempSync(join(tmpdir(), 'tines-site-'));
const RESPONSIVE =
	'<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><script>document.title="hi"</script>';
const goodPath = join(dir, 'good.html');
writeFileSync(goodPath, RESPONSIVE);
const badPath = join(dir, 'bad.html');
writeFileSync(badPath, '<!doctype html><script src="https://cdn.test/x.js"></script>');
const siteDir = join(dir, 'site');
mkdirSync(siteDir, { recursive: true });
writeFileSync(join(siteDir, 'index.html'), '<!doctype html><h1>no viewport here</h1>');
writeFileSync(join(siteDir, 'app.js'), 'console.log(1)');

const issue = {
	id: 'i1',
	project_name: 'Stub',
	number: 1,
	title: 'a prototype',
	description: '',
	state: { name: 'Design', category: 'active' },
	effective_state: { name: 'Design', category: 'active' },
	duplicate_of: null,
	project_archived_at: null,
	labels: [],
	updated_at: 0,
	workflow: { name: 'Engineering' },
	comments: [],
	allowed_transitions: [],
	links: { blocked_by: [], blocks: [], duplicate_of: null, duplicated_by: [] },
	context_summary: {}
};

const version = {
	version: 2,
	created_at: 0,
	filename: 'good.html',
	content_type: 'text/html',
	size_bytes: 120,
	file_count: null,
	files: null as { path: string; content_type: string; size_bytes: number }[] | null,
	url: null,
	title: null,
	pr_repo_url: null,
	pr_number: null,
	reaffirmed_from: null,
	actor: { kind: 'user', id: 'u1', label: 'Tester' }
};

const artifact = {
	id: 'a1',
	name: 'proto',
	artifact_type: 'file',
	description: '',
	issue_id: 'i1',
	version_count: 2,
	fresh: true,
	created_at: 0,
	updated_at: 0,
	current_version: version,
	versions: [{ ...version, version: 1 }, version]
};

let server: Server;
let baseUrl: string;
let seen: string[] = [];
let siteLinkBodies: unknown[] = [];
/** Swapped per test so one stub can answer for a file, a folder or a PDF. */
let served: typeof artifact = artifact;
let mode: 'sandbox-origin' | 'same-origin' = 'sandbox-origin';

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
		if (url.pathname === '/api/v1/issues/i1/artifacts/proto/site-link') {
			const chunks: Buffer[] = [];
			req.on('data', (c) => chunks.push(c as Buffer));
			return req.on('end', () => {
				const raw = Buffer.concat(chunks).toString('utf8');
				siteLinkBodies.push(raw ? JSON.parse(raw) : {});
				json({
					url: `${baseUrl}/s/tok123/`,
					version: 2,
					expires_at: Date.now() + 60 * 60 * 1000,
					mode
				});
			});
		}
		if (
			url.pathname === '/api/v1/issues/i1/artifacts/proto/file' ||
			url.pathname === '/api/v1/issues/i1/artifacts/proto/folder' ||
			url.pathname === '/api/v1/issues/i1/artifacts/proto'
		) {
			req.resume();
			return req.on('end', () => json(served));
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
	siteLinkBodies = [];
	served = artifact;
	mode = 'sandbox-origin';
});

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(
			NODE,
			[CLI_BIN, ...args],
			{ env: { ...process.env, TINES_API_URL: baseUrl, TINES_API_KEY: 'k' }, timeout: 60_000 },
			(err, stdout, stderr) => {
				const code = (err as { code?: number } | null)?.code ?? 0;
				resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr });
			}
		);
	});
}

describe('artifacts site-link', () => {
	it('prints the URL, the pinned version and the expiry', async () => {
		const res = await cli(['issues', 'artifacts', 'site-link', 'Stub/1', 'proto']);
		expect(res.code).toBe(0);
		expect(res.stdout).toContain(`${baseUrl}/s/tok123/`);
		expect(res.stdout).toContain('v2, expires in ~60 minutes');
		expect(seen).toContain('POST /api/v1/issues/i1/artifacts/proto/site-link');
		expect(siteLinkBodies).toEqual([{}]);
	});

	it('passes --version through as the pin', async () => {
		await cli(['issues', 'artifacts', 'site-link', 'Stub/1', 'proto', '--version', '1']);
		expect(siteLinkBodies).toEqual([{ version: 1 }]);
	});

	it('says when storage APIs will throw, and stays quiet otherwise', async () => {
		mode = 'same-origin';
		const fallback = await cli(['issues', 'artifacts', 'site-link', 'Stub/1', 'proto']);
		expect(fallback.stdout).toContain('same-origin sandbox');
		expect(fallback.stdout).toContain('localStorage');
		mode = 'sandbox-origin';
		const real = await cli(['issues', 'artifacts', 'site-link', 'Stub/1', 'proto']);
		expect(real.stdout).not.toContain('same-origin');
	});

	it('--json prints the raw response', async () => {
		const res = await cli(['issues', 'artifacts', 'site-link', 'Stub/1', 'proto', '--json']);
		expect(JSON.parse(res.stdout)).toMatchObject({ version: 2, mode: 'sandbox-origin' });
	});
});

describe('artifacts show', () => {
	it('names the entry and the command for a site', async () => {
		const res = await cli(['issues', 'artifacts', 'show', 'Stub/1', 'proto']);
		expect(res.stdout).toContain('site: renders live from /');
		expect(res.stdout).toContain('site-link Stub/1 proto');
	});

	it('says nothing about sites for a non-HTML artifact', async () => {
		served = {
			...artifact,
			current_version: { ...version, content_type: 'application/pdf' }
		};
		const res = await cli(['issues', 'artifacts', 'show', 'Stub/1', 'proto']);
		expect(res.stdout).not.toContain('site:');
	});
});

describe('artifacts attach', () => {
	it('lints an HTML file and points at site-link', async () => {
		const res = await cli(['issues', 'artifacts', 'attach', 'Stub/1', 'proto', badPath]);
		expect(res.code).toBe(0);
		expect(res.stdout).toContain('site: renders live');
		expect(res.stdout).toContain('warning: no viewport meta tag');
		expect(res.stdout).toContain('warning: external scripts/styles are blocked');
		expect(res.stdout).toContain('https://cdn.test/x.js');
	});

	it('warns about nothing when the HTML is self-contained and responsive', async () => {
		const res = await cli(['issues', 'artifacts', 'attach', 'Stub/1', 'proto', goodPath]);
		expect(res.stdout).toContain('site: renders live');
		expect(res.stdout).not.toContain('warning:');
	});

	it('lints a folder through its index.html', async () => {
		served = {
			...artifact,
			artifact_type: 'folder',
			current_version: {
				...version,
				content_type: null as unknown as string,
				files: [
					{ path: 'index.html', content_type: 'text/html', size_bytes: 40 },
					{ path: 'app.js', content_type: 'text/javascript', size_bytes: 14 }
				]
			}
		};
		const res = await cli([
			'issues',
			'artifacts',
			'attach',
			'Stub/1',
			'proto',
			'--folder',
			siteDir
		]);
		expect(res.stdout).toContain('warning: no viewport meta tag');
	});

	it('stays silent for a non-HTML attach', async () => {
		const mdPath = join(dir, 'notes.md');
		writeFileSync(mdPath, '# notes\n');
		const res = await cli(['issues', 'artifacts', 'attach', 'Stub/1', 'proto', mdPath]);
		expect(res.stdout).not.toContain('site:');
		expect(res.stdout).not.toContain('warning:');
	});
});
