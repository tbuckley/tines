import { json } from '@sveltejs/kit';
import {
	resolveUsagePeriod,
	UsageInputError,
	type UsageAccountingStatus,
	type UsageBy
} from '@tines/shared';
import { api, apiContext, ApiFail, notFound } from '$lib/server/api/core';
import { getIssueUsage, getUsage } from '$lib/server/api/usage';
import { getCohortUsage } from '$lib/server/api/usage-cohorts';
import { authorizeUsageFilters } from '$lib/server/api/usage-ledger';
import {
	mintUsageScope,
	usageKeyMaterial,
	verifyUsageScope,
	type UsageScopePayload
} from '$lib/server/usage-scope';
import type { RequestHandler } from './$types';

const recognized = [
	'window',
	'from',
	'to',
	'project',
	'workflow',
	'state',
	'runner',
	'tier',
	'outcome',
	'accounting_status',
	'by',
	'mode',
	'issue',
	'done_state',
	'scope'
];

function groupFilters(report: Awaited<ReturnType<typeof getUsage>>, index: number) {
	const group = report.groups[index];
	const value = group.dimension.id ?? 'unknown';
	return {
		...report.filters,
		...(report.by === 'project' ? { project: value } : {}),
		...(report.by === 'workflow' ? { workflow: value } : {}),
		...(report.by === 'state'
			? { workflow: group.dimension.workflow_id ?? 'unknown', state: value }
			: {}),
		...(report.by === 'outcome' ? { outcome: value as never } : {}),
		...(report.by === 'runner' ? { runner: value } : {}),
		...(report.by === 'tier' ? { tier: value } : {})
	};
}

