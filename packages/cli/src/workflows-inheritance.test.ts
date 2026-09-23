/** Regression coverage for the exact-state workflow CLI after inheritance retirement. */
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const tsx = join(here, '..', 'node_modules', '.bin', 'tsx');
const entry = join(here, 'index.ts');
const workflow = {
	id: 'wf_newline',
	name: 'Review',
	description: '',
	is_system: false,
	initial_state_id: 'wfs_one',
	states: [
		{ id: 'wfs_one', name: 'Needs\nreview', category: 'active', position: 0, inherits_from: null },
		{ id: 'wfs_two', name: 'Done', category: 'done', position: 1, inherits_from: null }
	],
	transitions: [{ id: 'wft_1', name: 'finish', from_state_id: 'wfs_one', to_state_id: 'wfs_two' }],
	issue_count: 0,
	created_at: 0,
	updated_at: 0
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
	server = createServer((req, res) => {
		if (req.url === '/api/v1/workflows') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ items: [workflow], next_cursor: null }));
			return;
		}
		res.writeHead(404, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: { code: 'not_found', message: 'no' } }));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(
			tsx,
			[entry, ...args],
			{ env: { ...process.env, TINES_API_URL: baseUrl, TINES_API_KEY: 'k' }, timeout: 60_000 },
			(err, stdout, stderr) => {
				const code = (err as { code?: number } | null)?.code ?? 0;
				resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr });
			}
		);
	});
}

describe('tines workflows', () => {
	it('renders newline state names and exits successfully', async () => {
		const res = await cli(['workflows', 'show', 'Review']);
		expect(res.code).toBe(0);
		expect(res.stderr).toBe('');
		expect(res.stdout).toContain('Needs\nreview');
		expect(res.stdout).not.toContain('inherits from:');
	});

	it('does not expose the retired bases command', async () => {
		const res = await cli(['workflows', 'bases']);
		expect(res.code).not.toBe(0);
		expect(res.stderr).toContain("unknown command 'bases'");
	});
});
