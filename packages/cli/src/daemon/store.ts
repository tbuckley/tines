/**
 * The daemon's on-disk state: the CLI config directory, the persisted
 * runner credentials (runner id + token, keyed by API URL and runner name),
 * and the per-runner state file mapping live runs to PID + workspace — what
 * a restarted daemon uses to kill orphaned harnesses and fail their runs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultConfigDir, readJsonFile, writeJsonFile } from '../config.js';

// The config directory itself (and the JSON helpers) live in ../config.ts,
// shared with `tines login`; re-exported so the daemon's callers keep one import.
export { defaultConfigDir };

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
	/** When the harness was spawned — the orphan kill's PID-reuse check. */
	started_at?: number;
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

/**
 * The process's start time in ms since the epoch, where the platform makes
 * that cheap (Linux: /proc/<pid>/stat field 22 in clock ticks since boot,
 * plus /proc/stat's btime; the tick rate is assumed 100 Hz — the value on
 * every mainstream Linux). Null anywhere it cannot be read (macOS, a
 * vanished pid) — callers fall back to liveness alone.
 */
export function processStartTimeMs(pid: number): number | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
		// Field 2 (comm) may contain spaces/parens; fields after the closing
		// paren are whitespace-separated, with starttime at index 19 there.
		const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
		const startTicks = Number(afterComm[19]);
		const btimeLine = readFileSync('/proc/stat', 'utf8')
			.split('\n')
			.find((line) => line.startsWith('btime '));
		const btime = Number(btimeLine?.slice('btime '.length));
		if (!Number.isFinite(startTicks) || !Number.isFinite(btime)) return null;
		return btime * 1000 + (startTicks / 100) * 1000;
	} catch {
		return null;
	}
}
