import {
	ACTIVE_RUN_STATUSES,
	type AgentRun,
	type AgentRunDetail,
	type AgentRunUsage,
	type UsagePendingRun,
	type ModelTier,
	type RunEndOutcome,
	type RunStatus,
	classifyUsage,
	type UsageDimensions
} from '@tines/shared';
import { sql, type Kysely } from 'kysely';
import type { Database } from '$lib/server/db';
import { getRunLogStore, runLogRawKey } from '$lib/server/run-log-store';
import { readRunLog } from '$lib/server/supervisor/run-log';
import { cancelRun } from '$lib/server/supervisor/engine';
import type { DispatchEffects } from '$lib/server/dispatch-effects';
import { retainedStartWorkflow, retainedIssueWorkflow, retainedWorkflow } from './usage-ledger';
import { ApiFail, notFound, type ActorContext, type Page } from './core';

function evidenceBaseQuery(db: Kysely<Database>, userId: string) {
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
			.leftJoin('workflow as start_workflow', (join) =>
				join
					.onRef('start_workflow.id', '=', 'start_state.workflow_id')
					.on((eb) =>
						eb.or([
							eb('start_workflow.user_id', '=', userId),
							eb('start_workflow.user_id', 'is', null)
						])
					)
			)
			.leftJoin('workflow as issue_workflow', (join) =>
				join
					.onRef('issue_workflow.id', '=', 'issue.workflow_id')
					.on((eb) =>
						eb.or([
							eb('issue_workflow.user_id', '=', userId),
							eb('issue_workflow.user_id', 'is', null)
						])
					)
			)
			.where('agent_run.user_id', '=', userId)
	);
}

export function runQuery(db: Kysely<Database>, userId: string) {
	return evidenceBaseQuery(db, userId)
		.leftJoin('workflow_state as end_state', 'end_state.id', 'agent_run.state_id_at_end')
		.selectAll('agent_run')
		.select([
			'runner.name as runner_name',
			'issue.number as issue_number',
			'issue.title as issue_title',
			'project.name as project_name',
			'issue.project_id as project_id',
			sql<
				string | null
			>`case when ${sql.ref('start_workflow.id')} is not null then ${sql.ref('start_state.name')} else null end`.as(
				'start_state_name'
			),
			'start_workflow.id as start_workflow_id',
			'issue.workflow_id as issue_workflow_id',
			'start_workflow.name as start_workflow_name',
			'issue_workflow.name as issue_workflow_name',
			'end_state.name as end_state_name'
		]);
}

type RunRow = Awaited<ReturnType<ReturnType<typeof runQuery>['execute']>>[number];

const evidenceRunSelection = [
	'agent_run.id',
	'agent_run.issue_id',
	'agent_run.runner_id',
	'agent_run.status',
	'agent_run.outcome',
	'agent_run.tier',
	'agent_run.model',
	'agent_run.usage',
	'agent_run.state_id_at_start',
	'agent_run.state_id_at_end',
	'agent_run.provider_session_id',
	'agent_run.provider_url',
	'agent_run.turn_count',
	'agent_run.conversation_turn_count',
	'agent_run.resumed_from_run_id',
	'agent_run.resume_expires_at',
	'agent_run.resume_fallback_reason',
	'agent_run.error',
	'agent_run.created_at',
	'agent_run.started_at',
	'agent_run.ended_at',
	'runner.name as runner_name',
	'issue.number as issue_number',
	'issue.title as issue_title',
	'project.name as project_name',
	'issue.project_id as project_id',
	sql<
		string | null
	>`case when ${sql.ref('start_workflow.id')} is not null then ${sql.ref('start_state.name')} else null end`.as(
		'start_state_name'
	),
	retainedStartWorkflow.as('start_workflow_id'),
	retainedIssueWorkflow.as('issue_workflow_id'),
	'start_workflow.name as start_workflow_name',
	'issue_workflow.name as issue_workflow_name',
	'end_state.name as end_state_name'
] as const;

// Pending-at-cutoff evidence must not even read facts learned after the cutoff.
// Keep this projection separate from finalized evidence so future serializers cannot
// accidentally expose usage, outcome, end state/time, provider data, or errors.
const pendingEvidenceSelection = [
	'agent_run.id',
	'agent_run.issue_id',
	'agent_run.runner_id',
	'agent_run.tier',
	'agent_run.state_id_at_start',
	'agent_run.created_at',
	'runner.name as runner_name',
	'issue.number as issue_number',
	'issue.title as issue_title',
	'project.name as project_name',
	'issue.project_id as project_id',
	sql<
		string | null
	>`case when ${sql.ref('start_workflow.id')} is not null then ${sql.ref('start_state.name')} else null end`.as(
		'start_state_name'
	),
	retainedStartWorkflow.as('start_workflow_id'),
	retainedIssueWorkflow.as('issue_workflow_id'),
	'start_workflow.name as start_workflow_name',
	'issue_workflow.name as issue_workflow_name'
] as const;

