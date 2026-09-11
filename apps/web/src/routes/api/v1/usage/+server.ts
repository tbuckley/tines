import { json } from '@sveltejs/kit';
import { UsageInputError, type UsageAccountingStatus, type UsageBy } from '@tines/shared';
import { api, apiContext, ApiFail } from '$lib/server/api/core';
import { getUsage } from '$lib/server/api/usage';
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
	'by'
];

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const params = event.url.searchParams;
	for (const name of recognized)
		if (params.getAll(name).length > 1)
			throw new ApiFail(422, 'invalid_field', `Duplicate "${name}" parameter`, { field: name });
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
	if (params.has('state') && !params.has('workflow'))
		throw new ApiFail(422, 'invalid_field', 'state requires workflow qualification', {
			field: 'state'
		});
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
			throw new ApiFail(422, 'invalid_usage_period', error.message);
		throw error;
	}
});
