import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	clearRunnerCredentials,
	credentialsKey,
	daemonStatePath,
	directorySizeBytes,
	keptMarkerPath,
	listKeptWorkspaces,
	loadDaemonState,
	loadRunnerCredentials,
	processStartTimeMs,
	pruneKeptWorkspaces,
	saveDaemonState,
	saveRunnerCredentials,
	workspacesDir,
	writeKeptMarker
} from './store.js';

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'tines-cli-test-'));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('runner credentials', () => {
	it('round-trips per url+name, url normalized of trailing slashes', () => {
		const dir = tempDir();
		expect(loadRunnerCredentials(dir, 'http://x', 'laptop')).toBeNull();
		saveRunnerCredentials(dir, 'http://x/', 'laptop', { runner_id: 'rnr_1', token: 't1' });
		expect(loadRunnerCredentials(dir, 'http://x', 'laptop')).toEqual({
			runner_id: 'rnr_1',
			token: 't1'
		});
		// A second runner under the same url does not clobber the first.
		saveRunnerCredentials(dir, 'http://x', 'desktop', { runner_id: 'rnr_2', token: 't2' });
		expect(loadRunnerCredentials(dir, 'http://x', 'laptop')?.runner_id).toBe('rnr_1');
		expect(credentialsKey('http://x//', 'laptop')).toBe('http://x#laptop');
	});

	it('clearRunnerCredentials drops only the named entry', () => {
		const dir = tempDir();
		saveRunnerCredentials(dir, 'http://x', 'a', { runner_id: 'rnr_a', token: 'ta' });
		saveRunnerCredentials(dir, 'http://x', 'b', { runner_id: 'rnr_b', token: 'tb' });
		clearRunnerCredentials(dir, 'http://x', 'a');
		expect(loadRunnerCredentials(dir, 'http://x', 'a')).toBeNull();
		expect(loadRunnerCredentials(dir, 'http://x', 'b')?.runner_id).toBe('rnr_b');
	});

	it('a corrupt store reads as empty instead of crashing', () => {
		const dir = tempDir();
		writeFileSync(join(dir, 'runners.json'), 'not json');
		expect(loadRunnerCredentials(dir, 'http://x', 'a')).toBeNull();
		// And saving over it recovers.
		saveRunnerCredentials(dir, 'http://x', 'a', { runner_id: 'rnr_a', token: 'ta' });
		expect(loadRunnerCredentials(dir, 'http://x', 'a')?.token).toBe('ta');
	});

	it('the credentials file is written user-only (0600)', () => {
		const dir = tempDir();
		saveRunnerCredentials(dir, 'http://x', 'a', { runner_id: 'rnr_a', token: 'secret' });
		expect(readFileSync(join(dir, 'runners.json'), 'utf8')).toContain('secret');
		expect(statSync(join(dir, 'runners.json')).mode & 0o777).toBe(0o600);
	});
});

describe('processStartTimeMs', () => {
	it('returns a plausible start time for the current process on Linux, null for a bogus pid', () => {
		const own = processStartTimeMs(process.pid);
		if (process.platform === 'linux') {
			expect(own).not.toBeNull();
			// Started some time before now, and after 2020.
			expect(own!).toBeLessThanOrEqual(Date.now() + 1000);
			expect(own!).toBeGreaterThan(Date.UTC(2020, 0, 1));
		}
		expect(processStartTimeMs(2 ** 30)).toBeNull();
	});
});

describe('daemon state file', () => {
	it('round-trips entries and tolerates a missing or corrupt file', () => {
		const dir = tempDir();
		const path = daemonStatePath(dir, 'rnr_1');
		expect(loadDaemonState(path)).toEqual([]);
		const entries = [
			{ run_id: 'arun_1', pid: 123, workspace: join(dir, 'ws1'), key_fingerprint: 'tines_abc' }
		];
		saveDaemonState(path, entries);
		expect(loadDaemonState(path)).toEqual(entries);
		writeFileSync(path, '{broken');
		expect(loadDaemonState(path)).toEqual([]);
	});

	it('round-trips started_at for the orphan kill PID-reuse check', () => {
		const dir = tempDir();
		const path = daemonStatePath(dir, 'rnr_1');
		const entries = [
			{ run_id: 'arun_1', pid: 1, workspace: '/w', key_fingerprint: 'f', started_at: 1234 }
		];
		saveDaemonState(path, entries);
		expect(loadDaemonState(path)[0].started_at).toBe(1234);
	});

	it("round-trips issue_ref, so an orphan's kept workspace can name its issue", () => {
		const dir = tempDir();
		const path = daemonStatePath(dir, 'rnr_1');
		saveDaemonState(path, [
			{ run_id: 'arun_1', pid: 1, workspace: '/w', key_fingerprint: 'f', issue_ref: 'Tines/19' }
		]);
		expect(loadDaemonState(path)[0].issue_ref).toBe('Tines/19');
		// An entry written by an older daemon has none, and still loads.
		saveDaemonState(path, [{ run_id: 'arun_2', pid: 2, workspace: '/w', key_fingerprint: 'f' }]);
		expect(loadDaemonState(path)[0].issue_ref).toBeUndefined();
	});

	it('filters malformed entries', () => {
		const dir = tempDir();
		const path = daemonStatePath(dir, 'rnr_1');
		writeFileSync(
			path,
			JSON.stringify({
				runs: [
					{ run_id: 'ok', pid: 1, workspace: '/w', key_fingerprint: 'f' },
					{ run_id: 42, pid: 'nope' },
					null
				]
			})
		);
		expect(loadDaemonState(path).map((e) => e.run_id)).toEqual(['ok']);
	});
});

