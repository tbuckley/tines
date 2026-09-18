/**
 * Keeps the agent-facing `tines` current (Tines/71). Merging to `main`
 * deploys the worker and publishes the CLI in the same push, so the launch
 * prompt an agent reads is always current while the CLI it runs is whatever
 * a human last put on the machine — a skew that is silent when the prompt
 * teaches a positional the old CLI takes verbatim.
 *
 * The fix is one npm install into a prefix the daemon owns, injected into
 * the harness PATH (support.ts's `buildSpawnEnv`). Deliberately NOT
 * `npm i -g`: the global `tines` on a developer's machine is often a
 * `pnpm link --global` symlink into their clone (README "If you're actively
 * hacking on the CLI"), and a global install would silently destroy it.
 *
 * Every failure path here degrades — last-good copy, then the ambient PATH —
 * and never throws: a registry outage must not fail runs. The policy around
 * this effect (TTL, coalescing) lives in support.ts's `CliRefresher`.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AMBIENT_CLI, type AgentCli } from './support.js';

/** The npm package the daemon hands to agents. */
const PACKAGE = 'tines';

/**
 * `--min-release-age=0` is load-bearing, not hygiene: npm's supply-chain
 * hardening (`min-release-age` in ~/.npmrc) refuses versions younger than
 * the configured window, and because CI publishes on every merge to `main`
 * the newest `tines` is essentially always younger than it. Without the
 * override the refresh is a permanent `ENOVERSIONS` no-op on exactly the
 * machines that set it. It is scoped to this one install of a first-party
 * package published by the user's own CI, and named in the daemon's log.
 */
const NPM_ARGS = ['--min-release-age=0', '--no-audit', '--no-fund', '--loglevel=error'];

export interface InstallAgentCliOptions {
	/** The daemon's config dir; the prefix is `<configDir>/cli`. */
	configDir: string;
	log: (message: string) => void;
	/** Kill npm after this long and fall back. Default 60 s. */
	timeoutMs?: number;
}

/** Where the daemon-managed CLI lives, given the daemon's config dir. */
export function agentCliPrefix(configDir: string): string {
	return join(configDir, 'cli');
}

function binDirOf(prefix: string): string {
	return join(prefix, 'node_modules', '.bin');
}

/** The installed version, or null when the prefix has no readable package. */
function installedVersion(prefix: string): string | null {
	try {
		const pkg = readFileSync(join(prefix, 'node_modules', PACKAGE, 'package.json'), 'utf8');
		const version = (JSON.parse(pkg) as { version?: unknown }).version;
		return typeof version === 'string' ? version : null;
	} catch {
		return null;
	}
}

/** The last-good copy already in the prefix, or ambient when there is none. */
function lastGood(prefix: string): AgentCli {
	const binDir = binDirOf(prefix);
	if (!existsSync(join(binDir, PACKAGE))) return AMBIENT_CLI;
	return { binDir, version: installedVersion(prefix), source: 'stale' };
}

interface NpmResult {
	/** Exit code, or null when the process died on a signal or never spawned. */
	code: number | null;
	signal: NodeJS.Signals | null;
	spawnError: NodeJS.ErrnoException | null;
	/** Our own timeout fired — the signal below is ours, not the machine's. */
	timedOut: boolean;
	output: string;
}

/** Runs one npm command; resolves to how it ended plus its captured output. */
function runNpm(file: string, args: string[], cwd: string, timeoutMs: number): Promise<NpmResult> {
	return new Promise((resolve) => {
		let output = '';
		let done = false;
		let timedOut = false;
		const child = spawn(file, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
		const timer = setTimeout(() => {
			if (done) return;
			timedOut = true;
			child.kill('SIGKILL');
		}, timeoutMs);
		timer.unref?.();
		const settle = (result: Omit<NpmResult, 'output' | 'timedOut'>) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve({ ...result, timedOut, output });
		};
		child.stdout?.on('data', (data: Buffer) => (output += data.toString('utf8')));
		child.stderr?.on('data', (data: Buffer) => (output += data.toString('utf8')));
		// `close`, not `exit`: exit fires before the pipes have drained, and
		// npm's diagnosis is the whole value of capturing them.
		child.on('error', (err) => settle({ code: null, signal: null, spawnError: err }));
		child.on('close', (code, signal) => settle({ code, signal, spawnError: null }));
	});
}

/** Why an npm run counts as a failure, in one clause for the log line. */
function npmFailure(result: NpmResult, timeoutMs: number): string {
	if (result.spawnError) return `npm could not be run (${message(result.spawnError)})`;
	if (result.timedOut) return `npm did not finish within ${Math.round(timeoutMs / 1000)}s`;
	if (result.signal) return `npm was killed by ${result.signal}`;
	return `npm exited with code ${result.code}`;
}

/**
 * One install attempt of `tines@latest` into the daemon-owned prefix.
 * Never rejects: on any failure it returns the last-good copy already in the
 * prefix, or the ambient PATH when there is none.
 */
export async function installAgentCli(opts: InstallAgentCliOptions): Promise<AgentCli> {
	const prefix = agentCliPrefix(opts.configDir);
	const timeoutMs = opts.timeoutMs ?? 60_000;
	try {
		mkdirSync(prefix, { recursive: true });
	} catch (err) {
		opts.log(`agent CLI refresh: cannot create ${prefix} (${message(err)})`);
		return AMBIENT_CLI;
	}

	// cwd is the prefix itself so npm never walks up into an unrelated
	// project's package.json/node_modules.
	const args = ['install', '--prefix', prefix, `${PACKAGE}@latest`, ...NPM_ARGS];
	let result = await runNpm('npm', args, prefix, timeoutMs);
	if (result.spawnError?.code === 'ENOENT') {
		// Under launchd/systemd the PATH is minimal, and an nvm- or
		// Volta-managed npm sits next to the node binary we are running as.
		const sibling = join(dirname(process.execPath), 'npm');
		if (existsSync(sibling)) result = await runNpm(sibling, args, prefix, timeoutMs);
	}

	if (result.code !== 0) {
		const fallback = lastGood(prefix);
		opts.log(
			`warning: agent CLI refresh failed — ${npmFailure(result, timeoutMs)}${tail(result.output)}; ${
				fallback.source === 'stale'
					? `using the last-good copy (${PACKAGE} ${fallback.version ?? 'unknown'}) in ${prefix}`
					: 'the harness will use the ambient PATH'
			}`
		);
		return fallback;
	}

	const version = installedVersion(prefix);
	opts.log(`agent CLI refreshed: ${PACKAGE} ${version ?? 'unknown'} in ${prefix}`);
	return { binDir: binDirOf(prefix), version, source: 'fresh' };
}

/** The last few lines of npm's output, for a one-line log message. */
function tail(output: string): string {
	const lines = output.trim().split('\n').filter(Boolean).slice(-3);
	return lines.length > 0 ? `: ${lines.join(' / ')}` : '';
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
