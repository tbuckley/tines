import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	clearRunnerCredentials,
	credentialsKey,
	daemonStatePath,
	loadDaemonState,
	loadRunnerCredentials,
	saveDaemonState,
	saveRunnerCredentials
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
