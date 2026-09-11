import {
	ACTIVE_RUN_STATUSES,
	type AgentRun,
	type AgentRunDetail,
	type AgentRunUsage,
	type UsagePendingRun,
	type ModelTier,
	type RunEndOutcome,
	type RunStatus,
	classifyUsage
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
			.leftJoin('runner', (join) =>
				join.onRef('runner.id', '=', 'agent_run.runner_id').on('runner.user_id', '=', userId)
			)
			.leftJoin('issue', 'issue.id', 'agent_run.issue_id')
			.leftJoin('project', (join) =>
				join.onRef('project.id', '=', 'issue.project_id').on('project.user_id', '=', userId)
			)
			// State names survive workflow edits loosely: left joins, ids kept.
			.leftJoin('workflow_state as start_state', 'start_state.id', 'agent_run.state_id_at_start')
			.leftJoin('workflow as start_workflow', 'start_workflow.id', 'start_state.workflow_id')
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
		issue_ref:
			row.project_name !== null && row.issue_number !== null && row.issue_title !== null
				? { project_name: row.project_name, number: row.issue_number, title: row.issue_title }
				: null,
		runner_id: row.runner_id,
		runner_name: row.runner_name ?? `Unknown/deleted runner (${row.runner_id})`,
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
		turn_count: row.turn_count,
		conversation_turn_count: row.conversation_turn_count,
		resumed_from_run_id: row.resumed_from_run_id,
		resume_expires_at: row.resume_expires_at,
		resume_fallback_reason: row.resume_fallback_reason as AgentRun['resume_fallback_reason'],
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
	/** Internal web presentation scope; public handlers opt in explicitly. */
	projectId?: string;
	/** Issue id. */
	issue?: string;
	/** Runner id. */
	runner?: string;
	/** Only runs holding a claim (assigned/launching/running). */
	active?: boolean;
	population?: 'finalized' | 'pending';
	from?: number;
	to?: number;
	workflow?: string;
	state?: string;
	tier?: string;
	outcome?: RunEndOutcome | 'unknown';
	accountingStatus?: 'priced' | 'unpriced' | 'unreported';
}

/**
 * Has this account ever had an agent run? The first-run checklist retires on
 * the first one, so this is asked on every issue page load of an account that
 * has none — one indexed existence check, never a count.
 */
export async function hasAnyRun(db: Kysely<Database>, userId: string): Promise<boolean> {
	const row = await db
		.selectFrom('agent_run')
		.select('agent_run.id')
		.where('agent_run.user_id', '=', userId)
		.limit(1)
		.executeTakeFirst();
	return row !== undefined;
}

interface RunListResult<T> {
	items: T[];
	hasMore: boolean;
	nextBoundary: { createdAt: number; id: string } | null;
}

