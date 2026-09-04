/**
 * The daemon's on-disk state: the CLI config directory, the persisted
 * runner credentials (runner id + token, keyed by API URL and runner name),
 * and the per-runner state file mapping live runs to PID + workspace — what
 * a restarted daemon uses to kill orphaned harnesses and fail their runs.
 */
import { readdirSync, readFileSync, rmSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { defaultConfigDir, readJsonFile, writeJsonFile } from '../config.js';
import type { RunOutcome } from './support.js';

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
	/** `Project/123`, so an orphan's kept workspace can say what it was. */
	issue_ref?: string;
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

// ---------------------------------------------------------------------------
// Kept workspaces (--keep-workspaces): a settled run's directory, left on disk
// with a `kept.json` marker so a human can read what the agent left behind.

/**
 * What `kept.json` holds: enough to answer "what was this directory?" without
 * an API call, and the timestamp the retention sweep ages entries by.
 */
export interface KeptWorkspaceMarker {
	run_id: string;
	/** `Project/123`, when the daemon knew it. */
	issue_ref?: string;
	status: RunOutcome;
	/** The finish error, or why the daemon let go of the run. */
	error?: string;
	/** ISO 8601. */
	kept_at: string;
}

/** A kept workspace as the sweep and the `runner workspaces` commands see it. */
export type KeptWorkspace = KeptWorkspaceMarker & { path: string };

/** Every run's workspace lives here, whichever daemon on the machine owns it. */
export function workspacesDir(configDir: string): string {
	return join(configDir, 'workspaces');
}

export function keptMarkerPath(workspace: string): string {
	return join(workspace, 'kept.json');
}

/**
 * Marks a workspace as kept. Written only once the run has settled: a live
 * workspace is exactly the `issues context --out` layout the prompt describes,
 * and nothing else may appear in it while an agent is looking.
 */
export function writeKeptMarker(workspace: string, marker: KeptWorkspaceMarker): void {
	writeJsonFile(keptMarkerPath(workspace), marker);
}

function readKeptMarker(workspace: string): KeptWorkspaceMarker | null {
	const marker = readJsonFile<KeptWorkspaceMarker>(keptMarkerPath(workspace));
	if (!marker || typeof marker.run_id !== 'string' || typeof marker.kept_at !== 'string') {
		return null;
	}
	return marker;
}

/**
 * The kept workspaces under a config dir, newest first.
 *
 * Only directories holding a parseable `kept.json` are ever reported: the
 * workspaces directory is shared by every run of every daemon on the machine,
 * so a bare directory may well be someone's live run.
 */
export function listKeptWorkspaces(configDir: string): KeptWorkspace[] {
	const root = workspacesDir(configDir);
	let names: string[];
	try {
		names = readdirSync(root, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
	} catch {
		// No workspaces directory yet.
		return [];
	}
	const kept: KeptWorkspace[] = [];
	for (const name of names) {
		const path = join(root, name);
		const marker = readKeptMarker(path);
		if (marker) kept.push({ ...marker, path });
	}
	return kept.sort((a, b) => Date.parse(b.kept_at) - Date.parse(a.kept_at));
}

/**
 * Deletes kept workspaces: those older than `maxAgeMs`, and then the oldest
 * survivors beyond `maxCount` — a workspace whose agent ran an install can
 * reach hundreds of megabytes, so age alone does not bound a bad day.
 * `all` removes every one of them. Returns what it actually removed.
 *
 * Like `listKeptWorkspaces`, this only ever touches a directory with a
 * parseable `kept.json` — never a bare one, which may be a live run.
 */
export function pruneKeptWorkspaces(
	configDir: string,
	opts: { maxAgeMs?: number; maxCount?: number; all?: boolean; now?: () => number }
): KeptWorkspace[] {
	const kept = listKeptWorkspaces(configDir);
	const now = (opts.now ?? Date.now)();
	const doomed: KeptWorkspace[] = [];
	const survivors: KeptWorkspace[] = [];
	for (const entry of kept) {
		const age = now - Date.parse(entry.kept_at);
		const expired = opts.maxAgeMs !== undefined && Number.isFinite(age) && age > opts.maxAgeMs;
		if (opts.all || expired) doomed.push(entry);
		else survivors.push(entry);
	}
	// `kept` is newest first, so the overflow is the tail.
	if (!opts.all && opts.maxCount !== undefined) doomed.push(...survivors.slice(opts.maxCount));
	const removed: KeptWorkspace[] = [];
	for (const entry of doomed) {
		try {
			rmSync(entry.path, { recursive: true, force: true });
			removed.push(entry);
		} catch {
			// Busy or unreadable: leave it for the next sweep.
		}
	}
	return removed;
}

/**
 * Recursive size of a directory in bytes — what the `runner workspaces` list
 * reports, so the disk cost of keeping them is visible. Best-effort: anything
 * that cannot be read counts as zero, and symlinks are never followed.
 */
export function directorySizeBytes(path: string): number {
	let total = 0;
	let entries: Dirent[];
	try {
		entries = readdirSync(path, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) total += directorySizeBytes(child);
		else if (entry.isFile()) {
			try {
				total += statSync(child).size;
			} catch {
				// Vanished mid-walk.
			}
		}
	}
	return total;
}
