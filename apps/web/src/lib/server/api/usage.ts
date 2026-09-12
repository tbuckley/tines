import {
	addUsageClassification,
	classifyUsage,
	createUsageAccumulator,
	finalizeUsage,
	mergeSortedUsageSamples,
	mergeUsageCounters,
	resolveUsagePeriod,
	type ResolvedUsageFilters,
	type UsageBy,
	type UsageDimension,
	type UsageGroup,
	type UsagePeriodInput,
	type UsageReport
} from '@tines/shared';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { Database } from '$lib/server/db';

export interface UsageRequest extends UsagePeriodInput, ResolvedUsageFilters {
	by?: UsageBy;
}

function scanQuery(db: Kysely<Database>, userId: string) {
	return db
		.selectFrom('agent_run')
		.leftJoin('runner', (join) =>
			join.onRef('runner.id', '=', 'agent_run.runner_id').on('runner.user_id', '=', userId)
		)
		.leftJoin('issue', 'issue.id', 'agent_run.issue_id')
		.leftJoin('project', (join) =>
			join.onRef('project.id', '=', 'issue.project_id').on('project.user_id', '=', userId)
		)
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
		.select([
			'agent_run.id',
			'agent_run.usage',
			'agent_run.outcome',
			'agent_run.tier',
			'agent_run.runner_id',
			'agent_run.state_id_at_start',
			'agent_run.created_at',
			'agent_run.ended_at',
			'runner.name as runner_name',
			'issue.project_id as project_id',
			'project.name as project_name',
			'start_state.name as start_state_name',
			'start_workflow.id as start_workflow_id',
			'start_workflow.name as start_workflow_name',
			'issue.workflow_id as issue_workflow_id',
			'issue_workflow.name as issue_workflow_name'
		])
		.where('agent_run.user_id', '=', userId);
}

type UsageRow = Awaited<ReturnType<ReturnType<typeof scanQuery>['execute']>>[number];

async function scanAll(
	query: ReturnType<typeof scanQuery>,
	orderColumn: 'agent_run.ended_at' | 'agent_run.created_at',
	consume: (row: UsageRow) => void
): Promise<void> {
	let boundary: { at: number; id: string } | null = null;
	for (;;) {
		let page = query;
		if (boundary)
			page = page.where((eb) =>
				eb.or([
					eb(orderColumn, '<', boundary!.at),
					eb.and([eb(orderColumn, '=', boundary!.at), eb('agent_run.id', '<', boundary!.id)])
				])
			);
		const rows = await page
			.orderBy(`${orderColumn} desc`)
			.orderBy('agent_run.id desc')
			.limit(5_001)
			.execute();
		const selected = rows.slice(0, 5_000);
		for (const row of selected) consume(row);
		if (rows.length <= 5_000) return;
		const last = selected.at(-1)!;
		boundary = {
			at: (orderColumn === 'agent_run.ended_at' ? last.ended_at : last.created_at)!,
			id: last.id
		};
	}
}

