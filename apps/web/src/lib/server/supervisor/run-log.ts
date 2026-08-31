/**
 * Full run logs: spill, compaction, sealing, and retention (Tines/66).
 *
 * The D1 tail (`appendLogTail`) is unchanged and still the fast path for the
 * live viewer. This module catches what the tail throws away: every append
 * that evicts bytes writes exactly the evicted prefix to the run-log bucket
 * first, so `parts + head + current tail` always equals the complete log,
 * with no byte stored twice and no R2 write at all for a run that stays
 * under the cap.
 *
 * Three lifecycle stages keep the object count away from the Worker's
 * ~1,000-subrequest ceiling, which a naive object-per-chunk scheme would hit
 * on exactly the large logs this exists for:
 *   spill    one `part.{n}` per eviction, written before the D1 update
 *   compact  the sweep merges ≥COMPACT_TRIGGER parts into a single `head`
 *   seal     run end concatenates head + parts + tail into one `full` object
 * Every stage is idempotent and re-runnable: a lost CAS just means the next
 * sweep redoes the work, and rewriting `head`/`full` for the same range
 * produces identical bytes.
 */

import { sql, type CompiledQuery, type Kysely } from 'kysely';
import type { D1Result } from '@cloudflare/workers-types';
import { RUN_LOG_RETENTION_MS } from '@tines/shared';
import { idChunks, type Database } from '$lib/server/db';
import {
	getRunLogStore,
	runIdFromLogKey,
	runLogFullKey,
	runLogHeadKey,
	runLogPartKey,
	runLogPrefix,
	type RunLogStore
} from '$lib/server/run-log-store';

/** Unmerged parts at or above this trigger a compaction pass. */
export const COMPACT_TRIGGER = 64;
/** Most parts merged into `head` in one pass (bounds subrequests). */
export const COMPACT_MAX_PER_PASS = 256;
/** Runs compacted, sealed, or retention-GC'd per sweep pass. */
export const SWEEP_BATCH = 20;
export const RETENTION_BATCH = 50;
/**
 * Beyond this many unmerged parts a live read would spend too many
 * subrequests; the reader asks the caller to retry after the next sweep.
 */
export const READ_MAX_PARTS = 500;

const encoder = new TextEncoder();

// core.ts is off-limits under supervisor/ (it imports @sveltejs/kit), so this
// module carries the same local batch helper engine.ts does.
async function runBatch(env: Env, queries: CompiledQuery[]): Promise<D1Result[]> {
	if (queries.length === 0) return [];
	return env.DB.batch(queries.map((q) => env.DB.prepare(q.sql).bind(...(q.parameters as unknown[]))));
}

export interface SpillableRun {
	id: string;
	user_id: string;
	log_part_count: number;
	log_compacted_through: number;
}

/**
 * Writes an evicted log prefix to R2 and returns the patch columns the
 * caller must include in its guarded UPDATE. The object lands *before* the
 * D1 write, so D1 never claims bytes R2 does not hold; the reverse (an
 * object whose UPDATE then lost a race) is a harmless orphan the GC sweeps.
 */
export async function spillEvicted(
	env: Env,
	run: SpillableRun,
	evicted: Uint8Array
): Promise<{ log_part_count: number }> {
	const index = run.log_part_count + 1;
	const store = getRunLogStore(env);
	await store.put(runLogPartKey(run.user_id, run.id, index), evicted);
	return { log_part_count: index };
}

// ---------------------------------------------------------------------------
// Assembly: head + unmerged parts, in order

async function readParts(
	store: RunLogStore,
	userId: string,
	runId: string,
	from: number,
	to: number
): Promise<Uint8Array[]> {
	const out: Uint8Array[] = [];
	for (let i = from; i <= to; i++) {
		const bytes = await store.get(runLogPartKey(userId, runId, i));
		// A missing part is a spill whose D1 update lost its race, or an
		// already-merged part the previous pass deleted: skip, never fail.
		if (bytes) out.push(bytes);
	}
	return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((n, c) => n + c.length, 0);
	const joined = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		joined.set(c, at);
		at += c.length;
	}
	return joined;
}

// ---------------------------------------------------------------------------
// Compaction

export interface CompactableRun {
	id: string;
	user_id: string;
	log_part_count: number;
	log_compacted_through: number;
}

