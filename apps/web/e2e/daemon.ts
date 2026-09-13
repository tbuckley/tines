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

/** POSIX single-quote escaping for values interpolated into a custom harness. */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * A productive harness for standard-workflow fixtures. The delivered run key
 * remains in the daemon-built environment, so the transition is attributed to
 * the run and its successful exit settles as `advanced` rather than `stalled`.
 */
export function transitionHarnessCommand(action: string): string {
	return [
		'set -eu',
		`REF=$(sed -n 's/^This is run .* for issue \\([^;]*\\);.*/\\1/p' {prompt_file} | head -n 1)`,
		'if [ -z "$REF" ]; then echo "could not find issue ref in prompt" >&2; exit 1; fi',
		`${shellQuote(TSX)} ${shellQuote(CLI_ENTRY)} issues move "$REF" ${shellQuote(action)} --url ${shellQuote(BASE_URL)}`
	].join('\n');
}

export type Daemon = {
	proc: ChildProcess;
	configDir: string;
	/** Everything the daemon has written to stdout/stderr so far. */
	output: () => string;
	/** Stop the process but retain credentials for a restart assertion. */
	stop: () => void;
	/** Kill the process and remove its temp config dir. Safe to call twice. */
	kill: () => void;
};

/**
 * Start a daemon that registers `name` against the account owning `apiKey`.
 * The default harness exits immediately. It is useful when a test only needs
 * registration, but claimed work then settles as stalled and retries; tests
 * asserting successful work or run counts must pass a productive command.
 */
export function spawnDaemon({
	apiKey,
	name,
	command = 'true',
	maxConcurrent = 1,
	allowRemoteConcurrency = false,
	configDir: suppliedConfigDir
}: {
	apiKey: string;
	name: string;
	/** The `custom` harness command. A no-op completion causes stalled retries. */
	command?: string;
	maxConcurrent?: number;
	allowRemoteConcurrency?: boolean;
	configDir?: string;
}): Daemon {
	const configDir = suppliedConfigDir ?? mkdtempSync(join(tmpdir(), 'tines-e2e-daemon-'));
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
			'--max-concurrent',
			String(maxConcurrent),
			...(allowRemoteConcurrency ? ['--allow-remote-concurrency'] : []),
			// CI must not depend on the npm registry (or pay its latency) for the
			// daemon-managed agent CLI; productive test harnesses invoke this
			// repository's CLI source directly.
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
		configDir,
		output: () => output,
		stop: () => {
			if (!exited && proc.pid) proc.kill('SIGKILL');
		},
		kill: () => {
			if (!exited && proc.pid) proc.kill('SIGKILL');
			rmSync(configDir, { recursive: true, force: true });
		}
	};
}
