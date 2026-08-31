import { describe, expect, it } from 'vitest';
import { RUN_LOG_MAX_BYTES, RUN_LOG_RETENTION_MS } from '@tines/shared';
import { appendRunLog } from '../api/runner-protocol';
import { IN_LIST_CHUNK } from '../db';
import { createTestDb, type TestDb } from '../api/test-db';
import {
	getRunLogStore,
	runLogFullKey,
	runLogHeadKey,
	runLogPartKey,
	runLogPrefix,
	type MemoryRunLogStore
} from '../run-log-store';
import { NOW, USER, addIssue, addRun, addRunner, seedBase, setSettings } from './test-fixtures';
import {
	COMPACT_TRIGGER,
	compactRunLog,
	gcExpiredRunLogs,
	gcOrphanedRunLogs,
	loadSealableRun,
	readRunLog,
	RUN_LOG_GC_CURSOR_KEY,
	sealRunLog,
	sweepRunLogs
} from './run-log';
import type { RunnerRow } from '../api/runner-protocol';

/**
 * These tests exercise the promise the feature makes: every byte the 256 KB
 * D1 tail evicts is retrievable afterwards. The store is the in-memory
 * fallback (the fake Env has no RUN_LOGS binding), memoized per Env, so a
 * test's writes are visible to its own reads.
 */

function world(): TestDb {
	const t = createTestDb();
	seedBase(t);
	setSettings(t);
	return t;
}

function store(t: TestDb): MemoryRunLogStore {
	return getRunLogStore(t.env) as MemoryRunLogStore;
}

async function runnerRow(t: TestDb, id: string): Promise<RunnerRow> {
	const row = await t.db.selectFrom('runner').selectAll().where('id', '=', id).executeTakeFirst();
	if (!row) throw new Error(`no runner ${id}`);
	return row;
}

function runById(t: TestDb, id: string) {
	return t.sqlite.prepare('SELECT * FROM agent_run WHERE id = ?').get(id) as Record<string, unknown>;
}

/** A run on a live local runner, ready to take log appends. */
async function liveRun(t: TestDb): Promise<{ runId: string; runner: RunnerRow }> {
	const runnerId = addRunner(t);
	const issue = addIssue(t);
	const runId = addRun(t, { issueId: issue, runnerId, status: 'running', startedAt: NOW });
	return { runId, runner: await runnerRow(t, runnerId) };
}

async function readAll(t: TestDb, runId: string): Promise<string> {
	const run = await t.db
		.selectFrom('agent_run')
		.select([
			'id',
			'user_id',
			'log',
			'log_bytes_dropped',
			'log_part_count',
			'log_compacted_through',
			'log_sealed',
			'log_objects_deleted_at'
		])
		.where('id', '=', runId)
		.executeTakeFirst();
	if (!run) throw new Error('no run');
	const result = await readRunLog(t.env, run);
	if (result.kind === 'tail') return result.text;
	if (result.kind !== 'stream') throw new Error(`unexpected read kind ${result.kind}`);
	const chunks: Uint8Array[] = [];
	const reader = result.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) chunks.push(value);
	}
	const total = chunks.reduce((n, c) => n + c.length, 0);
	const joined = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		joined.set(c, at);
		at += c.length;
	}
	expect(joined.length).toBe(result.size);
	return new TextDecoder().decode(joined);
}

