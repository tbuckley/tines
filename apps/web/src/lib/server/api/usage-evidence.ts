import {
	addUsageClassification,
	classifyUsage,
	compareUsageDecimals,
	createUsageAccumulator,
	finalizeUsage,
	type IssueAttemptUsage,
	type ResolvedUsageFilters,
	type UsageAggregate,
	type UsageEvidencePage,
	type UsagePendingRun
} from '@tines/shared';
import { sql, type Kysely } from 'kysely';
import type { Database } from '$lib/server/db';
import {
	mintUsageCursor,
	verifyUsageCursor,
	type UsageCursorPayload,
	type UsageScopePayload
} from '$lib/server/usage-scope';
import { retainedIssueWorkflow, retainedStartWorkflow } from './usage-ledger';
import { hydrateUsageEvidenceRuns } from './runs';

export interface EvidenceRequest {
	kind: 'issues' | 'runs' | 'entries';
	population: 'all' | 'finalized' | 'pending';
	member: string | null;
	sort: 'cost' | 'time';
	direction: 'asc' | 'desc';
	limit: number;
	cursor: string | null;
}

type Candidate = {
	id: string;
	cost: string | null;
	at: number;
	item?: IssueAttemptUsage;
};

function compare(a: Candidate, b: Candidate, sort: 'cost' | 'time', direction: 'asc' | 'desc') {
	if (sort === 'cost') {
		if (a.cost === null || b.cost === null) {
			if (a.cost !== b.cost) return a.cost === null ? 1 : -1;
		} else {
			const cost = compareUsageDecimals(a.cost, b.cost);
			if (cost) return direction === 'asc' ? cost : -cost;
		}
	}
	const time = a.at - b.at;
	if (time) return sort === 'time' && direction === 'asc' ? time : -time;
	return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
}

function filterValue(actual: string | null, requested: string | undefined) {
	return (
		requested === undefined || (requested === 'unknown' ? actual === null : actual === requested)
	);
}

function rows(db: Kysely<Database>, owner: string) {
	return db
		.selectFrom('agent_run')
		.leftJoin('runner', (join) =>
			join.onRef('runner.id', '=', 'agent_run.runner_id').on('runner.user_id', '=', owner)
		)
		.leftJoin('issue', 'issue.id', 'agent_run.issue_id')
		.leftJoin('project', (join) =>
			join.onRef('project.id', '=', 'issue.project_id').on('project.user_id', '=', owner)
		)
		.leftJoin('workflow_state as start_state', 'start_state.id', 'agent_run.state_id_at_start')
		.leftJoin('workflow as start_workflow', (join) =>
			join
				.onRef('start_workflow.id', '=', 'start_state.workflow_id')
				.on((eb) =>
					eb.or([
						eb('start_workflow.user_id', '=', owner),
						eb('start_workflow.user_id', 'is', null)
					])
				)
		)
		.leftJoin('workflow as issue_workflow', (join) =>
			join
				.onRef('issue_workflow.id', '=', 'issue.workflow_id')
				.on((eb) =>
					eb.or([
						eb('issue_workflow.user_id', '=', owner),
						eb('issue_workflow.user_id', 'is', null)
					])
				)
		)
		.select([
			'agent_run.id',
			'agent_run.issue_id',
			'agent_run.runner_id',
			'agent_run.tier',
			'agent_run.outcome',
			'agent_run.state_id_at_start',
			'agent_run.created_at',
			'agent_run.ended_at',
			'agent_run.usage',
			'runner.name as runner_name',
			'issue.number as issue_number',
			'issue.title as issue_title',
			'issue.project_id as project_id',
			'project.name as project_name',
			retainedStartWorkflow.as('start_workflow_id'),
			retainedIssueWorkflow.as('issue_workflow_id')
		])
		.where('agent_run.user_id', '=', owner);
}
type Row = Awaited<ReturnType<ReturnType<typeof rows>['execute']>>[number];

/**
 * Historical pending evidence must never read facts recorded after its cutoff.
 * Keep this projection separate from the finalized projection so adding a wide
 * field to rows() cannot silently widen the pending Worker scan.
 */
export function pendingUsageEvidenceRows(db: Kysely<Database>, owner: string) {
	return rows(db, owner)
		.clearSelect()
		.select([
			'agent_run.id',
			'agent_run.issue_id',
			'agent_run.runner_id',
			'agent_run.tier',
			'agent_run.state_id_at_start',
			'agent_run.created_at',
			'issue.project_id as project_id',
			retainedStartWorkflow.as('start_workflow_id'),
			retainedIssueWorkflow.as('issue_workflow_id'),
			sql<null>`NULL`.as('outcome'),
			sql<null>`NULL`.as('ended_at'),
			sql<null>`NULL`.as('usage'),
			sql<null>`NULL`.as('runner_name'),
			sql<null>`NULL`.as('issue_number'),
			sql<null>`NULL`.as('issue_title'),
			sql<null>`NULL`.as('project_name')
		]);
}

