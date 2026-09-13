import { json } from '@sveltejs/kit';
import {
	resolveUsagePeriod,
	UsageInputError,
	type UsageAccountingStatus,
	type UsageBy
} from '@tines/shared';
import { api, apiContext, ApiFail, notFound } from '$lib/server/api/core';
import { getIssueUsage, getUsage } from '$lib/server/api/usage';
import { authorizeUsageFilters } from '$lib/server/api/usage-ledger';
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
	'issue'
];

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const params = event.url.searchParams;
	for (const name of params.keys())
		if (!recognized.includes(name))
			throw new ApiFail(422, 'invalid_field', `Unsupported usage parameter "${name}"`, {
				field: name,
				remedy: 'remove unsupported parameters'
			});
	for (const name of recognized)
		if (params.getAll(name).length > 1)
			throw new ApiFail(422, 'invalid_field', `Duplicate "${name}" parameter`, { field: name });
		else if (params.has(name) && params.get(name) === '')
			throw new ApiFail(422, 'invalid_field', `"${name}" cannot be empty`, { field: name });
	const mode = params.get('mode') ?? 'period';
	if (!['period', 'issue'].includes(mode))
		throw new ApiFail(422, 'invalid_field', 'mode must be period or issue', { field: 'mode' });
	if (mode === 'issue') {
		const issueId = params.get('issue');
		if (!issueId)
			throw new ApiFail(422, 'invalid_field', 'issue mode requires issue', { field: 'issue' });
		const contradictions = recognized.filter(
			(name) => !['mode', 'issue'].includes(name) && params.has(name)
		);
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
		const report = await getIssueUsage(db, actor.userId, issueId);
		if (!report) throw notFound();
		return json(report, { headers: { 'cache-control': 'private, no-store' } });
	}
	if (params.has('issue'))
		throw new ApiFail(422, 'invalid_field', 'issue requires mode=issue', { field: 'issue' });
	const by = (params.get('by') ?? 'workflow') as UsageBy;
	if (!['project', 'workflow', 'state', 'outcome', 'runner', 'tier'].includes(by))
		throw new ApiFail(422, 'invalid_field', 'Invalid usage grouping', { field: 'by' });
	const outcome = params.get('outcome') ?? undefined;
	if (outcome && !['advanced', 'stalled', 'interrupted', 'unknown'].includes(outcome))
		throw new ApiFail(422, 'invalid_field', 'Invalid outcome', { field: 'outcome' });
	const accounting = params.get('accounting_status') ?? undefined;
	if (accounting && !['priced', 'unpriced', 'unreported'].includes(accounting))
		throw new ApiFail(422, 'invalid_field', 'Invalid accounting status', {
			field: 'accounting_status'
		});
	const tier = params.get('tier') ?? undefined;
	if (tier && !['smartest', 'balanced', 'cheapest', 'unknown'].includes(tier))
		throw new ApiFail(422, 'invalid_field', 'Invalid tier', { field: 'tier' });
	if (params.has('state') && !params.has('workflow'))
		throw new ApiFail(422, 'invalid_field', 'state requires workflow qualification', {
			field: 'state'
		});
	const state = params.get('state');
	const workflow = params.get('workflow');
	try {
		// Period syntax and contradictions must win over retained-identity lookups.
		// The service resolves the same valid input again using the configured timezone.
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
			project: params.get('project'),
			runner: params.get('runner'),
			workflow,
			state
		}))
	)
		throw notFound();
	try {
		const report = await getUsage(db, actor.userId, {
			window: (params.get('window') ?? undefined) as 'today' | '7d' | '30d' | undefined,
			from: params.get('from') ?? undefined,
			to: params.get('to') ?? undefined,
			project: params.get('project') ?? undefined,
			workflow: params.get('workflow') ?? undefined,
			state: params.get('state') ?? undefined,
			runner: params.get('runner') ?? undefined,
			tier: params.get('tier') ?? undefined,
			outcome: outcome as never,
			accounting_status: accounting as UsageAccountingStatus | undefined,
			by
		});
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