describe('spill on eviction', () => {
	it('writes nothing to the store while the log stays under the cap', async () => {
		const t = world();
		const { runId, runner } = await liveRun(t);
		await appendRunLog(t.db, t.env, runner, runId, 'hello\n', NOW);
		expect(store(t).count()).toBe(0);
		expect(runById(t, runId).log_part_count).toBe(0);
		// And a read is just the tail — the fast path, no store round trip.
		expect(await readAll(t, runId)).toBe('hello\n');
	});

	it('spills exactly the evicted prefix, so parts + tail are every byte', async () => {
		const t = world();
		const { runId, runner } = await liveRun(t);
		const first = 'a'.repeat(RUN_LOG_MAX_BYTES);
		const second = 'b'.repeat(1000);
		await appendRunLog(t.db, t.env, runner, runId, first, NOW);
		expect(store(t).count()).toBe(0);
		await appendRunLog(t.db, t.env, runner, runId, second, NOW);

		const run = runById(t, runId);
		expect(run.log_bytes_dropped).toBe(1000);
		expect(run.log_part_count).toBe(1);
		const part = await store(t).get(runLogPartKey(USER, runId, 1));
		expect(part && new TextDecoder().decode(part)).toBe('a'.repeat(1000));
		expect(await readAll(t, runId)).toBe(first + second);
	});

	it('reassembles multi-byte characters split across the eviction boundary', async () => {
		const t = world();
		const { runId, runner } = await liveRun(t);
		// Pad so the next append's eviction lands mid-character: 'é' is two
		// bytes, and we cut one byte into it.
		await appendRunLog(t.db, t.env, runner, runId, 'é' + 'x'.repeat(RUN_LOG_MAX_BYTES - 2), NOW);
		await appendRunLog(t.db, t.env, runner, runId, 'y', NOW);
		const run = runById(t, runId);
		// The cut advanced past the split character rather than through it, so
		// both halves are whole: 'é' (2 bytes) is evicted entire…
		expect(run.log_bytes_dropped).toBe(2);
		expect((run.log as string).startsWith('x')).toBe(true);
		// …and reassembly is byte-exact, with no U+FFFD anywhere.
		const full = await readAll(t, runId);
		expect(full.startsWith('é')).toBe(true);
		expect(full).toBe('é' + 'x'.repeat(RUN_LOG_MAX_BYTES - 2) + 'y');
	});

	it('accumulates one part per eviction across many appends', async () => {
		const t = world();
		const { runId, runner } = await liveRun(t);
		await appendRunLog(t.db, t.env, runner, runId, 'x'.repeat(RUN_LOG_MAX_BYTES), NOW);
		let expected = 'x'.repeat(RUN_LOG_MAX_BYTES);
		for (let i = 0; i < 5; i++) {
			const chunk = `chunk-${i}-`.padEnd(500, '.');
			await appendRunLog(t.db, t.env, runner, runId, chunk, NOW);
			expected += chunk;
		}
		expect(runById(t, runId).log_part_count).toBe(5);
		expect(await readAll(t, runId)).toBe(expected);
	});
});

describe('chunk seq idempotency', () => {
	it('ignores a resent chunk and echoes the applied seq', async () => {
		const t = world();
		const { runId, runner } = await liveRun(t);
		const first = await appendRunLog(t.db, t.env, runner, runId, 'one\n', NOW, 1);
		expect(first.log_seq).toBe(1);
		// The daemon never saw the response and resends the same chunk.
		const retry = await appendRunLog(t.db, t.env, runner, runId, 'one\n', NOW, 1);
		expect(retry.log_seq).toBe(1);
		expect(runById(t, runId).log).toBe('one\n');
		// The next seq still applies normally.
		await appendRunLog(t.db, t.env, runner, runId, 'two\n', NOW, 2);
		expect(runById(t, runId).log).toBe('one\ntwo\n');
	});

	it('does not spill twice for a retried chunk that evicts bytes', async () => {
		const t = world();
		const { runId, runner } = await liveRun(t);
		await appendRunLog(t.db, t.env, runner, runId, 'x'.repeat(RUN_LOG_MAX_BYTES), NOW, 1);
		await appendRunLog(t.db, t.env, runner, runId, 'y'.repeat(100), NOW, 2);
		expect(store(t).count()).toBe(1);
		await appendRunLog(t.db, t.env, runner, runId, 'y'.repeat(100), NOW, 2);
		expect(store(t).count()).toBe(1);
		expect(runById(t, runId).log_bytes_dropped).toBe(100);
	});

	it('rejects a non-positive seq', async () => {
		const t = world();
		const { runId, runner } = await liveRun(t);
		await expect(appendRunLog(t.db, t.env, runner, runId, 'x', NOW, 0)).rejects.toMatchObject({
			code: 'invalid_field'
		});
	});
});

