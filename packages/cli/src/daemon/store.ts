/**
 * The daemon's on-disk state: the CLI config directory, the persisted
 * runner credentials (runner id + token, keyed by API URL and runner name),
 * and the per-runner state file mapping live runs to PID + workspace — what
 * a restarted daemon uses to kill orphaned harnesses and fail their runs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** `TINES_CONFIG_DIR` overrides (the e2e suite and tests point it at a tmp dir). */
export function defaultConfigDir(): string {
	return process.env.TINES_CONFIG_DIR ?? join(homedir(), '.config', 'tines');
}

function readJsonFile<T>(path: string): T | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as T;
	} catch {
		// A corrupt file is treated as absent rather than crashing the daemon.
		return null;
	}
}

function writeJsonFile(path: string, value: unknown, { secret = false } = {}): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, secret ? { mode: 0o600 } : {});
}

// ---------------------------------------------------------------------------
// Runner credentials (runners.json)

export interface RunnerCredentials {
	runner_id: string;
	token: string;
}

export function credentialsKey(url: string, name: string): string {
	return `${url.replace(/\/+$/, '')}#${name}`;
}

function credentialsPath(dir: string): string {
	return join(dir, 'runners.json');
}

export function loadRunnerCredentials(
	dir: string,
	url: string,
	name: string
): RunnerCredentials | null {
	const all = readJsonFile<Record<string, RunnerCredentials>>(credentialsPath(dir));
	const entry = all?.[credentialsKey(url, name)];
	return entry && typeof entry.runner_id === 'string' && typeof entry.token === 'string'
		? entry
		: null;
}

export function saveRunnerCredentials(
	dir: string,
	url: string,
	name: string,
	creds: RunnerCredentials
): void {
	const path = credentialsPath(dir);
	const all = readJsonFile<Record<string, RunnerCredentials>>(path) ?? {};
	all[credentialsKey(url, name)] = creds;
	writeJsonFile(path, all, { secret: true });
}

/** True when stored credentials existed for this url+name (used by rotate-token). */
export function hasRunnerCredentials(dir: string, url: string, name: string): boolean {
	return loadRunnerCredentials(dir, url, name) !== null;
}

/**
 * Drops stored credentials the supervisor rejected (rotated token), so the
 * next daemon start with TINES_API_KEY re-registers instead of looping 401s.
 */
export function clearRunnerCredentials(dir: string, url: string, name: string): void {
	const path = credentialsPath(dir);
	const all = readJsonFile<Record<string, RunnerCredentials>>(path) ?? {};
	delete all[credentialsKey(url, name)];
	writeJsonFile(path, all, { secret: true });
}

// ---------------------------------------------------------------------------
// Daemon state file (run id → PID, workspace, key fingerprint)

export interface DaemonStateEntry {
	run_id: string;
	pid: number;
	workspace: string;
	/** The run key's display prefix — identification, never the secret. */
	key_fingerprint: string;
}

export function daemonStatePath(dir: string, runnerId: string): string {
	return join(dir, `daemon-state-${runnerId}.json`);
}

export function loadDaemonState(path: string): DaemonStateEntry[] {
	const state = readJsonFile<{ runs: DaemonStateEntry[] }>(path);
	if (!state || !Array.isArray(state.runs)) return [];
	return state.runs.filter(
		(e) =>
			typeof e === 'object' &&
			e !== null &&
			typeof e.run_id === 'string' &&
			typeof e.pid === 'number' &&
			typeof e.workspace === 'string'
	);
}

export function saveDaemonState(path: string, runs: DaemonStateEntry[]): void {
	writeJsonFile(path, { runs });
}
