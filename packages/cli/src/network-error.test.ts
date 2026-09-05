import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const tsx = join(here, '..', 'node_modules', '.bin', 'tsx');
const entry = join(here, 'index.ts');

/**
 * A port nothing listens on, so a connection to it is refused. Taken by
 * binding and releasing rather than hard-coded: the low ports are on fetch's
 * blocked list, which fails before the connection with no `code` at all.
 */
let DEAD_URL: string;
let configDir: string;

beforeAll(async () => {
	configDir = mkdtempSync(join(tmpdir(), 'tines-net-'));
	const probe = createServer();
	await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
	const { port } = probe.address() as AddressInfo;
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	DEAD_URL = `http://127.0.0.1:${port}`;
});
afterAll(() => rmSync(configDir, { recursive: true, force: true, maxRetries: 3 }));

interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * Runs the CLI from source with a private config dir and no ambient URL or key
 * — the machine running the tests may have both — so what a command reaches
 * for is only ever what the test passed it.
 */
function cli(args: string[]): Promise<CliResult> {
	return new Promise((resolve) => {
		const env: Record<string, string | undefined> = {
			...process.env,
			TINES_CONFIG_DIR: configDir
		};
		delete env.TINES_API_URL;
		delete env.TINES_API_KEY;
		const child = execFile(
			tsx,
			[entry, ...args],
			{ env, timeout: 60_000 },
			(err, stdout, stderr) => {
				const code = (err as { code?: number } | null)?.code ?? 0;
				resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr });
			}
		);
		child.stdin?.end();
	});
}

describe('unreachable base URL', () => {
	// The whole of the old message was "error: fetch failed": neither the URL
	// tried, nor the request, nor the reason survived (Tines/161).
	it('names the URL, the request and the reason', async () => {
		const res = await cli(['time', '--url', DEAD_URL, '--api-key', 'k']);
		expect(res.code).not.toBe(0);
		expect(res.stderr).toContain(`error: GET /api/time: could not reach ${DEAD_URL}`);
		expect(res.stderr).toContain('ECONNREFUSED');
		expect(res.stderr).not.toMatch(/error: fetch failed/);
	}, 60_000);

	it('tells the caller where the base URL comes from', async () => {
		const res = await cli(['time', '--url', DEAD_URL, '--api-key', 'k']);
		expect(res.stderr).toContain('--url');
		expect(res.stderr).toContain('TINES_API_URL');
		expect(res.stderr).toContain('tines login');
	}, 60_000);

	// Not hard-coded to one route: the failing request is reported.
	it('reports the path of the command that failed', async () => {
		const res = await cli(['issues', 'list', '--all', '--url', DEAD_URL, '--api-key', 'k']);
		expect(res.code).not.toBe(0);
		expect(res.stderr).toContain('GET /api/v1/issues');
		expect(res.stderr).toContain(`could not reach ${DEAD_URL}`);
	}, 60_000);

	// `login` probes the URL it is about to store, and keeps its own wording:
	// the method and path of the probe are noise there, but "nothing stored" is
	// the fact the human needs.
	it('login says what it could not reach and that nothing was stored', async () => {
		const res = await cli(['login', '--url', DEAD_URL, '--api-key', 'k']);
		expect(res.code).not.toBe(0);
		expect(res.stderr).toContain(`could not reach ${DEAD_URL} (ECONNREFUSED); nothing stored`);
		expect(res.stderr).toContain('--no-verify');
		expect(existsSync(join(configDir, 'config.json'))).toBe(false);
	}, 60_000);
});