describe('compaction', () => {
	it('merges parts into head, deletes them, and preserves every byte', async () => {
		const t = world();
		const { runId, runner } = await liveRun(t);
		await appendRunLog(t.db, t.env, runner, runId, 'x'.repeat(RUN_LOG_MAX_BYTES), NOW);
		let expected = 'x'.repeat(RUN_LOG_MAX_BYTES);
		for (let i = 0; i < 4; i++) {
			const chunk = `p${i}`.padEnd(300, '-');
			await appendRunLog(t.db, t.env, runner, runId, chunk, NOW);
			expected += chunk;
		}
		const run = runById(t, runId);
		const merged = await compactRunLog(t.db, t.env, {
			id: runId,
			user_id: USER,
			log_part_count: run.log_part_count as number,
			log_compacted_through: 0
		});
		expect(merged).toBe(4);
		expect(store(t).keys(runLogPrefix(USER, runId))).toEqual([runLogHeadKey(USER, runId)]);
		expect(runById(t, runId).log_compacted_through).toBe(4);
		expect(await readAll(t, runId)).toBe(expected);
	});

	it('is a no-op when there is nothing unmerged', async () => {
		const t = world();
		const { runId } = await liveRun(t);
		const merged = await compactRunLog(t.db, t.env, {
			id: runId,
			user_id: USER,
			log_part_count: 3,
			log_compacted_through: 3
		});
		expect(merged).toBeNull();
	});

	it('keeps appending correctly after a compaction', async () => {
		const t = world();
		const { runId, runner } = await liveRun(t);
		await appendRunLog(t.db, t.env, runner, runId, 'x'.repeat(RUN_LOG_MAX_BYTES), NOW);
		let expected = 'x'.repeat(RUN_LOG_MAX_BYTES);
		for (let i = 0; i < 3; i++) {
			const chunk = `a${i}`.padEnd(400, '.');
			await appendRunLog(t.db, t.env, runner, runId, chunk, NOW);
			expected += chunk;
		}
		await compactRunLog(t.db, t.env, {
			id: runId,
			user_id: USER,
			log_part_count: 3,
			log_compacted_through: 0
		});
		const after = 'z'.repeat(400);
		await appendRunLog(t.db, t.env, runner, runId, after, NOW);
		expected += after;
		expect(runById(t, runId).log_part_count).toBe(4);
		expect(await readAll(t, runId)).toBe(expected);
	});
});

describe('sealing', () => {
	async function spilledRun(t: TestDb): Promise<{ runId: string; expected: string }> {
		const { runId, runner } = await liveRun(t);
		let expected = 'x'.repeat(RUN_LOG_MAX_BYTES);
		await appendRunLog(t.db, t.env, runner, runId, expected, NOW);
		for (let i = 0; i < 3; i++) {
			const chunk = `s${i}`.padEnd(600, '=');
			await appendRunLog(t.db, t.env, runner, runId, chunk, NOW);
			expected += chunk;
		}
		return { runId, expected };
	}

	it('writes one full object holding every appended byte, and drops the pieces', async () => {
		const t = world();
		const { runId, expected } = await spilledRun(t);
		const sealable = await loadSealableRun(t.db, runId);
		expect(await sealRunLog(t.db, t.env, sealable!)).toBe(true);
		expect(store(t).keys(runLogPrefix(USER, runId))).toEqual([runLogFullKey(USER, runId)]);
		const full = await store(t).get(runLogFullKey(USER, runId));
		expect(full && new TextDecoder().decode(full)).toBe(expected);
		expect(runById(t, runId).log_sealed).toBe(1);
		// And the read path now serves that one object.
		expect(await readAll(t, runId)).toBe(expected);
	});

	it('is a no-op on a second call', async () => {
		const t = world();
		const { runId } = await spilledRun(t);
		await sealRunLog(t.db, t.env, (await loadSealableRun(t.db, runId))!);
		expect(await sealRunLog(t.db, t.env, (await loadSealableRun(t.db, runId))!)).toBe(false);
	});

	it('declines a run that never spilled — the tail is already the full log', async () => {
		const t = world();
		const { runId, runner } = await liveRun(t);
		await appendRunLog(t.db, t.env, runner, runId, 'short\n', NOW);
		expect(await sealRunLog(t.db, t.env, (await loadSealableRun(t.db, runId))!)).toBe(false);
		expect(store(t).count()).toBe(0);
		expect(await readAll(t, runId)).toBe('short\n');
	});

	it('seals a compacted run from its head object', async () => {
		const t = world();
		const { runId, expected } = await spilledRun(t);
		await compactRunLog(t.db, t.env, {
			id: runId,
			user_id: USER,
			log_part_count: 3,
			log_compacted_through: 0
		});
		await sealRunLog(t.db, t.env, (await loadSealableRun(t.db, runId))!);
		const full = await store(t).get(runLogFullKey(USER, runId));
		expect(full && new TextDecoder().decode(full)).toBe(expected);
	});
});