function dimensions(row: UsageRow) {
	const workflowId = row.start_workflow_id ?? row.issue_workflow_id ?? null;
	const workflowName =
		row.start_workflow_name ?? row.issue_workflow_name ?? 'Unknown/deleted workflow';
	return {
		project: {
			id: row.project_id,
			name:
				row.project_name ?? `Unknown/deleted project${row.project_id ? ` (${row.project_id})` : ''}`
		},
		workflow: { id: workflowId, name: workflowName },
		state: {
			id: row.state_id_at_start ?? null,
			name:
				row.start_workflow_id && row.start_state_name
					? row.start_state_name
					: `Unknown/deleted state${row.state_id_at_start ? ` (${row.state_id_at_start})` : ''}`,
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
		tier: { id: row.tier ?? null, name: row.tier ?? 'Unknown' }
	} satisfies Record<UsageBy, UsageDimension>;
}

function filterValue(actual: string | null, requested: string | undefined): boolean {
	return (
		requested === undefined || (requested === 'unknown' ? actual === null : actual === requested)
	);
}

function pendingMatchPredicate(filters: ResolvedUsageFilters): RawBuilder<boolean> {
	const conditions: RawBuilder<boolean>[] = [];
	const identity = (column: RawBuilder<unknown>, requested: string | undefined) => {
		if (requested === undefined) return;
		conditions.push(
			requested === 'unknown'
				? sql<boolean>`${column} IS NULL`
				: sql<boolean>`${column} = ${requested}`
		);
	};
	identity(sql`COALESCE(start_workflow.id, issue.workflow_id)`, filters.workflow);
	identity(sql`agent_run.state_id_at_start`, filters.state);
	identity(sql`agent_run.runner_id`, filters.runner);
	identity(sql`agent_run.tier`, filters.tier);
	return conditions.length ? sql<boolean>`(${sql.join(conditions, sql` AND `)})` : sql<boolean>`1`;
}

function matches(
	row: UsageRow,
	filters: ResolvedUsageFilters,
	accountingStatus?: ReturnType<typeof classifyUsage>['status']
): boolean {
	const d = dimensions(row);
	if (!filterValue(d.project.id, filters.project)) return false;
	if (!filterValue(d.workflow.id, filters.workflow)) return false;
	if (!filterValue(d.state.id, filters.state)) return false;
	if (!filterValue(d.runner.id, filters.runner)) return false;
	if (!filterValue(d.tier.id, filters.tier)) return false;
	if (!filterValue(d.outcome.id, filters.outcome)) return false;
	if (filters.accounting_status && accountingStatus !== filters.accounting_status) return false;
	return true;
}

async function configuredTimezone(db: Kysely<Database>, userId: string): Promise<unknown> {
	const row = await db
		.selectFrom('supervisor_settings')
		.select('budget')
		.where('user_id', '=', userId)
		.executeTakeFirst();
	if (!row?.budget) return undefined;
	try {
		const budget = JSON.parse(row.budget) as { timezone?: unknown };
		return budget.timezone;
	} catch {
		return undefined;
	}
}

export async function getUsage(
	db: Kysely<Database>,
	userId: string,
	request: UsageRequest,
	generatedAt = Date.now()
): Promise<UsageReport> {
	const period = resolveUsagePeriod(request, await configuredTimezone(db, userId), generatedAt);
	const by = request.by ?? 'workflow';
	const filters: ResolvedUsageFilters = {
		...(request.project ? { project: request.project } : {}),
		...(request.workflow ? { workflow: request.workflow } : {}),
		...(request.state ? { state: request.state } : {}),
		...(request.runner ? { runner: request.runner } : {}),
		...(request.tier ? { tier: request.tier } : {}),
		...(request.outcome ? { outcome: request.outcome } : {}),
		...(request.accounting_status ? { accounting_status: request.accounting_status } : {})
	};
	let q = scanQuery(db, userId)
		.where('agent_run.ended_at', '>=', period.from)
		.where('agent_run.ended_at', '<', period.to);
	if (filters.project && filters.project !== 'unknown')
		q = q.where('issue.project_id', '=', filters.project);
	if (filters.project === 'unknown') q = q.where('issue.project_id', 'is', null);
	const scope = createUsageAccumulator();
	const grouped = new Map<
		string,
		{ dimension: UsageDimension; accumulator: ReturnType<typeof createUsageAccumulator> }
	>();
	const workflowOptions = new Map<string | null, UsageDimension>();
	await scanAll(q, 'agent_run.ended_at', (row) => {
		const classification = classifyUsage(row.usage);
		addUsageClassification(scope, classification);
		const rowDimensions = dimensions(row);
		workflowOptions.set(rowDimensions.workflow.id, rowDimensions.workflow);
		if (!matches(row, { ...filters, project: undefined }, classification.status)) return;
		const dimension: UsageDimension = rowDimensions[by];
		const key = JSON.stringify([dimension.workflow_id ?? null, dimension.id]);
		const group = grouped.get(key) ?? { dimension, accumulator: createUsageAccumulator() };
		addUsageClassification(group.accumulator, classification);
		grouped.set(key, group);
	});
	const groups: UsageGroup[] = [...grouped].map(([key, value]) => ({
		key,
		dimension: value.dimension,
		aggregate: finalizeUsage(value.accumulator)
	}));
	groups.sort(
		(a, b) =>
			(b.aggregate.cost_usd ?? -1) - (a.aggregate.cost_usd ?? -1) || a.key.localeCompare(b.key)
	);
	let pendingQ = scanQuery(db, userId)
		.where('agent_run.created_at', '<', period.to)
		.where((eb) =>
			eb.or([eb('agent_run.ended_at', 'is', null), eb('agent_run.ended_at', '>=', period.to)])
		);
	if (filters.project && filters.project !== 'unknown')
		pendingQ = pendingQ.where('issue.project_id', '=', filters.project);
	if (filters.project === 'unknown') pendingQ = pendingQ.where('issue.project_id', 'is', null);
	const pendingFilters = { ...filters, outcome: undefined, accounting_status: undefined };
	const pendingCounts = await pendingQ
		.clearSelect()
		.select(({ fn }) => [
			fn.countAll<number>().as('scope_count'),
			sql<number>`COALESCE(SUM(CASE WHEN ${pendingMatchPredicate(pendingFilters)} THEN 1 ELSE 0 END), 0)`.as(
				'matching_count'
			)
		])
		.executeTakeFirstOrThrow();
	const matching = createUsageAccumulator();
	for (const group of grouped.values()) mergeUsageCounters(matching, group.accumulator);
	return {
		...period,
		accounting_basis: 'finalized_by_ended_at_v1',
		attribution_basis: 'current_issue_project_start_state_workflow_v1',
		filters,
		by,
		scope_total: finalizeUsage(scope),
		matching_total: finalizeUsage(
			matching,
			mergeSortedUsageSamples([...grouped.values()].map((group) => group.accumulator.samples))
		),
		groups,
		workflow_options: [...workflowOptions.values()],
		pending: {
			scope_count: Number(pendingCounts.scope_count),
			matching_count: Number(pendingCounts.matching_count),
			basis: 'created_before_cutoff_not_ended_before_cutoff',
			unapplied_filters: [
				...(filters.outcome ? ['outcome' as const] : []),
				...(filters.accounting_status ? ['accounting_status' as const] : [])
			]
		},
		evidence_filters: {
			...filters,
			from: new Date(period.from).toISOString(),
			to: new Date(period.to).toISOString(),
			population: 'finalized'
		}
	};
}
