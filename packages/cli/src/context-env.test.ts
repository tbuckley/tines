import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CLI_BIN, NODE } from './test-bin.js';

let server: Server;
let baseUrl: string;
const requests: { method: string; body: Record<string, unknown> }[] = [];
const secret = 'test-only-private-token';
const item = {
	id: 'ctx_env',
	kind: 'env',
	name: 'GH_TOKEN',
	secret: true,
	value_set: true,
	hint: 'work credential',
	version: 1,
	scope: { label: 'global' },
	created_at: 0,
	updated_at: 0
};
const dir = mkdtempSync(join(tmpdir(), 'tines-context-env-'));

beforeAll(async () => {
	server = createServer(async (req, res) => {
		let body = '';
		for await (const chunk of req) body += chunk;
		if (body) requests.push({ method: req.method!, body: JSON.parse(body) });
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(
			JSON.stringify(
				req.method === 'GET' && req.url === '/api/v1/context'
					? { items: [item], next_cursor: null }
					: item
			)
		);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	rmSync(dir, { recursive: true, force: true });
});

function cli(
	args: string[],
	stdin = ''
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = execFile(
			NODE,
			[CLI_BIN, ...args],
			{
				env: { ...process.env, TINES_API_URL: baseUrl, TINES_API_KEY: 'test-key' },
				timeout: 15_000
			},
			(err, stdout, stderr) => {
				resolve({ code: err ? 1 : 0, stdout, stderr });
			}
		);
		child.stdin?.end(stdin);
	});
}

it.each(['file', 'stdin'] as const)(
	'creates a secret from %s and prints only the masked response',
	async (source) => {
		const path = join(dir, 'value');
		writeFileSync(path, `${secret}\n`);
		const result = await cli(
			[
				'context',
				'create',
				'--kind',
				'env',
				'--name',
				'GH_TOKEN',
				'--value',
				source === 'file' ? `@${path}` : '-',
				'--secret',
				'--hint',
				item.hint,
				'--json'
			],
			`${secret}\n`
		);
		expect(result.code, result.stderr).toBe(0);
		expect(requests.at(-1)).toMatchObject({
			method: 'POST',
			body: { kind: 'env', name: 'GH_TOKEN', value: secret, secret: true, hint: item.hint }
		});
		expect(JSON.parse(result.stdout)).toMatchObject({
			secret: true,
			value_set: true,
			hint: item.hint
		});
		expect(result.stdout + result.stderr).not.toContain(secret);
	}
);

it('replaces a secret using stdin without printing it', async () => {
	const result = await cli(['context', 'edit', item.id, '--value', '-', '--secret'], `${secret}\n`);
	expect(result.code, result.stderr).toBe(0);
	expect(requests.at(-1)).toMatchObject({ method: 'PATCH', body: { value: secret, secret: true } });
	expect(result.stdout + result.stderr).not.toContain(secret);
});

it.each([['show', item.id], ['list']])('renders secret status in context %s', async (...args) => {
	const result = await cli(['context', ...args]);
	expect(result.code, result.stderr).toBe(0);
	expect(result.stdout).toContain('secret');
	expect(result.stdout).toContain(item.hint);
	expect(result.stdout).not.toContain(secret);
});