export const GET: RequestHandler = api(async (event) => {
	const { db, actor, env } = await apiContext(event);
	const params = event.url.searchParams;
	for (const name of params.keys())
		if (!recognized.includes(name))
			throw new ApiFail(422, 'invalid_field', `Unsupported usage parameter "${name}"`, {
				field: name,
				remedy: 'remove unsupported parameters'
			});
	for (const name of recognized)
		if (name !== 'done_state' && params.getAll(name).length > 1)
			throw new ApiFail(422, 'invalid_field', `Duplicate "${name}" parameter`, { field: name });
		else if (params.has(name) && params.get(name) === '')
			throw new ApiFail(422, 'invalid_field', `"${name}" cannot be empty`, { field: name });
	const material = usageKeyMaterial(env);
	if (!material)
		throw new ApiFail(
			500,
			'usage_signing_unavailable',
			'Usage evidence needs SECRET_ENCRYPTION_KEY or BETTER_AUTH_SECRET'
		);
	const replay = params.get('scope');
	let replayPayload: UsageScopePayload | null = null;
	if (replay) {
		const others = recognized.filter((name) => name !== 'scope' && params.has(name));
		if (others.length)
			throw new ApiFail(422, 'invalid_field', 'scope cannot be combined with report options', {
				field: others[0]
			});
		try {
			replayPayload = await verifyUsageScope(replay, material);
		} catch (error) {
			throw new ApiFail(422, 'invalid_scope', (error as Error).message, { field: 'scope' });
		}
		if (replayPayload.owner !== actor.userId) throw notFound();
	}
	const mode = replayPayload?.mode ?? params.get('mode') ?? 'period';
	if (!['period', 'issue', 'cohort'].includes(mode))
		throw new ApiFail(422, 'invalid_field', 'mode must be period, issue, or cohort', {
			field: 'mode'
		});
	if (mode === 'issue') {
		const issueId = replayPayload?.mode === 'issue' ? replayPayload.issue : params.get('issue');
		if (!issueId)
			throw new ApiFail(422, 'invalid_field', 'issue mode requires issue', { field: 'issue' });
		const contradictions = replay
			? []
			: recognized.filter((name) => !['mode', 'issue'].includes(name) && params.has(name));
		if (contradictions.length)
			throw new ApiFail(
				422,
				'invalid_field',
				'issue mode cannot include period or filter options',
				{
					field: contradictions[0],
					remedy: 'remove period and filter options'
				}
			);
		const now = Date.now();
		const cutoff = replayPayload?.mode === 'issue' ? replayPayload.cutoff : now;
		const report = await getIssueUsage(db, actor.userId, issueId, cutoff, now);
		if (!report) throw notFound();
		if (replayPayload?.mode === 'issue') {
			report.timezone = replayPayload.timezone;
			report.timezone_source = replayPayload.timezone_source;
		}
		report.scope =
			replay ??
			(await mintUsageScope(
				{
					v: 1,
					owner: actor.userId,
					mode: 'issue',
					issue: issueId,
					cutoff,
					timezone: report.timezone,
					timezone_source: report.timezone_source
				},
				material
			));
		return json(report, { headers: { 'cache-control': 'private, no-store' } });
	}
	if (mode === 'cohort') {
		const cohortPayload = replayPayload?.mode === 'cohort' ? replayPayload : null;
		const workflow = cohortPayload?.workflow ?? params.get('workflow');
		if (!workflow)
			throw new ApiFail(422, 'invalid_field', 'cohort mode requires workflow', {
				field: 'workflow'
			});
		const contradictions = replay
			? []
			: ['by', 'state', 'runner', 'tier', 'outcome', 'accounting_status', 'issue'].filter((name) =>
					params.has(name)
				);
		if (contradictions.length)
			throw new ApiFail(
				422,
				'invalid_field',
				'cohort mode cannot include period grouping filters',
				{
					field: contradictions[0],
					remedy: 'remove the conflicting option'
				}
			);
		try {
			if (!cohortPayload)
				resolveUsagePeriod(
					{
						window: (params.get('window') ?? undefined) as 'today' | '7d' | '30d' | undefined,
						from: params.get('from') ?? undefined,
						to: params.get('to') ?? undefined
					},
					'UTC'
				);
			const report = await getCohortUsage(
				db,
				actor.userId,
				{
					workflow,
					project: cohortPayload?.project ?? params.get('project') ?? undefined,
					window: cohortPayload
						? undefined
						: ((params.get('window') ?? undefined) as 'today' | '7d' | '30d' | undefined),
					from: cohortPayload ? undefined : (params.get('from') ?? undefined),
					to: cohortPayload ? undefined : (params.get('to') ?? undefined),
					done_states:
						cohortPayload || !params.has('done_state') ? undefined : params.getAll('done_state')
				},
				Date.now(),
				cohortPayload
					? {
							from: cohortPayload.from,
							to: cohortPayload.to,
							timezone: cohortPayload.timezone,
							timezone_source: cohortPayload.timezone_source,
							observed_through: cohortPayload.observed_through,
							selected_states: cohortPayload.selected_states,
							selection_basis: cohortPayload.selection_basis
						}
					: undefined
			);
			if (!report) throw notFound();
			report.scope =
				replay ??
				(await mintUsageScope(
					{
						v: 1,
						owner: actor.userId,
						mode: 'cohort',
						from: report.from,
						to: report.to,
						timezone: report.timezone,
						timezone_source: report.timezone_source,
						project: cohortPayload?.project ?? params.get('project'),
						workflow,
						selected_states: report.selected_states,
						selection_basis: report.selection_basis,
						definitions_resolved_at: report.generated_at,
						observed_through: report.observed_through
					},
					material
				));
			return json(report, { headers: { 'cache-control': 'private, no-store' } });
		} catch (error) {
			if (error instanceof UsageInputError)
				throw new ApiFail(422, 'invalid_usage_period', error.message, {
					field: error.field ?? 'from/to'
				});
			throw error;
		}
	}
	if (params.has('issue'))
		throw new ApiFail(422, 'invalid_field', 'issue requires mode=issue', { field: 'issue' });
	const by = (
		replayPayload?.mode === 'period' ? replayPayload.by : (params.get('by') ?? 'workflow')
	) as UsageBy;
	if (!['project', 'workflow', 'state', 'outcome', 'runner', 'tier'].includes(by))
		throw new ApiFail(422, 'invalid_field', 'Invalid usage grouping', { field: 'by' });
	const periodPayload = replayPayload?.mode === 'period' ? replayPayload : null;
	const selected = periodPayload?.filters;
	const outcome = selected?.outcome ?? params.get('outcome') ?? undefined;
	if (outcome && !['advanced', 'stalled', 'interrupted', 'unknown'].includes(outcome))
		throw new ApiFail(422, 'invalid_field', 'Invalid outcome', { field: 'outcome' });
	const accounting = selected?.accounting_status ?? params.get('accounting_status') ?? undefined;
	if (accounting && !['priced', 'unpriced', 'unreported'].includes(accounting))
		throw new ApiFail(422, 'invalid_field', 'Invalid accounting status', {
			field: 'accounting_status'
		});
	const tier = selected?.tier ?? params.get('tier') ?? undefined;
	if (tier && !['smartest', 'balanced', 'cheapest', 'unknown'].includes(tier))
		throw new ApiFail(422, 'invalid_field', 'Invalid tier', { field: 'tier' });
	if (!periodPayload && params.has('state') && !params.has('workflow'))
		throw new ApiFail(422, 'invalid_field', 'state requires workflow qualification', {
			field: 'state'
		});
	const state = selected?.state ?? params.get('state');
	const workflow = selected?.workflow ?? params.get('workflow');
	try {
		// Period syntax and contradictions must win over retained-identity lookups.
		// The service resolves the same valid input again using the configured timezone.
		if (!periodPayload)
			resolveUsagePeriod(
				{
					window: (params.get('window') ?? undefined) as 'today' | '7d' | '30d' | undefined,
					from: params.get('from') ?? undefined,
					to: params.get('to') ?? undefined
				},
				'UTC'
			);
	} catch (error) {
		if (error instanceof UsageInputError)
			throw new ApiFail(422, 'invalid_usage_period', error.message, {
				field: error.field ?? 'from/to',
				accepted: 'Today, 7d, 30d, YYYY-MM-DD, or ISO timestamp with explicit offset',
				remedy: error.remedy ?? 'use a named window or supply valid from/to bounds and retry'
			});
		throw error;
	}
	if (
		!(await authorizeUsageFilters(db, actor.userId, {
			project: selected?.project ?? params.get('project'),
			runner: selected?.runner ?? params.get('runner'),
			workflow,
			state
		}))
	)
		throw notFound();
	try {
		const report = await getUsage(db, actor.userId, {
			window: periodPayload
				? undefined
				: ((params.get('window') ?? undefined) as 'today' | '7d' | '30d' | undefined),
			from: periodPayload
				? new Date(periodPayload.from).toISOString()
				: (params.get('from') ?? undefined),
			to: periodPayload
				? new Date(periodPayload.to).toISOString()
				: (params.get('to') ?? undefined),
			project: selected?.project ?? params.get('project') ?? undefined,
			workflow: selected?.workflow ?? params.get('workflow') ?? undefined,
			state: selected?.state ?? params.get('state') ?? undefined,
			runner: selected?.runner ?? params.get('runner') ?? undefined,
			tier: selected?.tier ?? params.get('tier') ?? undefined,
			outcome: outcome as never,
			accounting_status: accounting as UsageAccountingStatus | undefined,
			by
		});
		// A replay freezes the operator-visible period basis as well as its
		// instants. Current supervisor settings must not relabel an old scope.
		if (periodPayload) {
			report.timezone = periodPayload.timezone;
			report.timezone_source = periodPayload.timezone_source;
		}
		const base: UsageScopePayload = {
			v: 1,
			owner: actor.userId,
			mode: 'period',
			from: report.from,
			to: report.to,
			timezone: report.timezone,
			timezone_source: report.timezone_source,
			filters: report.filters,
			by: report.by
		};
		report.scope = replay ?? (await mintUsageScope(base, material));
		report.matching_scope = report.scope;
		report.scope_total_scope = await mintUsageScope(
			{ ...base, filters: report.filters.project ? { project: report.filters.project } : {} },
			material
		);
		report.pending_scope = await mintUsageScope(
			{ ...base, filters: { ...report.filters, outcome: undefined, accounting_status: undefined } },
			material
		);
		for (let i = 0; i < report.groups.length; i++)
			report.groups[i].scope = await mintUsageScope(
				{ ...base, filters: groupFilters(report, i) },
				material
			);
		return json(report, { headers: { 'cache-control': 'private, no-store' } });
	} catch (error) {
		if (error instanceof UsageInputError)
			throw new ApiFail(422, 'invalid_usage_period', error.message, {
				field: error.field ?? 'from/to',
				accepted: 'Today, 7d, 30d, YYYY-MM-DD, or ISO timestamp with explicit offset',
				remedy: error.remedy ?? 'use a named window or supply valid from/to bounds and retry'
			});
		throw error;
	}
});
