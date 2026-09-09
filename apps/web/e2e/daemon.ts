/**
 * Spawning a real `tines runner daemon` from a spec.
 *
 * `runner.spec.ts` grew this incantation first; it lives here so the
 * first-run walk can register a runner the way a new user does — by running
 * the daemon — without duplicating the flags or copying its harness plumbing.
 * (`runner.spec.ts` is deliberately not refactored onto it: that spec's own
 * mode-file harness is the thing it tests, and moving it would put unrelated
 * churn in this issue's diff.)
 *
 * The daemon is run through `tsx` against the CLI's source, so no build step
 * is needed, and with an isolated `TINES_CONFIG_DIR` so it cannot read or
 * write the developer's real credentials.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_URL } from './constants.mjs';

const CLI_DIR = fileURLToPath(new URL('../../../packages/cli', import.meta.url));
const TSX = join(CLI_DIR, 'node_modules', '.bin', 'tsx');
const CLI_ENTRY = join(CLI_DIR, 'src', 'index.ts');

export type Daemon = {
	proc: ChildProcess;
	/** Everything the daemon has written to stdout/stderr so far. */
	output: () => string;
	/** Kill the process and remove its temp config dir. Safe to call twice. */
	kill: () => void;
};

/**
 * Start a daemon that registers `name` against the account owning `apiKey`.
 * The default harness exits immediately: enough to make the runner appear
 * online and to claim a run, which is all the checklist watches.
 */
export function spawnDaemon({
	apiKey,
	name,
	command = 'true'
}: {
	apiKey: string;
	name: string;
	/** The `custom` harness command. Defaults to a no-op that exits 0. */
	command?: string;
}): Daemon {
	const configDir = mkdtempSync(join(tmpdir(), 'tines-e2e-daemon-'));
	const proc = spawn(
		TSX,
		[
			CLI_ENTRY,
			'runner',
			'daemon',
			'--url',
			BASE_URL,
			'--name',
			name,
			'--harness',
			'custom',
			'--command',
			command,
			'--poll-interval',
			'1',
			// CI must not depend on the npm registry (or pay its latency) for the
			// daemon-managed agent CLI; a script harness never runs `tines`.
			'--no-cli-refresh'
		],
		{
			cwd: CLI_DIR,
			env: { ...process.env, TINES_API_KEY: apiKey, TINES_CONFIG_DIR: configDir },
			stdio: ['ignore', 'pipe', 'pipe']
		}
	);

	let output = '';
	let exited = false;
	proc.stdout?.on('data', (d: Buffer) => (output += d.toString()));
	proc.stderr?.on('data', (d: Buffer) => (output += d.toString()));
	proc.on('exit', () => (exited = true));

	return {
		proc,
		output: () => output,
		kill: () => {
			if (!exited && proc.pid) proc.kill('SIGKILL');
			rmSync(configDir, { recursive: true, force: true });
		}
	};
}