describe('kept workspaces', () => {
	/** A workspace directory under a config dir, marked kept unless `bare`. */
	function workspace(
		configDir: string,
		runId: string,
		opts: { keptAt?: string; bare?: boolean; corrupt?: boolean; issueRef?: string } = {}
	): string {
		const path = join(workspacesDir(configDir), runId);
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, 'prompt.md'), 'do the thing\n');
		if (opts.bare) return path;
		if (opts.corrupt) {
			writeFileSync(keptMarkerPath(path), '{not json');
			return path;
		}
		writeKeptMarker(path, {
			run_id: runId,
			...(opts.issueRef ? { issue_ref: opts.issueRef } : {}),
			status: 'failed',
			error: 'harness exited with code 1',
			kept_at: opts.keptAt ?? new Date(0).toISOString()
		});
		return path;
	}

	it('round-trips a marker and lists only marked directories, newest first', () => {
		const dir = tempDir();
		expect(listKeptWorkspaces(dir)).toEqual([]);
		const older = workspace(dir, 'arun_old', { keptAt: '2026-01-01T00:00:00.000Z' });
		const newer = workspace(dir, 'arun_new', {
			keptAt: '2026-02-01T00:00:00.000Z',
			issueRef: 'Tines/19'
		});
		// Neither an unmarked live workspace nor a corrupt marker is ours to
		// report — the directory is shared by every daemon on the machine.
		workspace(dir, 'arun_live', { bare: true });
		workspace(dir, 'arun_corrupt', { corrupt: true });
		const kept = listKeptWorkspaces(dir);
		expect(kept.map((k) => k.path)).toEqual([newer, older]);
		expect(kept[0]).toMatchObject({
			run_id: 'arun_new',
			issue_ref: 'Tines/19',
			status: 'failed',
			error: 'harness exited with code 1'
		});
	});

	it('prunes past the age window, keeping younger ones', () => {
		const dir = tempDir();
		const stale = workspace(dir, 'arun_stale', { keptAt: '2026-01-01T00:00:00.000Z' });
		const fresh = workspace(dir, 'arun_fresh', { keptAt: '2026-01-04T00:00:00.000Z' });
		const now = () => Date.parse('2026-01-05T00:00:00.000Z');
		const removed = pruneKeptWorkspaces(dir, { maxAgeMs: 48 * 3600_000, now });
		expect(removed.map((r) => r.run_id)).toEqual(['arun_stale']);
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
	});

	it('trims the oldest beyond maxCount', () => {
		const dir = tempDir();
		for (const [runId, day] of [
			['arun_1', '01'],
			['arun_2', '02'],
			['arun_3', '03']
		] as const) {
			workspace(dir, runId, { keptAt: `2026-01-${day}T00:00:00.000Z` });
		}
		const removed = pruneKeptWorkspaces(dir, {
			maxCount: 2,
			now: () => Date.parse('2026-01-04T00:00:00.000Z')
		});
		expect(removed.map((r) => r.run_id)).toEqual(['arun_1']);
		expect(listKeptWorkspaces(dir).map((k) => k.run_id)).toEqual(['arun_3', 'arun_2']);
	});

	it('--all removes every kept workspace but never a live, unmarked one', () => {
		const dir = tempDir();
		workspace(dir, 'arun_kept');
		const live = workspace(dir, 'arun_live', { bare: true });
		const corrupt = workspace(dir, 'arun_corrupt', { corrupt: true });
		const removed = pruneKeptWorkspaces(dir, { all: true });
		expect(removed.map((r) => r.run_id)).toEqual(['arun_kept']);
		expect(listKeptWorkspaces(dir)).toEqual([]);
		// The whole point: another daemon's in-flight run survives the sweep.
		expect(existsSync(live)).toBe(true);
		expect(existsSync(corrupt)).toBe(true);
	});

	it('directorySizeBytes counts a tree, and 0 for what it cannot read', () => {
		const dir = tempDir();
		const path = workspace(dir, 'arun_1', { bare: true });
		mkdirSync(join(path, 'repo', 'src'), { recursive: true });
		writeFileSync(join(path, 'repo', 'src', 'a.txt'), 'x'.repeat(100));
		writeFileSync(join(path, 'repo', 'b.txt'), 'y'.repeat(50));
		// The seeded prompt.md is in there too, so this is a lower bound.
		expect(directorySizeBytes(path)).toBeGreaterThanOrEqual(150);
		expect(directorySizeBytes(join(dir, 'nope'))).toBe(0);
	});
});