function matches(row: Row, filters: ResolvedUsageFilters, population: 'finalized' | 'pending') {
	const workflow = row.start_workflow_id ?? row.issue_workflow_id ?? null;
	if (!filterValue(row.project_id, filters.project)) return false;
	if (!filterValue(workflow, filters.workflow)) return false;
	if (!filterValue(row.state_id_at_start, filters.state)) return false;
	if (!filterValue(row.runner_id, filters.runner)) return false;
	if (!filterValue(row.tier, filters.tier)) return false;
	if (population === 'finalized') {
		if (!filterValue(row.outcome, filters.outcome)) return false;
		if (filters.accounting_status && classifyUsage(row.usage).status !== filters.accounting_status)
			return false;
	}
	return true;
}

function retain(
	winners: Candidate[],
	candidate: Candidate,
	request: EvidenceRequest,
	boundary: Candidate | null
) {
	if (boundary) {
		const side = compare(candidate, boundary, request.sort, request.direction);
		if (
			request.cursor &&
			((request as EvidenceRequest & { traversal?: string }).traversal === 'before'
				? side >= 0
				: side <= 0)
		)
			return;
	}
	winners.push(candidate);
	winners.sort((a, b) => compare(a, b, request.sort, request.direction));
	if (winners.length > request.limit + 1) {
		if ((request as EvidenceRequest & { traversal?: string }).traversal === 'before')
			winners.shift();
		else winners.pop();
	}
}

function scopeCutoff(scope: UsageScopePayload) {
	return scope.mode === 'issue' ? scope.cutoff : scope.to;
}
function scopeFilters(scope: UsageScopePayload): ResolvedUsageFilters {
	return scope.mode === 'period' ? scope.filters : {};
}