/**
 * Merges up to `COMPACT_MAX_PER_PASS` unmerged parts into the run's `head`
 * object and deletes them. Returns the new `log_compacted_through`, or null
 * when there was nothing to do (or the D1 CAS was lost, in which case the
 * next pass redoes it).
 */
export async function compactRunLog(
	db: Kysely<Database>,
	env: Env,
	run: CompactableRun
): Promise<number | null> {
	const from = run.log_compacted_through + 1;
	const to = Math.min(run.log_part_count, run.log_compacted_through + COMPACT_MAX_PER_PASS);
	if (to < from) return null;
	const store = getRunLogStore(env);
	const headKey = runLogHeadKey(run.user_id, run.id);
	const head = await store.get(headKey);
	const parts = await readParts(store, run.user_id, run.id, from, to);
	await store.put(headKey, concat(head ? [head, ...parts] : parts));
	// Only now are the parts redundant. A crash between put and delete leaves
	// merged parts behind; the CAS below not landing means the next pass
	// re-merges them into head — identical bytes, so still correct.
	await store.delete(
		Array.from({ length: to - from + 1 }, (_, i) => runLogPartKey(run.user_id, run.id, from + i))
	);
	const [res] = await runBatch(env, [
		db
			.updateTable('agent_run')
			.set({ log_compacted_through: to })
			.where('id', '=', run.id)
			.where('log_compacted_through', '=', run.log_compacted_through)
			.compile()
	]);
	return (res?.meta.changes ?? 0) > 0 ? to : null;
}

// ---------------------------------------------------------------------------
// Sealing

export interface SealableRun {
	id: string;
	user_id: string;
	log: string;
	log_bytes_dropped: number;
	log_part_count: number;
	log_compacted_through: number;
	log_sealed: number;
}

/**
 * Writes the run's complete log to one `full` object and drops the head and
 * parts. A no-op for a run that never spilled — there the tail *is* the full
 * log — and for an already-sealed run.
 *
 * Safe to call repeatedly: it rebuilds `full` from whatever survives, and
 * because the append path's `status IN ACTIVE` guard closes the tail the
 * moment the run's status flips, the tail read here is final.
 *
 * Returns false when it declined (nothing spilled, already sealed, or too
 * many unmerged parts for one pass — the sweep compacts then retries).
 */
export async function sealRunLog(db: Kysely<Database>, env: Env, run: SealableRun): Promise<boolean> {
	if (run.log_bytes_dropped === 0 || run.log_sealed === 1) return false;
	const unmerged = run.log_part_count - run.log_compacted_through;
	if (unmerged > COMPACT_MAX_PER_PASS) return false;
	const store = getRunLogStore(env);
	const head = await store.get(runLogHeadKey(run.user_id, run.id));
	const parts = await readParts(
		store,
		run.user_id,
		run.id,
		run.log_compacted_through + 1,
		run.log_part_count
	);
	const chunks = [...(head ? [head] : []), ...parts, encoder.encode(run.log)];
	await store.put(runLogFullKey(run.user_id, run.id), concat(chunks));
	const [res] = await runBatch(env, [
		db
			.updateTable('agent_run')
			.set({ log_sealed: 1 })
			.where('id', '=', run.id)
			.where('log_sealed', '=', 0)
			.compile()
	]);
	if ((res?.meta.changes ?? 0) === 0) return false;
	await store.delete([
		runLogHeadKey(run.user_id, run.id),
		...Array.from({ length: run.log_part_count }, (_, i) => runLogPartKey(run.user_id, run.id, i + 1))
	]);
	return true;
}

/** Loads the columns `sealRunLog` needs. Undefined when the run is gone. */
export async function loadSealableRun(
	db: Kysely<Database>,
	runId: string
): Promise<SealableRun | undefined> {
	return db
		.selectFrom('agent_run')
		.select([
			'id',
			'user_id',
			'log',
			'log_bytes_dropped',
			'log_part_count',
			'log_compacted_through',
			'log_sealed'
		])
		.where('id', '=', runId)
		.executeTakeFirst();
}

// ---------------------------------------------------------------------------
// Reading

export interface ReadableRun {
	id: string;
	user_id: string;
	log: string;
	log_bytes_dropped: number;
	log_part_count: number;
	log_compacted_through: number;
	log_sealed: number;
	log_objects_deleted_at: number | null;
}

