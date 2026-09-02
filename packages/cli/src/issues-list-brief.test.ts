import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const tsx = join(here, '..', 'node_modules', '.bin', 'tsx');
const entry = join(here, 'index.ts');

/** One issue row, shaped as far as the table renderer reads it. */
function row(n: number): Record<string, unknown> {
	return {
		id: `i${n}`,
		project_name: 'Stub',
		number: n,
		title: `issue ${n}`,
		description: `a description body for issue ${n}`,
		effective_state: { name: 'Backlog', category: 'active' },
		last_activity_at: 0,
		open_blockers: [],
		duplicate_of: null
	};
}

let server: Server;
let baseUrl: string;
/** The query string of every list request, so the flag's wiring can be read off it. */
const queries: string[] = [];

/**
 * A stand-in API that honours `brief` the way the worker does. This pins the
 * CLI half — that --brief reaches the request at all, and that it leaves table
 * output alone — which no worker-side test can see.
 */
beforeAll(async () => {
	server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		queries.push(url.search);
		const brief = ['1', 'true'].includes(url.searchParams.get('brief') ?? '');
		const items = [1, 2].map((n) => {
			const item = row(n);
			if (brief) delete item.description;
			return item;
		});
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ items, next_cursor: null }));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** Runs the CLI from source against the stub; never rejects. */
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

describe('issues list --brief', () => {
	it('asks the API for brief items, and prints them without descriptions', async () => {
		queries.length = 0;
		const res = await cli(['issues', 'list', '--brief', '--json']);
		expect(res.code).toBe(0);
		expect(queries[0]).toContain('brief=true');
		const items = JSON.parse(res.stdout).items as Record<string, unknown>[];
		expect(items).toHaveLength(2);
		for (const item of items) expect(Object.hasOwn(item, 'description')).toBe(false);
	}, 60_000);

	it('sends no brief param without the flag, and keeps the descriptions', async () => {
		queries.length = 0;
		const res = await cli(['issues', 'list', '--json']);
		expect(res.code).toBe(0);
		expect(queries[0]).not.toContain('brief');
		const items = JSON.parse(res.stdout).items as Record<string, unknown>[];
		expect(items.map((i) => i.description)).toEqual([
			'a description body for issue 1',
			'a description body for issue 2'
		]);
	}, 60_000);

	// The table never printed descriptions, so --brief is a --json-only saving:
	// it must not change what a human sees.
	it('leaves table output untouched', async () => {
		const [plain, brief] = await Promise.all([
			cli(['issues', 'list']),
			cli(['issues', 'list', '--brief'])
		]);
		expect(brief.stdout).toBe(plain.stdout);
		expect(plain.stdout).toContain('issue 1');
	}, 60_000);
});