export async function getUsageEvidence(
	db: Kysely<Database>,
	owner: string,
	scopeToken: string,
	scope: UsageScopePayload,
	request: EvidenceRequest,
	material: string
): Promise<UsageEvidencePage> {
	if (request.kind === 'issues' && scope.mode !== 'period')
		throw new Error('issue mode already selects one issue');
	if (request.kind === 'issues' && request.population === 'pending')
		throw new Error('pending evidence is available as runs');
	if (request.population === 'pending' && request.sort === 'cost')
		throw new Error('pending evidence can only be sorted by time');
	if (request.kind === 'entries' || request.population === 'all')
		throw new Error('entry and all-member evidence require a completed-issue scope');
	let decoded: UsageCursorPayload | null = null;
	if (request.cursor) {
		decoded = await verifyUsageCursor(request.cursor, material);
		if (
			decoded.scope !== scopeToken ||
			decoded.kind !== request.kind ||
			decoded.population !== request.population ||
			decoded.member !== request.member ||
			decoded.sort !== request.sort ||
			decoded.direction !== request.direction
		)
			throw new Error('Cursor does not match evidence selection');
	}
	const traversal = decoded?.traversal ?? 'after';
	(request as EvidenceRequest & { traversal?: string }).traversal = traversal;
	const boundary: Candidate | null = decoded
		? { id: decoded.boundary.id, cost: decoded.boundary.cost, at: decoded.boundary.at }
		: null;
	const cutoff = scopeCutoff(scope);
	const filters = scopeFilters(scope);
	const global = createUsageAccumulator();
	let attemptCount = 0;
	let pendingCount = 0;
	let totalCount = 0;
	const winners: Candidate[] = [];

	if (request.kind === 'issues') {
		let seek: { issue: string; at: number; id: string } | null = null;
		let current: {
			key: string;
			ref: IssueAttemptUsage['issue_ref'];
			at: number;
			acc: ReturnType<typeof createUsageAccumulator>;
			count: number;
		} | null = null;
		const finish = () => {
			if (!current) return;
			const aggregate = finalizeUsage(current.acc);
			const item: IssueAttemptUsage = {
				issue_id: current.key || null,
				issue_ref: current.ref,
				aggregate,
				attempt_count: current.count,
				pending_count: 0,
				fully_priced:
					aggregate.finalized_run_count > 0 &&
					aggregate.finalized_run_count === aggregate.priced_run_count,
				latest_at: current.at
			};
			totalCount++;
			retain(
				winners,
				{ id: current.key || 'unknown', cost: aggregate.cost_usd_exact, at: current.at, item },
				request,
				boundary
			);
		};
		for (;;) {
			let q = rows(db, owner)
				.where('agent_run.ended_at', '>=', scope.mode === 'period' ? scope.from : 0)
				.where('agent_run.ended_at', '<', cutoff);
			if (seek)
				q = q.where(
					sql<boolean>`(COALESCE(agent_run.issue_id, ''), agent_run.ended_at, agent_run.id) > (${seek.issue}, ${seek.at}, ${seek.id})`
				);
			const batch = await q
				.orderBy(sql`COALESCE(agent_run.issue_id, '')`)
				.orderBy('agent_run.ended_at')
				.orderBy('agent_run.id')
				.limit(5_001)
				.execute();
			const selected = batch.slice(0, 5_000);
			for (const row of selected) {
				if (!matches(row, filters, 'finalized')) continue;
				const key = row.issue_id ?? '';
				if (current && current.key !== key) finish();
				if (!current || current.key !== key)
					current = {
						key,
						ref:
							row.project_name !== null && row.issue_number !== null && row.issue_title !== null
								? {
										project_name: row.project_name,
										number: row.issue_number,
										title: row.issue_title
									}
								: null,
						at: row.ended_at!,
						acc: createUsageAccumulator(),
						count: 0
					};
				current.at = Math.max(current.at, row.ended_at!);
				current.count++;
				attemptCount++;
				const classification = classifyUsage(row.usage);
				addUsageClassification(current.acc, classification);
				addUsageClassification(global, classification);
			}
			if (batch.length <= 5_000) break;
			const last = selected.at(-1)!;
			seek = { issue: last.issue_id ?? '', at: last.ended_at!, id: last.id };
		}
		finish();
	} else {
		let seek: { at: number; id: string } | null = null;
		for (;;) {
			const time =
				request.population === 'finalized' ? 'agent_run.ended_at' : 'agent_run.created_at';
			let q =
				request.population === 'pending' ? pendingUsageEvidenceRows(db, owner) : rows(db, owner);
			q = q.where('agent_run.created_at', '<', cutoff);
			q =
				request.population === 'finalized'
					? q.where('agent_run.ended_at', '<', cutoff).where('agent_run.ended_at', 'is not', null)
					: q.where((eb) =>
							eb.or([eb('agent_run.ended_at', 'is', null), eb('agent_run.ended_at', '>=', cutoff)])
						);
			if (scope.mode === 'period' && request.population === 'finalized')
				q = q.where('agent_run.ended_at', '>=', scope.from);
			if (scope.mode === 'issue') q = q.where('agent_run.issue_id', '=', scope.issue);
			if (request.member)
				q =
					request.member === 'unknown'
						? q.where('agent_run.issue_id', 'is', null)
						: q.where('agent_run.issue_id', '=', request.member);
			if (seek)
				q = q.where(sql<boolean>`(${sql.ref(time)}, agent_run.id) < (${seek.at}, ${seek.id})`);
			const batch = await q
				.orderBy(`${time} desc`)
				.orderBy('agent_run.id desc')
				.limit(5_001)
				.execute();
			const selected = batch.slice(0, 5_000);
			for (const row of selected) {
				if (!matches(row, filters, request.population)) continue;
				attemptCount++;
				if (request.population === 'pending') pendingCount++;
				else addUsageClassification(global, classifyUsage(row.usage));
				const classification = request.population === 'finalized' ? classifyUsage(row.usage) : null;
				retain(
					winners,
					{
						id: row.id,
						cost: classification?.cost_exact ?? null,
						at: request.population === 'finalized' ? row.ended_at! : row.created_at
					},
					request,
					boundary
				);
			}
			if (batch.length <= 5_000) break;
			const last = selected.at(-1)!;
			seek = {
				at: request.population === 'finalized' ? last.ended_at! : last.created_at,
				id: last.id
			};
		}
		totalCount = attemptCount;
	}

	const hasExtra = winners.length > request.limit;
	const selected =
		traversal === 'before' ? winners.slice(-request.limit) : winners.slice(0, request.limit);
	const items =
		request.kind === 'issues'
			? selected.map((candidate) => candidate.item!)
			: await hydrateUsageEvidenceRuns(
					db,
					owner,
					selected.map((candidate) => candidate.id),
					request.population,
					cutoff
				);
	if (items.length !== selected.length)
		throw new Error('Retained records changed while evidence was being assembled');
	const cursor = async (candidate: Candidate, nextTraversal: 'after' | 'before') =>
		mintUsageCursor(
			{
				v: 1,
				scope: scopeToken,
				kind: request.kind,
				population: request.population,
				member: request.member,
				sort: request.sort,
				direction: request.direction,
				traversal: nextTraversal,
				boundary: { cost: candidate.cost, at: candidate.at, id: candidate.id }
			},
			material
		);
	return {
		items: items as UsageEvidencePage['items'],
		next_cursor:
			selected.length && (hasExtra || traversal === 'before')
				? await cursor(selected.at(-1)!, 'after')
				: null,
		previous_cursor:
			selected.length &&
			((traversal === 'after' && decoded) || (traversal === 'before' && hasExtra))
				? await cursor(selected[0], 'before')
				: null,
		total_count: totalCount,
		scope: scopeToken,
		kind: request.kind,
		population: request.population,
		sort: request.sort,
		direction: request.direction,
		matching_total: finalizeUsage(global),
		attempt_count: attemptCount,
		pending_count: pendingCount
	};
}