export function listRuns(
	db: Kysely<Database>,
	userId: string,
	filters: RunListFilters & { population: 'pending' },
	page: Page
): Promise<RunListResult<UsagePendingRun>>;
export function listRuns(
	db: Kysely<Database>,
	userId: string,
	filters: RunListFilters & { population?: 'finalized' | undefined },
	page: Page
): Promise<RunListResult<AgentRun>>;
export function listRuns(
	db: Kysely<Database>,
	userId: string,
	filters: RunListFilters,
	page: Page
): Promise<RunListResult<AgentRun | UsagePendingRun>>;
export async function listRuns(
	db: Kysely<Database>,
	userId: string,
	filters: RunListFilters,
	page: Page
): Promise<RunListResult<AgentRun | UsagePendingRun>> {
	let q = runQuery(db, userId);
	if (filters.projectId === 'unknown') q = q.where('project.id', 'is', null);
	else if (filters.projectId) q = q.where('issue.project_id', '=', filters.projectId);
	if (filters.issue) q = q.where('agent_run.issue_id', '=', filters.issue);
	if (filters.runner === 'unknown') q = q.where('runner.id', 'is', null);
	else if (filters.runner) q = q.where('agent_run.runner_id', '=', filters.runner);
	if (filters.workflow === 'unknown')
		q = q.where('start_workflow.id', 'is', null).where('issue.workflow_id', 'is', null);
	else if (filters.workflow)
		q = q.where((eb) =>
			eb.or([
				eb('start_workflow.id', '=', filters.workflow!),
				eb.and([
					eb('start_workflow.id', 'is', null),
					eb('issue.workflow_id', '=', filters.workflow!)
				])
			])
		);
	if (filters.state === 'unknown') q = q.where('start_state.id', 'is', null);
	else if (filters.state) q = q.where('agent_run.state_id_at_start', '=', filters.state);
	if (filters.tier === 'unknown') q = q.where('agent_run.tier', 'is', null);
	else if (filters.tier) q = q.where('agent_run.tier', '=', filters.tier);
	if (filters.outcome === 'unknown') q = q.where('agent_run.outcome', 'is', null);
	else if (filters.outcome) q = q.where('agent_run.outcome', '=', filters.outcome);
	if (filters.active) q = q.where('agent_run.status', 'in', [...ACTIVE_RUN_STATUSES]);
	if (filters.population === 'finalized') {
		q = q.where('agent_run.ended_at', 'is not', null);
		if (filters.from !== undefined) q = q.where('agent_run.ended_at', '>=', filters.from);
		if (filters.to !== undefined) q = q.where('agent_run.ended_at', '<', filters.to);
	}
	if (filters.population === 'pending') {
		if (filters.to !== undefined) {
			q = q
				.where('agent_run.created_at', '<', filters.to)
				.where((eb) =>
					eb.or([eb('agent_run.ended_at', 'is', null), eb('agent_run.ended_at', '>=', filters.to!)])
				);
		} else q = q.where('agent_run.ended_at', 'is', null);
	}
	if (page.cursor) {
		const { createdAt, id } = page.cursor;
		const cursorColumn =
			filters.population === 'finalized' ? 'agent_run.ended_at' : 'agent_run.created_at';
		q = q.where((eb) =>
			eb.or([
				eb(cursorColumn, '<', createdAt),
				eb.and([eb(cursorColumn, '=', createdAt), eb('agent_run.id', '<', id)])
			])
		);
	}
	const cursorColumn =
		filters.population === 'finalized' ? 'agent_run.ended_at' : 'agent_run.created_at';
	let scan = q;
	let boundary = page.cursor;
	const matched: RunRow[] = [];
	let exhausted = false;
	do {
		let batchQuery = scan;
		if (boundary)
			batchQuery = batchQuery.where((eb) =>
				eb.or([
					eb(cursorColumn, '<', boundary!.createdAt),
					eb.and([
						eb(cursorColumn, '=', boundary!.createdAt),
						eb('agent_run.id', '<', boundary!.id)
					])
				])
			);
		const rows = await batchQuery
			.orderBy(`${cursorColumn} desc`)
			.orderBy('agent_run.id desc')
			.limit(filters.accountingStatus ? 1000 : page.limit + 1)
			.execute();
		for (const row of rows) {
			boundary = {
				createdAt: (filters.population === 'finalized' ? row.ended_at : row.created_at)!,
				id: row.id
			};
			if (!filters.accountingStatus || classifyUsage(row.usage).status === filters.accountingStatus)
				matched.push(row);
			if (matched.length > page.limit) break;
		}
		exhausted = rows.length < (filters.accountingStatus ? 1000 : page.limit + 1);
	} while (filters.accountingStatus && matched.length <= page.limit && !exhausted);
	const hasMore = matched.length > page.limit || !exhausted;
	const selected = matched.slice(0, page.limit);
	const nextBoundary = hasMore
		? matched.length > page.limit
			? {
					createdAt: (filters.population === 'finalized'
						? selected.at(-1)!.ended_at
						: selected.at(-1)!.created_at)!,
					id: selected.at(-1)!.id
				}
			: boundary
		: null;
	const items = selected.map((row) =>
		filters.population === 'pending'
			? ({
					id: row.id,
					issue_id: row.issue_id,
					issue_ref:
						row.project_name !== null && row.issue_number !== null && row.issue_title !== null
							? {
									project_name: row.project_name,
									number: row.issue_number,
									title: row.issue_title
								}
							: null,
					runner_id: row.runner_id,
					runner_name: row.runner_name ?? `Unknown/deleted runner (${row.runner_id})`,
					tier: row.tier as ModelTier,
					state_id_at_start: row.state_id_at_start,
					state_at_start_name: row.start_state_name,
					created_at: row.created_at,
					pending_at: filters.to!,
					usage_dimensions: null,
					accounting_status: 'pending'
				} satisfies UsagePendingRun)
			: serializeRun(row)
	);
	return { items, hasMore, nextBoundary };
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
