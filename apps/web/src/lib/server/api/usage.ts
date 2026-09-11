import {
	aggregateUsage,
	classifyUsage,
	resolveUsagePeriod,
	type ResolvedUsageFilters,
	type UsageBy,
	type UsageDimension,
	type UsageGroup,
	type UsagePeriodInput,
	type UsageReport
} from '@tines/shared';
import type { Kysely } from 'kysely';
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
			'project.id as project_id',
			'project.name as project_name',
			'start_state.name as start_state_name',
			'start_workflow.id as start_workflow_id',
			'start_workflow.name as start_workflow_name',
			'issue_workflow.id as issue_workflow_id',
			'issue_workflow.name as issue_workflow_name'
		])
		.where('agent_run.user_id', '=', userId);
}

type UsageRow = Awaited<ReturnType<ReturnType<typeof scanQuery>['execute']>>[number];

async function scanAll(
	query: ReturnType<typeof scanQuery>,
	orderColumn: 'agent_run.ended_at' | 'agent_run.created_at'
): Promise<UsageRow[]> {
	const result: UsageRow[] = [];
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
			.limit(10_000)
			.execute();
		result.push(...rows);
		if (rows.length < 10_000) return result;
		const last = rows.at(-1)!;
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
		project: { id: row.project_id, name: row.project_name ?? 'Unknown/deleted project' },
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
			id: row.runner_name ? row.runner_id : null,
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

function matches(row: UsageRow, filters: ResolvedUsageFilters, includeAccounting = true): boolean {
	const d = dimensions(row);
	if (!filterValue(d.project.id, filters.project)) return false;
	if (!filterValue(d.workflow.id, filters.workflow)) return false;
	if (!filterValue(d.state.id, filters.state)) return false;
	if (!filterValue(d.runner.id, filters.runner)) return false;
	if (!filterValue(d.tier.id, filters.tier)) return false;
	if (!filterValue(d.outcome.id, filters.outcome)) return false;
	if (
		includeAccounting &&
		filters.accounting_status &&
		classifyUsage(row.usage).status !== filters.accounting_status
	)
		return false;
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
		q = q.where('project.id', '=', filters.project);
	if (filters.project === 'unknown') q = q.where('project.id', 'is', null);
	const scopeRows = await scanAll(q, 'agent_run.ended_at');
	const matchingRows = scopeRows.filter((row) => matches(row, { ...filters, project: undefined }));
	const grouped = new Map<string, { dimension: UsageDimension; usages: unknown[] }>();
	for (const row of matchingRows) {
		const dimension: UsageDimension = dimensions(row)[by];
		const key = JSON.stringify([dimension.workflow_id ?? null, dimension.id]);
		const group = grouped.get(key) ?? { dimension, usages: [] as unknown[] };
		group.usages.push(row.usage);
		grouped.set(key, group);
	}
	const groups: UsageGroup[] = [...grouped].map(([key, value]) => ({
		key,
		dimension: value.dimension,
		aggregate: aggregateUsage(value.usages)
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
		pendingQ = pendingQ.where('project.id', '=', filters.project);
	if (filters.project === 'unknown') pendingQ = pendingQ.where('project.id', 'is', null);
	const pendingFilters = { ...filters, outcome: undefined, accounting_status: undefined };
	const pendingScope = await pendingQ
		.clearSelect()
		.select(({ fn }) => fn.countAll<number>().as('count'))
		.executeTakeFirstOrThrow();
	const hasPendingAnalyticalFilters = Boolean(
		pendingFilters.workflow || pendingFilters.state || pendingFilters.runner || pendingFilters.tier
	);
	const pendingRows = hasPendingAnalyticalFilters
		? await scanAll(pendingQ, 'agent_run.created_at')
		: [];
	const pendingMatchingCount = hasPendingAnalyticalFilters
		? pendingRows.filter((r) => matches(r, { ...pendingFilters, project: undefined }, false)).length
		: Number(pendingScope.count);
	const workflowOptions = new Map<string | null, UsageDimension>();
	for (const row of scopeRows)
		workflowOptions.set(dimensions(row).workflow.id, dimensions(row).workflow);
	return {
		...period,
		accounting_basis: 'finalized_by_ended_at_v1',
		attribution_basis: 'current_issue_project_start_state_workflow_v1',
		filters,
		by,
		scope_total: aggregateUsage(scopeRows.map((r) => r.usage)),
		matching_total: aggregateUsage(matchingRows.map((r) => r.usage)),
		groups,
		workflow_options: [...workflowOptions.values()],
		pending: {
			scope_count: Number(pendingScope.count),
			matching_count: pendingMatchingCount,
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