describe('sweep housekeeping', () => {
	it('compacts a run past the trigger and seals an ended one', async () => {
		const t = world();
		const { runId, runner } = await liveRun(t);
		let expected = 'x'.repeat(RUN_LOG_MAX_BYTES);
		await appendRunLog(t.db, t.env, runner, runId, expected, NOW);
		for (let i = 0; i < COMPACT_TRIGGER; i++) {
			const chunk = `n${i}`.padEnd(120, '.');
			await appendRunLog(t.db, t.env, runner, runId, chunk, NOW);
			expected += chunk;
		}
		await sweepRunLogs(t.db, t.env, NOW);
		expect(runById(t, runId).log_compacted_through).toBe(COMPACT_TRIGGER);
		expect(await readAll(t, runId)).toBe(expected);

		// Now end it: the next sweep seals what endRun's inline attempt would.
		t.sqlite.prepare("UPDATE agent_run SET status='completed', ended_at=? WHERE id=?").run(NOW, runId);
		await sweepRunLogs(t.db, t.env, NOW);
		expect(runById(t, runId).log_sealed).toBe(1);
		expect(await readAll(t, runId)).toBe(expected);
	});

	it('drops objects past the retention window but keeps the D1 tail', async () => {
		const t = world();
		const { runId, runner } = await liveRun(t);
		await appendRunLog(t.db, t.env, runner, runId, 'x'.repeat(RUN_LOG_MAX_BYTES), NOW);
		await appendRunLog(t.db, t.env, runner, runId, 'y'.repeat(500), NOW);
		const endedAt = NOW - RUN_LOG_RETENTION_MS - 1;
		t.sqlite.prepare("UPDATE agent_run SET status='completed', ended_at=? WHERE id=?").run(endedAt, runId);

		expect(await gcExpiredRunLogs(t.db, t.env, NOW)).toBe(1);
		expect(store(t).count(runLogPrefix(USER, runId))).toBe(0);
		const run = runById(t, runId);
		expect(run.log_objects_deleted_at).toBe(NOW);
		expect((run.log as string).length).toBeGreaterThan(0);
		// The read path says so rather than serving a partial log.
		const readable = {
			id: runId,
			user_id: USER,
			log: run.log as string,
			log_bytes_dropped: run.log_bytes_dropped as number,
			log_part_count: run.log_part_count as number,
			log_compacted_through: run.log_compacted_through as number,
			log_sealed: run.log_sealed as number,
			log_objects_deleted_at: run.log_objects_deleted_at as number
		};
		expect((await readRunLog(t.env, readable)).kind).toBe('expired');
	});

	it('spares runs still inside the retention window', async () => {
		const t = world();
		const { runId, runner } = await liveRun(t);
		await appendRunLog(t.db, t.env, runner, runId, 'x'.repeat(RUN_LOG_MAX_BYTES), NOW);
		await appendRunLog(t.db, t.env, runner, runId, 'y'.repeat(500), NOW);
		t.sqlite.prepare("UPDATE agent_run SET status='completed', ended_at=? WHERE id=?").run(NOW - 1000, runId);
		expect(await gcExpiredRunLogs(t.db, t.env, NOW)).toBe(0);
		expect(store(t).count(runLogPrefix(USER, runId))).toBe(1);
	});

	it('collects objects whose run row is gone, and spares live ones', async () => {
		const t = world();
		const { runId, runner } = await liveRun(t);
		await appendRunLog(t.db, t.env, runner, runId, 'x'.repeat(RUN_LOG_MAX_BYTES), NOW);
		await appendRunLog(t.db, t.env, runner, runId, 'y'.repeat(500), NOW);
		// A run whose row was deleted with its runner (or a spill whose D1
		// update lost its race) leaves objects nothing else would ever reach.
		await store(t).put(runLogPartKey(USER, 'arun_ghost', 1), new TextEncoder().encode('orphan'));

		expect(await gcOrphanedRunLogs(t.db, t.env, NOW)).toBe(1);
		expect(store(t).count(runLogPrefix(USER, 'arun_ghost'))).toBe(0);
		expect(store(t).count(runLogPrefix(USER, runId))).toBe(1);
	});

	/**
	 * The append's UPDATE is guarded on `log_part_count`, so a concurrent
	 * append can make it change zero rows. Acking the chunk anyway would lose
	 * those bytes for good: the daemon is told they are safe and never
	 * resends. The race is injected here by mutating the row from inside the
	 * spill, i.e. exactly between the append's read and its write.
	 */
	it('re-reads and retries an append whose part-count guard lost', async () => {
		const t = world();
		const { runId, runner } = await liveRun(t);
		await appendRunLog(t.db, t.env, runner, runId, 'x'.repeat(RUN_LOG_MAX_BYTES), NOW);

		const s = store(t);
		const realPut = s.put.bind(s);
		let raced = false;
		s.put = async (key, body, size) => {
			if (!raced) {
				raced = true;
				// A concurrent append landed its own part first.
				t.sqlite
					.prepare('UPDATE agent_run SET log_part_count = log_part_count + 1 WHERE id = ?')
					.run(runId);
			}
			return realPut(key, body, size);
		};
		const res = await appendRunLog(t.db, t.env, runner, runId, 'y'.repeat(500), NOW);
		s.put = realPut;

		expect(raced).toBe(true);
		// The retry's write landed: the tail advanced and the bytes are there.
		expect(res.log_bytes_dropped).toBeGreaterThan(0);
		const run = runById(t, runId);
		expect(run.log_bytes_dropped).toBe(res.log_bytes_dropped);
		expect((run.log as string).endsWith('y'.repeat(500))).toBe(true);
	});

	/**
	 * One R2 list page is up to 1,000 keys, so the liveness check's `IN` list
	 * is sized by the bucket, not by us. D1 rejects a statement binding more
	 * than 100 parameters, and `sweepRunLogs` catches and logs the throw — so
	 * unchunked, the pass would silently collect nothing on any install past
	 * ~90 runs. The in-memory test D1 does not enforce the bound, so this
	 * asserts the chunking rather than relying on a crash.
	 */
	it('chunks the liveness query so a full page cannot exceed D1 bound parameters', async () => {
		const t = world();
		const ghosts = Array.from({ length: 95 }, (_, i) => `arun_ghost${String(i).padStart(3, '0')}`);
		for (const id of ghosts) {
			await store(t).put(runLogPartKey(USER, id, 1), new TextEncoder().encode('orphan'));
		}
		const seen = t.spyOnQueries();
		expect(await gcOrphanedRunLogs(t.db, t.env, NOW)).toBe(95);
		for (const id of ghosts) expect(store(t).count(runLogPrefix(USER, id))).toBe(0);

		const selects = seen().filter((q) => q.includes('from "agent_run"') && q.includes(' in ('));
		expect(selects.length).toBe(Math.ceil(95 / IN_LIST_CHUNK));
		for (const q of selects) {
			expect((q.match(/\?/g) ?? []).length).toBeLessThanOrEqual(IN_LIST_CHUNK);
		}
	});

	/**
	 * R2 lists lexicographically, so a pass that always started at the top
	 * would re-read the same page forever and never reach orphans deeper in
	 * the keyspace. Two live runs sit ahead of the ghost here, and the page
	 * holds one key.
	 */
	it('walks the keyspace across sweeps instead of re-reading the first page', async () => {
		const t = world();
		const s = store(t);
		s.pageSize = 1;
		const { runId, runner } = await liveRun(t);
		await appendRunLog(t.db, t.env, runner, runId, 'x'.repeat(RUN_LOG_MAX_BYTES), NOW);
		await appendRunLog(t.db, t.env, runner, runId, 'y'.repeat(500), NOW);
		// Sorts after the live run's key, so a non-rotating pass never sees it.
		await s.put(runLogPartKey(USER, 'zzz_ghost', 1), new TextEncoder().encode('orphan'));
		expect(s.keys('runlog/').length).toBe(2);

		// First pass sees only the live run's part and collects nothing…
		expect(await gcOrphanedRunLogs(t.db, t.env, NOW)).toBe(0);
		expect(s.count(runLogPrefix(USER, 'zzz_ghost'))).toBe(1);
		// …the second resumes after it and reaches the orphan.
		expect(await gcOrphanedRunLogs(t.db, t.env, NOW)).toBe(1);
		expect(s.count(runLogPrefix(USER, 'zzz_ghost'))).toBe(0);

		// Past the end the position resets, so the walk wraps around.
		expect(await gcOrphanedRunLogs(t.db, t.env, NOW)).toBe(0);
		const cursor = t.sqlite
			.prepare('SELECT value FROM supervisor_sweep_state WHERE key = ?')
			.get(RUN_LOG_GC_CURSOR_KEY) as { value: string | null } | undefined;
		expect(cursor?.value).toBe(null);
	});
});
