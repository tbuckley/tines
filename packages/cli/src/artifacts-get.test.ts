import { execFile } from 'node:child_process';
import {
	existsSync,
	lstatSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CLI_BIN, NODE } from './test-bin.js';

const issue = {
	id: 'i1',
	project_name: 'Stub',
	number: 1,
	title: 'artifact downloads',
	description: '',
	state: { name: 'Implementation', category: 'active' },
	effective_state: { name: 'Implementation', category: 'active' },
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

const folderFiles = {
	1: { 'index.html': Buffer.from('version one'), 'removed.js': Buffer.from('old code') },
	2: { 'index.html': Buffer.from('version two') }
} as const;
const nestedFiles = {
	'root.txt': Buffer.from('root'),
	'assets/data.bin': Buffer.from([0, 1, 2, 3])
};

function version(
	n: number,
	files: Record<string, Buffer> | null = null,
	opts: { filename?: string; contentType?: string; url?: string; pr?: boolean } = {}
) {
	return {
		version: n,
		created_at: 0,
		filename: opts.filename ?? null,
		content_type: opts.contentType ?? null,
		size_bytes: files ? null : 7,
		file_count: files ? Object.keys(files).length : null,
		files: files
			? Object.entries(files).map(([path, bytes]) => ({
					path,
					content_type: path.endsWith('.html') ? 'text/html' : 'application/octet-stream',
					size_bytes: bytes.byteLength
				}))
			: null,
		url: opts.url ?? null,
		title: null,
		pr_repo_url: opts.pr ? 'https://github.com/example/repo' : null,
		pr_number: opts.pr ? 12 : null,
		reaffirmed_from: null,
		actor: { kind: 'user', id: 'u1', label: 'Tester' }
	};
}

function artifact(name: string) {
	if (name === 'snapshot') {
		const versions = [version(1, folderFiles[1]), version(2, folderFiles[2])];
		return { artifact_type: 'folder', versions, current_version: versions[1] };
	}
	if (name === 'nested') {
		const current = version(3, nestedFiles);
		return { artifact_type: 'folder', versions: [current], current_version: current };
	}
	if (name === 'link') {
		const current = version(1, null, { url: 'https://example.test/reference' });
		return { artifact_type: 'link', versions: [current], current_version: current };
	}
	if (name === 'pr') {
		const current = version(1, null, { pr: true });
		return { artifact_type: 'pr', versions: [current], current_version: current };
	}
	const current = version(1, null, {
		filename: name === 'file' ? 'stored.bin' : 'notes.md',
		contentType: name === 'file' ? 'application/octet-stream' : 'text/markdown'
	});
	return { artifact_type: name, versions: [current], current_version: current };
}

let server: Server;
let baseUrl: string;
let contentRequests: string[] = [];
const tempRoots: string[] = [];

beforeAll(async () => {
	server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		const json = (value: unknown) => {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify(value));
		};
		if (url.pathname === '/api/v1/projects') {
			return json({ items: [{ id: 'p1', name: 'Stub', archived_at: null }], next_cursor: null });
		}
		if (url.pathname === '/api/v1/projects/p1/issues/1') return json(issue);
		const match = url.pathname.match(/^\/api\/v1\/issues\/i1\/artifacts\/([^/]+)(\/content)?$/);
		if (match && !match[2]) {
			return json({ id: `a-${match[1]}`, name: match[1], issue_id: 'i1', ...artifact(match[1]) });
		}
		if (match?.[2]) {
			contentRequests.push(`${url.pathname}${url.search}`);
			const name = match[1];
			const selectedVersion = Number(url.searchParams.get('version') ?? 1);
			const path = url.searchParams.get('path');
			let bytes: Buffer;
			if (name === 'snapshot' && path)
				bytes = folderFiles[selectedVersion as 1 | 2][path as 'index.html'];
			else if (name === 'nested' && path) bytes = nestedFiles[path as keyof typeof nestedFiles];
			else bytes = Buffer.from(name === 'file' ? [9, 8, 7] : '# new notes\n');
			res.writeHead(200, {
				'content-type': name === 'text' ? 'text/markdown' : 'application/octet-stream'
			});
			return res.end(bytes);
		}
		res.writeHead(404, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: 'unexpected endpoint', path: url.pathname }));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
	contentRequests = [];
});

afterEach(() => {
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
	const root = mkdtempSync(join(tmpdir(), 'tines-artifacts-get-'));
	tempRoots.push(root);
	return root;
}

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(
			NODE,
			[CLI_BIN, ...args],
			{
				env: { ...process.env, TINES_API_URL: baseUrl, TINES_API_KEY: 'stub-key' },
				timeout: 60_000
			},
			(err, stdout, stderr) => {
				const code = (err as { code?: number } | null)?.code ?? 0;
				resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr });
			}
		);
	});
}

function tree(
	root: string
): Record<string, { type: string; bytes?: string; target?: string; mtime: number }> {
	const result: Record<string, { type: string; bytes?: string; target?: string; mtime: number }> =
		{};
	function visit(dir: string, prefix = '') {
		for (const entry of readdirSync(dir)) {
			const path = join(dir, entry);
			const relative = prefix ? `${prefix}/${entry}` : entry;
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) {
				result[relative] = { type: 'symlink', target: readlinkSync(path), mtime: stat.mtimeMs };
			} else if (stat.isDirectory()) {
				result[relative] = { type: 'directory', mtime: stat.mtimeMs };
				visit(path, relative);
			} else {
				result[relative] = {
					type: 'file',
					bytes: readFileSync(path).toString('base64'),
					mtime: stat.mtimeMs
				};
			}
		}
	}
	visit(root);
	return result;
}

