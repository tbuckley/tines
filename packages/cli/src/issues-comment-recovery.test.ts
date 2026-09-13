import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_BIN, NODE } from './test-bin.js';

const REF = `Odd Project's/7`;
const QUOTED_REF = `'Odd Project'\\''s/7'`;
const ID = 'cmt_old';
const comment = (id: string, body: string) => ({
	id,
	issue_id: 'iss_1',
	body,
	actor: { user_id: 'u1', user_name: 'Fixture Human', api_key_id: null, api_key_name: null },
	created_at: 1_700_000_000_000,
	updated_at: null
});
let comments = [comment(ID, 'original body')];
let server: Server;
let baseUrl: string;
let binDir: string;

beforeAll(async () => {
	server = createServer((req, res) => {
		const path = new URL(req.url ?? '/', 'http://localhost').pathname;
		res.writeHead(200, { 'content-type': 'application/json' });
		if (path.endsWith('/projects')) {
			res.end(
				JSON.stringify({ items: [{ id: 'prj_1', name: "Odd Project's" }], next_cursor: null })
			);
			return;
		}
		res.end(
			JSON.stringify({
				id: 'iss_1',
				project_name: "Odd Project's",
				project_archived_at: null,
				number: 7,
				title: 'Recovery fixture',
				description: '',
				labels: [],
				links: { blocked_by: [], blocks: [], duplicated_by: [] },
				duplicate_of: null,
				workflow: { name: 'Engineering' },
				state: { name: 'Implementation', category: 'active' },
				effective_state: { name: 'Implementation', category: 'active' },
				allowed_transitions: [],
				comments,
				updated_at: Date.now()
			})
		);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	binDir = mkdtempSync(join(tmpdir(), 'tines-recovery-'));
	const wrapper = join(binDir, 'tines');
	writeFileSync(wrapper, `#!/bin/sh\nexec "${NODE}" "${CLI_BIN}" "$@"\n`);
	chmodSync(wrapper, 0o755);
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function shell(command: string, path = `${binDir}:/usr/bin:/bin`) {
	return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
		execFile(
			'/bin/sh',
			['-c', command],
			{
				env: { ...process.env, PATH: path, TINES_API_URL: baseUrl, TINES_API_KEY: 'key' },
				timeout: 60_000
			},
			(error, stdout, stderr) =>
				resolve({ code: (error as { code?: number } | null)?.code ?? 0, stdout, stderr })
		);
	});
}

const lookup = () =>
	`tines issues show ${QUOTED_REF} --json | jq -er --arg id ${ID} 'first(.comments[] | select(.id == $id) | .body) // error("comment not found: \\($id)")'`;

describe('the emitted current-body recovery recipe', () => {
	it('loads the current body, observes an edit, and fails visibly after deletion', async () => {
		comments = [comment(ID, 'original body')];
		expect(await shell(lookup())).toMatchObject({ code: 0, stdout: 'original body\n', stderr: '' });
		comments = [comment(ID, 'edited current body')];
		expect(await shell(lookup())).toMatchObject({
			code: 0,
			stdout: 'edited current body\n',
			stderr: ''
		});
		comments = [];
		const missing = await shell(lookup());
		expect(missing.code).not.toBe(0);
		expect(missing.stderr).toContain(`comment not found: ${ID}`);
	});

	it('runs the full-show fallback without jq and keeps every current body', async () => {
		comments = [comment(ID, 'old current body'), comment('cmt_new', 'new current body')];
		const noJq = mkdtempSync(join(tmpdir(), 'tines-no-jq-'));
		symlinkSync(join(binDir, 'tines'), join(noJq, 'tines'));
		const result = await shell(`tines issues show ${QUOTED_REF}`, noJq);
		expect(result.code, JSON.stringify(result)).toBe(0);
		expect(result.stdout).toContain("Odd Project's/#7");
		expect(result.stdout).toContain('old current body');
		expect(result.stdout).toContain('new current body');
		expect(result.stderr).toBe('');
	});
});
