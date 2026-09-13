/**
 * `tines runner install` / `restart` / `uninstall` through the real bin,
 * against a stub supervisor and fake `ps`, `npm`, `systemctl` and `loginctl`
 * on the PATH. What only the whole command can be tested for lives here:
 * that it registers exactly once and stores the token, that it refuses to
 * load a service beside a daemon started some other way, that the unit it
 * writes launches the managed-prefix binary with the flags given and no
 * credential, and that it waits for the daemon's own start line.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_BIN, NODE } from './test-bin.js';

const run = promisify(execFile);
const NAME = 'box-e2e';

let root: string;
let home: string;
let configDir: string;
let fakeBin: string;
let calls: string;
let server: Server;
let baseUrl: string;
let registrations = 0;

/** A fake executable on the PATH: a shell script with the given body. */
function fake(name: string, body: string): void {
	writeFileSync(join(fakeBin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		...process.env,
		HOME: home,
		TINES_CONFIG_DIR: configDir,
		TINES_API_URL: baseUrl,
		TINES_API_KEY: '',
		PATH: `${fakeBin}:${process.env.PATH}`,
		FAKE_CALLS: calls,
		FAKE_PS_OUTPUT: '',
		...extra
	};
}

function cli(args: string[], extra: NodeJS.ProcessEnv = {}) {
	return run(NODE, [CLI_BIN, ...args], { env: env(extra), timeout: 60_000 });
}

function recordedCalls(): string[] {
	return existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : [];
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), 'tines-install-'));
	home = join(root, 'home');
	configDir = join(root, 'cfg');
	fakeBin = join(root, 'bin');
	calls = join(root, 'calls.log');
	mkdirSync(home, { recursive: true });
	mkdirSync(fakeBin, { recursive: true });
	registrations = 0;

	fake('ps', 'printf "%s\\n" "$FAKE_PS_OUTPUT"');
	// npm's only job here is to leave a launchable `tines` in the prefix.
	fake(
		'npm',
		[
			'echo "npm $*" >> "$FAKE_CALLS"',
			'prefix=""',
			'while [ $# -gt 0 ]; do if [ "$1" = "--prefix" ]; then prefix="$2"; shift; fi; shift; done',
			'mkdir -p "$prefix/node_modules/.bin" "$prefix/node_modules/tines"',
			'printf \'{"version":"9.9.9"}\' > "$prefix/node_modules/tines/package.json"',
			'printf "#!/bin/sh\\n" > "$prefix/node_modules/.bin/tines"',
			'chmod +x "$prefix/node_modules/.bin/tines"'
		].join('\n')
	);
	// systemctl records what it was asked; `enable --now` stands in for the
	// daemon starting by appending its reconnect line to the service log.
	fake(
		'systemctl',
		[
			'echo "systemctl $*" >> "$FAKE_CALLS"',
			'if [ "$2" = "enable" ]; then',
			`  mkdir -p "$TINES_CONFIG_DIR/logs"`,
			`  printf '[00:00:00] reconnecting as runner "${NAME}" (rnr_stub) — token from x\\n' >> "$TINES_CONFIG_DIR/logs/runner-${NAME}.log"`,
			'fi'
		].join('\n')
	);
	fake('loginctl', 'echo "loginctl $*" >> "$FAKE_CALLS"');

	server = createServer((req, res) => {
		let body = '';
		req.on('data', (chunk) => (body += chunk));
		req.on('end', () => {
			if (req.url === '/api/v1/runners/register') {
				registrations++;
				const parsed = JSON.parse(body) as { name: string; harness: string };
				res.writeHead(200, { 'content-type': 'application/json' });
				return res.end(
					JSON.stringify({
						runner: { id: 'rnr_stub', name: parsed.name, harness: parsed.harness },
						runner_token: 'rt_stub_token'
					})
				);
			}
			res.writeHead(404, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'not_found' }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	rmSync(root, { recursive: true, force: true });
});

describe('tines runner install', () => {
	it('builds the prefix, registers once, writes a credential-free unit, loads it, waits for the daemon', async () => {
		const { stdout } = await cli(
			[
				'runner',
				'install',
				'--name',
				NAME,
				'--harness',
				'codex',
				'--max-concurrent',
				'4',
				'--service-manager',
				'systemd'
			],
			{ TINES_API_KEY: 'tines_user_key' }
		);
		expect(registrations).toBe(1);
		expect(stdout).toContain(`registered runner "${NAME}"`);
		expect(stdout).toContain('is up under systemd');

		const unit = join(home, '.config', 'systemd', 'user', `tines-runner-${NAME}.service`);
		const text = readFileSync(unit, 'utf8');
		expect(text).toContain(
			`ExecStart=${configDir}/cli/node_modules/.bin/tines runner daemon --url ${baseUrl} --name ${NAME} --harness codex --max-concurrent 4`
		);
		expect(text).toContain(`Environment=TINES_CONFIG_DIR=${configDir}`);
		expect(text).toContain(`StandardOutput=append:${configDir}/logs/runner-${NAME}.log`);
		expect(text).not.toContain('tines_user_key');
		expect(text).not.toContain('rt_stub_token');
		// The token went where the daemon reads it from, and nowhere else.
		const stored = JSON.parse(readFileSync(join(configDir, 'runners.json'), 'utf8')) as Record<
			string,
			{ runner_id: string; token: string }
		>;
		expect(stored[`${baseUrl}#${NAME}`]).toEqual({ runner_id: 'rnr_stub', token: 'rt_stub_token' });

		expect(recordedCalls()).toEqual([
			expect.stringMatching(/^npm install --prefix .*\/cfg\/cli tines@latest/),
			'systemctl --user daemon-reload',
			`systemctl --user enable --now tines-runner-${NAME}`,
			'loginctl enable-linger'
		]);

		// A second install reconnects: no key needed, no second registration.
		const again = await cli([
			'runner',
			'install',
			'--name',
			NAME,
			'--harness',
			'codex',
			'--service-manager',
			'systemd'
		]);
		expect(registrations).toBe(1);
		expect(again.stdout).toContain(`reconnecting as runner "${NAME}"`);
		expect(recordedCalls().filter((c) => c.startsWith('npm'))).toHaveLength(1);
	}, 60_000);

	it('refuses to load a service beside a daemon started some other way', async () => {
		const foreign = `17985 node /Users/me/.nvm/versions/node/v26.2.0/bin/tines runner daemon --url ${baseUrl} --name ${NAME} --harness codex`;
		await expect(
			cli(
				['runner', 'install', '--name', NAME, '--harness', 'codex', '--service-manager', 'systemd'],
				{
					TINES_API_KEY: 'tines_user_key',
					FAKE_PS_OUTPUT: foreign
				}
			)
		).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringContaining('already running outside the service')
		});
		expect(registrations).toBe(0);
		expect(recordedCalls()).toEqual([]);
		expect(existsSync(join(home, '.config', 'systemd', 'user'))).toBe(false);
	}, 60_000);

	it('needs a key only when nothing is stored, and says so', async () => {
		await expect(
			cli([
				'runner',
				'install',
				'--name',
				NAME,
				'--harness',
				'codex',
				'--service-manager',
				'systemd'
			])
		).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringContaining('set TINES_API_KEY')
		});
		expect(recordedCalls().filter((c) => c.startsWith('systemctl'))).toEqual([]);
	}, 60_000);

	it('restart and uninstall drive the unit, and uninstall keeps the token', async () => {
		await expect(
			cli(['runner', 'restart', NAME, '--service-manager', 'systemd'])
		).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringContaining('not installed as a service')
		});
		await cli(
			[
				'runner',
				'install',
				'--name',
				NAME,
				'--harness',
				'claude-code',
				'--service-manager',
				'systemd'
			],
			{
				TINES_API_KEY: 'tines_user_key'
			}
		);
		const { stdout } = await cli(['runner', 'restart', NAME, '--service-manager', 'systemd']);
		expect(stdout).toContain(`restarted tines-runner-${NAME}`);
		expect(recordedCalls()).toContain(`systemctl --user restart tines-runner-${NAME}`);

		const removed = await cli([
			'runner',
			'uninstall',
			NAME,
			'--service-manager',
			'systemd',
			'--json'
		]);
		expect(JSON.parse(removed.stdout)).toEqual({
			name: NAME,
			service_manager: 'systemd',
			removed: true
		});
		expect(recordedCalls()).toContain(`systemctl --user disable --now tines-runner-${NAME}`);
		expect(
			existsSync(join(home, '.config', 'systemd', 'user', `tines-runner-${NAME}.service`))
		).toBe(false);
		expect(existsSync(join(configDir, 'runners.json'))).toBe(true);
	}, 60_000);
});