describe.sequential('issues artifacts get', () => {
	it('refuses a second pinned snapshot download before content requests or mutation', async () => {
		const destination = join(tempDir(), 'snapshot');
		const first = await cli([
			'issues',
			'artifacts',
			'get',
			'Stub/1',
			'snapshot',
			'--version',
			'1',
			'--out',
			destination
		]);
		expect(first.code).toBe(0);
		expect(first.stdout).toContain(
			`wrote 2 files (19 bytes) from "snapshot" v1 into ${destination}/`
		);
		const before = tree(destination);
		contentRequests = [];

		const second = await cli([
			'issues',
			'artifacts',
			'get',
			'Stub/1',
			'snapshot',
			'--version',
			'2',
			'--out',
			destination
		]);
		expect(second.code).toBe(1);
		expect(second.stderr).toContain(
			`refusing to write folder artifact into non-empty directory "${destination}"`
		);
		expect(second.stderr).toContain('choose a new or empty directory');
		expect(second.stdout).not.toContain('wrote');
		expect(contentRequests).toEqual([]);
		expect(tree(destination)).toEqual(before);
	});

	it.each(['file', 'hidden file', 'empty child directory', 'dangling symlink'])(
		'preserves a pre-existing %s entry',
		async (entry) => {
			const root = tempDir();
			const destination = join(root, 'destination');
			mkdirSync(destination);
			if (entry === 'file') writeFileSync(join(destination, 'unrelated.txt'), 'keep me');
			if (entry === 'hidden file') writeFileSync(join(destination, '.hidden'), 'secret');
			if (entry === 'empty child directory') mkdirSync(join(destination, 'empty'));
			if (entry === 'dangling symlink')
				symlinkSync(join(root, 'missing-target'), join(destination, 'link'));
			const before = tree(destination);

			const result = await cli([
				'issues',
				'artifacts',
				'get',
				'Stub/1',
				'snapshot',
				'--version',
				'2',
				'--out',
				destination
			]);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain('choose a new or empty directory');
			expect(contentRequests).toEqual([]);
			expect(tree(destination)).toEqual(before);
		}
	);

	it.each(['new', 'empty'])('downloads nested files into a %s directory', async (kind) => {
		const destination = join(tempDir(), 'destination');
		if (kind === 'empty') mkdirSync(destination);
		const result = await cli([
			'issues',
			'artifacts',
			'get',
			'Stub/1',
			'nested',
			'--version',
			'3',
			'--out',
			destination
		]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(
			`wrote 2 files (8 bytes) from "nested" v3 into ${destination}/`
		);
		expect(readFileSync(join(destination, 'root.txt'))).toEqual(nestedFiles['root.txt']);
		expect(readFileSync(join(destination, 'assets/data.bin'))).toEqual(
			nestedFiles['assets/data.bin']
		);
		expect(Object.keys(tree(destination)).sort()).toEqual([
			'assets',
			'assets/data.bin',
			'root.txt'
		]);
	});

	it('reports the singular count and selected version accurately', async () => {
		const destination = join(tempDir(), 'destination');
		const result = await cli([
			'issues',
			'artifacts',
			'get',
			'Stub/1',
			'snapshot',
			'--version',
			'2',
			'--out',
			destination
		]);
		expect(result).toMatchObject({
			code: 0,
			stdout: `wrote 1 file (11 bytes) from "snapshot" v2 into ${destination}/\n`,
			stderr: ''
		});
		expect(readFileSync(join(destination, 'index.html'))).toEqual(folderFiles[2]['index.html']);
	});

	it('keeps the existing regular-file diagnostic and bytes', async () => {
		const destination = join(tempDir(), 'existing.txt');
		writeFileSync(destination, 'unchanged');
		const result = await cli([
			'issues',
			'artifacts',
			'get',
			'Stub/1',
			'snapshot',
			'--out',
			destination
		]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			`--out for a folder must be a directory, and "${destination}" is a file`
		);
		expect(contentRequests).toEqual([]);
		expect(readFileSync(destination, 'utf8')).toBe('unchanged');
	});

	it.each([
		['file', 'stored.bin'],
		['text', 'notes.md']
	])('keeps %s downloads compatible with populated directories', async (name, storedName) => {
		const destination = tempDir();
		writeFileSync(join(destination, 'unrelated.txt'), 'keep');
		const result = await cli(['issues', 'artifacts', 'get', 'Stub/1', name, '--out', destination]);
		expect(result.code).toBe(0);
		expect(existsSync(join(destination, storedName))).toBe(true);
		expect(readFileSync(join(destination, 'unrelated.txt'), 'utf8')).toBe('keep');
	});

	it.each([
		['link', 'https://example.test/reference'],
		['pr', 'https://github.com/example/repo/pull/12']
	])('keeps %s URL output independent of --out', async (name, url) => {
		const destination = tempDir();
		writeFileSync(join(destination, 'unrelated.txt'), 'keep');
		const before = tree(destination);
		const result = await cli(['issues', 'artifacts', 'get', 'Stub/1', name, '--out', destination]);
		expect(result).toMatchObject({ code: 0, stdout: `${url}\n`, stderr: '' });
		expect(contentRequests).toEqual([]);
		expect(tree(destination)).toEqual(before);
	});
});