export type RunLogRead =
	| { kind: 'tail'; text: string }
	| { kind: 'stream'; body: ReadableStream<Uint8Array>; size: number }
	| { kind: 'expired' }
	| { kind: 'not_ready' };

/**
 * The complete log, however it is currently stored: the tail alone for a run
 * that never spilled, one streamed object for a sealed run, or a live
 * assembly of head + parts + tail for a run still going.
 */
export async function readRunLog(env: Env, run: ReadableRun): Promise<RunLogRead> {
	if (run.log_bytes_dropped === 0) return { kind: 'tail', text: run.log };
	if (run.log_objects_deleted_at !== null) return { kind: 'expired' };
	const store = getRunLogStore(env);
	if (run.log_sealed === 1) {
		const sealed = await store.getStream(runLogFullKey(run.user_id, run.id));
		if (sealed) return { kind: 'stream', body: sealed.body, size: sealed.size };
		// Sealed but the object is gone (GC raced, or a manual delete): the
		// tail is all that is left, and it is better than an error.
		return { kind: 'tail', text: run.log };
	}
	const unmerged = run.log_part_count - run.log_compacted_through;
	if (unmerged > READ_MAX_PARTS) return { kind: 'not_ready' };
	const head = await store.get(runLogHeadKey(run.user_id, run.id));
	const parts = await readParts(
		store,
		run.user_id,
		run.id,
		run.log_compacted_through + 1,
		run.log_part_count
	);
	const joined = concat([...(head ? [head] : []), ...parts, encoder.encode(run.log)]);
	return {
		kind: 'stream',
		size: joined.length,
		body: new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(joined);
				controller.close();
			}
		})
	};
}

// ---------------------------------------------------------------------------
// Retention and orphan GC

/**
 * Deletes every object of a run's log. Used by retention, by runner deletion
 * (R2 cannot join a D1 `batch()`, so it runs after the batch succeeds), and
 * by the orphan pass.
 */
export async function deleteRunLogObjects(env: Env, userId: string, runId: string): Promise<void> {
	await getRunLogStore(env).deletePrefix(runLogPrefix(userId, runId));
}

/**
 * Retention: drops the R2 objects of runs that ended more than
 * `RUN_LOG_RETENTION_MS` ago. The D1 tail is deliberately untouched — run
 * history keeps reading exactly as it did before full logs existed.
 */
export async function gcExpiredRunLogs(db: Kysely<Database>, env: Env, now: number): Promise<number> {
	const rows = await db
		.selectFrom('agent_run')
		.select(['id', 'user_id'])
		.where('ended_at', 'is not', null)
		.where('ended_at', '<=', now - RUN_LOG_RETENTION_MS)
		.where('log_objects_deleted_at', 'is', null)
		.where((eb) => eb.or([eb('log_bytes_dropped', '>', 0), eb('log_raw_bytes', '>', 0)]))
		.limit(RETENTION_BATCH)
		.execute();
	for (const row of rows) {
		try {
			await deleteRunLogObjects(env, row.user_id, row.id);
			await runBatch(env, [
				db
					.updateTable('agent_run')
					.set({ log_objects_deleted_at: now, log_raw_bytes: 0 })
					.where('id', '=', row.id)
					.compile()
			]);
		} catch (e) {
			console.error(`run-log retention for run ${row.id} failed:`, e);
		}
	}
	return rows.length;
}

/** Where the orphan pass left off, in `supervisor_sweep_state`. */
export const RUN_LOG_GC_CURSOR_KEY = 'run_log_gc_after';

async function readSweepState(db: Kysely<Database>, key: string): Promise<string | null> {
	const row = await db
		.selectFrom('supervisor_sweep_state')
		.select('value')
		.where('key', '=', key)
		.executeTakeFirst();
	return row?.value ?? null;
}

async function writeSweepState(
	db: Kysely<Database>,
	env: Env,
	key: string,
	value: string | null,
	now: number
): Promise<void> {
	await runBatch(env, [
		db
			.insertInto('supervisor_sweep_state')
			.values({ key, value, updated_at: now })
			.onConflict((oc) => oc.column('key').doUpdateSet({ value, updated_at: now }))
			.compile()
	]);
}