function usageDimensions(row: RunRow): UsageDimensions {
	const workflowId = row.start_workflow_id ?? row.issue_workflow_id ?? null;
	const workflowName =
		(row.start_workflow_id ? row.start_workflow_name : row.issue_workflow_name) ??
		`Unknown/deleted workflow${workflowId ? ` (${workflowId})` : ''}`;
	return {
		project: {
			id: row.project_id,
			name:
				row.project_name ?? `Unknown/deleted project${row.project_id ? ` (${row.project_id})` : ''}`
		},
		workflow: {
			id: workflowId,
			name: workflowName ?? `Unknown/deleted workflow${workflowId ? ` (${workflowId})` : ''}`
		},
		state: {
			id: row.state_id_at_start,
			name: row.start_state_name ?? `Unknown/deleted state (${row.state_id_at_start})`,
			workflow_id: workflowId,
			workflow_name: workflowName
		},
		outcome: {
			id: row.outcome,
			name: row.outcome ? row.outcome[0].toUpperCase() + row.outcome.slice(1) : 'Unknown'
		},
		runner: {
			id: row.runner_id,
			name: row.runner_name ?? `Unknown/deleted runner (${row.runner_id})`
		},
		tier: { id: row.tier, name: row.tier ?? 'Unknown' }
	};
}

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
	scanComplete: boolean;
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
	if (filters.projectId === 'unknown')
		q = q.where(filters.population ? 'issue.project_id' : 'project.id', 'is', null);
	else if (filters.projectId) q = q.where('issue.project_id', '=', filters.projectId);
	if (filters.issue) q = q.where('agent_run.issue_id', '=', filters.issue);
	if (filters.runner === 'unknown')
		q = q.where(filters.population ? 'agent_run.runner_id' : 'runner.id', 'is', null);
	else if (filters.runner) q = q.where('agent_run.runner_id', '=', filters.runner);
	if (filters.population && filters.workflow) {
		q =
			filters.workflow === 'unknown'
				? q.where(retainedWorkflow, 'is', null)
				: q.where(retainedWorkflow, '=', filters.workflow);
	} else {
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
	}
	if (filters.state === 'unknown')
		q = q.where(filters.population ? 'agent_run.state_id_at_start' : 'start_state.id', 'is', null);
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
	let boundary = page.cursor;
	const matched: {
		id: string;
		usage: string | null;
		ended_at: number | null;
		created_at: number;
	}[] = [];
	let exhausted = false;
	let scanQueries = 0;
	do {
		scanQueries++;
		let batchQuery = q
			.clearSelect()
			.select(['agent_run.id', 'agent_run.usage', 'agent_run.ended_at', 'agent_run.created_at']);
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
			.limit(filters.accountingStatus ? 10_001 : page.limit + 1)
			.execute();
		const examined = filters.accountingStatus ? rows.slice(0, 10_000) : rows;
		for (const row of examined) {
			boundary = {
				createdAt: (filters.population === 'finalized' ? row.ended_at : row.created_at)!,
				id: row.id
			};
			if (!filters.accountingStatus || classifyUsage(row.usage).status === filters.accountingStatus)
				matched.push(row);
			if (matched.length > page.limit) break;
		}
		exhausted = rows.length <= (filters.accountingStatus ? 10_000 : page.limit);
	} while (
		filters.accountingStatus &&
		matched.length <= page.limit &&
		!exhausted &&
		scanQueries < 20
	);
	const scanComplete = exhausted || matched.length > page.limit || !filters.accountingStatus;
	const hasMore = matched.length > page.limit || !exhausted;
	const selectedCandidates = matched.slice(0, page.limit);
	const nextBoundary = hasMore
		? matched.length > page.limit
			? {
					createdAt: (filters.population === 'finalized'
						? selectedCandidates.at(-1)!.ended_at
						: selectedCandidates.at(-1)!.created_at)!,
					id: selectedCandidates.at(-1)!.id
				}
			: boundary
		: null;
	const hydrated: RunRow[] = [];
	for (let offset = 0; offset < selectedCandidates.length; offset += 80) {
		const ids = selectedCandidates.slice(offset, offset + 80).map((row) => row.id);
		if (ids.length) {
			const rows =
				filters.population === 'pending'
					? await evidenceBaseQuery(db, userId)
							.select(pendingEvidenceSelection)
							.where('agent_run.id', 'in', ids)
							.execute()
					: await runQuery(db, userId)
							.clearSelect()
							.select(evidenceRunSelection)
							.where('agent_run.id', 'in', ids)
							.execute();
			hydrated.push(...(rows as unknown as RunRow[]));
		}
	}
	const byId = new Map(hydrated.map((row) => [row.id, row]));
	const selected = selectedCandidates
		.map((candidate) => byId.get(candidate.id))
		.filter((row): row is RunRow => Boolean(row));
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
					usage_dimensions: (({ outcome: _, ...safe }) => safe)(usageDimensions(row)),
					accounting_status: 'pending'
				} satisfies UsagePendingRun)
			: filters.population === 'finalized'
				? {
						...serializeRun(row),
						usage_dimensions: usageDimensions(row),
						usage_accounting: (({ usage: _, ...accounting }) => accounting)(
							classifyUsage(row.usage)
						)
					}
				: serializeRun(row)
	);
	return { items, hasMore, nextBoundary, scanComplete };
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

export async function cancelRunForRequest(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	effects: DispatchEffects,
	runId: string
): Promise<AgentRunDetail> {
	const result = await cancelRun(db, env, actor.userId, runId);
	assertCancelable(result.kind);
	effects.signalDispatch();
	return getRun(db, actor.userId, runId);
}
