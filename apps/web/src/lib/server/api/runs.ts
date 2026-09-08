import {
	ACTIVE_RUN_STATUSES,
	type AgentRun,
	type AgentRunDetail,
	type AgentRunUsage,
	type ModelTier,
	type RunEndOutcome,
	type RunStatus
} from '@tines/shared';
import type { Kysely } from 'kysely';
import type { Database } from '$lib/server/db';
import { getRunLogStore, runLogRawKey } from '$lib/server/run-log-store';
import { readRunLog } from '$lib/server/supervisor/run-log';
import { ApiFail, notFound, type Page } from './core';

export function runQuery(db: Kysely<Database>, userId: string) {
	return (
		db
			.selectFrom('agent_run')
			.innerJoin('runner', 'runner.id', 'agent_run.runner_id')
			.innerJoin('issue', 'issue.id', 'agent_run.issue_id')
			.innerJoin('project', 'project.id', 'issue.project_id')
			// State names survive workflow edits loosely: left joins, ids kept.
			.leftJoin('workflow_state as start_state', 'start_state.id', 'agent_run.state_id_at_start')
			.leftJoin('workflow_state as end_state', 'end_state.id', 'agent_run.state_id_at_end')
			.selectAll('agent_run')
			.select([
				'runner.name as runner_name',
				'issue.number as issue_number',
				'issue.title as issue_title',
				'project.name as project_name',
				'start_state.name as start_state_name',
				'end_state.name as end_state_name'
			])
			.where('agent_run.user_id', '=', userId)
	);
}

type RunRow = Awaited<ReturnType<ReturnType<typeof runQuery>['execute']>>[number];

function parseUsage(raw: string | null): AgentRunUsage | null {
	if (!raw) return null;
	try {
		return JSON.parse(raw) as AgentRunUsage;
	} catch {
		return null;
	}
}

export function serializeRun(row: RunRow): AgentRun {
	return {
		id: row.id,
		issue_id: row.issue_id,
		issue_ref: {
			project_name: row.project_name,
			number: row.issue_number,
			title: row.issue_title
		},
		runner_id: row.runner_id,
		runner_name: row.runner_name,
		status: row.status as RunStatus,
		outcome: (row.outcome as RunEndOutcome | null) ?? null,
		tier: row.tier as ModelTier,
		model: row.model,
		usage: parseUsage(row.usage),
		state_id_at_start: row.state_id_at_start,
		state_at_start_name: row.start_state_name,
		state_id_at_end: row.state_id_at_end,
		state_at_end_name: row.end_state_name,
		provider_session_id: row.provider_session_id,
		provider_url: row.provider_url,
		error: row.error,
		created_at: row.created_at,
		started_at: row.started_at,
		ended_at: row.ended_at
	};
}

function serializeRunDetail(row: RunRow): AgentRunDetail {
	return {
		...serializeRun(row),
		log: row.log,
		log_bytes_dropped: row.log_bytes_dropped,
		// The dropped bytes ARE the spilled bytes, so the complete log's size
		// is always the sum — no extra column, and no growth in this payload
		// (the run page polls it every 3 seconds).
		log_full_bytes: row.log_bytes_dropped + new TextEncoder().encode(row.log).length,
		log_raw_bytes: row.log_raw_bytes,
		log_expired: row.log_objects_deleted_at !== null
	};
}

export interface RunListFilters {
	/** Issue id. */
	issue?: string;
	/** Runner id. */
	runner?: string;
	/** Workflow state id captured when the run started. */
	state?: string;
	/** Only runs holding a claim (assigned/launching/running). */
	active?: boolean;
}

export async function listRuns(
	db: Kysely<Database>,
	userId: string,
	filters: RunListFilters,
	page: Page
): Promise<{ items: AgentRun[]; hasMore: boolean }> {
	let q = runQuery(db, userId);
	if (filters.issue) q = q.where('agent_run.issue_id', '=', filters.issue);
	if (filters.runner) q = q.where('agent_run.runner_id', '=', filters.runner);
	if (filters.state) q = q.where('agent_run.state_id_at_start', '=', filters.state);
	if (filters.active) q = q.where('agent_run.status', 'in', [...ACTIVE_RUN_STATUSES]);
	if (page.cursor) {
		const { createdAt, id } = page.cursor;
		q = q.where((eb) =>
			eb.or([
				eb('agent_run.created_at', '<', createdAt),
				eb.and([eb('agent_run.created_at', '=', createdAt), eb('agent_run.id', '<', id)])
			])
		);
	}
	const rows = await q
		.orderBy('agent_run.created_at desc')
		.orderBy('agent_run.id desc')
		.limit(page.limit + 1)
		.execute();
	return { items: rows.slice(0, page.limit).map(serializeRun), hasMore: rows.length > page.limit };
}

export async function getRun(
	db: Kysely<Database>,
	userId: string,
	id: string
): Promise<AgentRunDetail> {
	const row = await runQuery(db, userId).where('agent_run.id', '=', id).executeTakeFirst();
	if (!row) throw notFound();
	return serializeRunDetail(row);
}

export type FullRunLogResult =
	| { kind: 'tail'; text: string }
	| { kind: 'stream'; body: ReadableStream<Uint8Array>; size: number }
	| { kind: 'expired' }
	| { kind: 'not_ready' }
	| { kind: 'missing_raw' };

/**
 * The run's complete log for `GET /api/v1/runs/:id/log`: the tail alone for
 * a run that never overflowed it, the sealed object for an ended run, or a
 * live assembly of spilled parts plus the current tail while it is still
 * going. `raw` asks for the unrendered harness stream instead.
 */
export async function getFullRunLog(
	db: Kysely<Database>,
	env: Env,
	userId: string,
	id: string,
	raw = false
): Promise<FullRunLogResult> {
	const run = await db
		.selectFrom('agent_run')
		.select([
			'id',
			'user_id',
			'log',
			'log_bytes_dropped',
			'log_part_count',
			'log_compacted_through',
			'log_sealed',
			'log_raw_bytes',
			'log_objects_deleted_at'
		])
		.where('id', '=', id)
		.where('user_id', '=', userId)
		.executeTakeFirst();
	if (!run) throw notFound();
	if (raw) {
		if (run.log_objects_deleted_at !== null) return { kind: 'expired' };
		if (run.log_raw_bytes === 0) return { kind: 'missing_raw' };
		const object = await getRunLogStore(env).getStream(runLogRawKey(run.user_id, run.id));
		if (!object) return { kind: 'missing_raw' };
		return { kind: 'stream', body: object.body, size: object.size };
	}
	return readRunLog(env, run);
}

/** Maps the engine's cancel result onto API semantics. */
export function assertCancelable(kind: 'not_found' | 'already_ended' | 'canceled'): void {
	if (kind === 'not_found') throw notFound();
	if (kind === 'already_ended') {
		throw new ApiFail(422, 'run_already_ended', 'This run has already ended; nothing to cancel');
	}
}