/**
 * Orphan backstop: one list page per sweep of objects whose run row is gone
 * (deleted with its runner, cascaded with its user, or a spill whose D1
 * update lost its race). Without this those bytes would live forever — the
 * retention pass above is driven by run rows that no longer exist.
 *
 * The page has to *rotate*. R2 lists lexicographically, so a pass that always
 * started at the top would re-inspect the same first page forever, and since
 * live runs vastly outnumber orphans it would spend every sweep confirming
 * that live runs are live while orphans deeper in the keyspace were never
 * looked at. So each pass resumes after the last key the previous one saw and
 * wraps around at the end. `startAfter` rather than an opaque list cursor:
 * it stays meaningful across sweeps, and across a deploy.
 */
export async function gcOrphanedRunLogs(
	db: Kysely<Database>,
	env: Env,
	now: number
): Promise<number> {
	const store = getRunLogStore(env);
	const after = await readSweepState(db, RUN_LOG_GC_CURSOR_KEY);
	const page = await store.list('runlog/', { startAfter: after ?? undefined });
	if (page.keys.length === 0) {
		// End of the keyspace (or an empty bucket): start over next sweep.
		if (after !== null) await writeSweepState(db, env, RUN_LOG_GC_CURSOR_KEY, null, now);
		return 0;
	}
	const byRun = new Map<string, string[]>();
	for (const key of page.keys) {
		const runId = runIdFromLogKey(key);
		if (!runId) continue;
		const keys = byRun.get(runId);
		if (keys) keys.push(key);
		else byRun.set(runId, [key]);
	}
	const ids = [...byRun.keys()];
	// One page is up to 1,000 keys, so this `IN` list is not something the
	// caller bounds — it has to be chunked or D1 rejects the statement, and
	// `sweepRunLogs` would swallow the throw and silently collect nothing.
	const liveIds = new Set<string>();
	for (const chunk of idChunks(ids)) {
		const rows = await db.selectFrom('agent_run').select('id').where('id', 'in', chunk).execute();
		for (const row of rows) liveIds.add(row.id);
	}
	const doomed = ids.filter((id) => !liveIds.has(id)).flatMap((id) => byRun.get(id) ?? []);
	await store.delete(doomed);
	// Advance only after the delete lands: a throw above leaves the position
	// where it was and the next sweep retries this page.
	await writeSweepState(db, env, RUN_LOG_GC_CURSOR_KEY, page.keys[page.keys.length - 1], now);
	return doomed.length;
}

// ---------------------------------------------------------------------------
// The sweep arms

/**
 * Compacts runs whose unmerged part count has grown past the trigger, then
 * seals ended runs whose logs are still in pieces (endRun seals inline; this
 * catches the runs whose inline seal failed or was skipped).
 */
export async function sweepRunLogs(db: Kysely<Database>, env: Env, now: number): Promise<void> {
	const needCompaction = await db
		.selectFrom('agent_run')
		.select(['id', 'user_id', 'log_part_count', 'log_compacted_through'])
		.where('log_objects_deleted_at', 'is', null)
		.where(sql<boolean>`log_part_count - log_compacted_through >= ${COMPACT_TRIGGER}`)
		.limit(SWEEP_BATCH)
		.execute();
	for (const run of needCompaction) {
		try {
			await compactRunLog(db, env, run);
		} catch (e) {
			console.error(`run-log compaction for run ${run.id} failed:`, e);
		}
	}

	const unsealed = await db
		.selectFrom('agent_run')
		.select([
			'id',
			'user_id',
			'log',
			'log_bytes_dropped',
			'log_part_count',
			'log_compacted_through',
			'log_sealed'
		])
		.where('ended_at', 'is not', null)
		.where('log_bytes_dropped', '>', 0)
		.where('log_sealed', '=', 0)
		.where('log_objects_deleted_at', 'is', null)
		.limit(SWEEP_BATCH)
		.execute();
	for (const run of unsealed) {
		try {
			await sealRunLog(db, env, run);
		} catch (e) {
			console.error(`run-log seal for run ${run.id} failed:`, e);
		}
	}

	try {
		await gcExpiredRunLogs(db, env, now);
	} catch (e) {
		console.error('run-log retention pass failed:', e);
	}
	try {
		await gcOrphanedRunLogs(db, env, now);
	} catch (e) {
		console.error('run-log orphan pass failed:', e);
	}
}
