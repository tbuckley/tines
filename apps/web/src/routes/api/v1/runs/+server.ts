import { json } from '@sveltejs/kit';
import type { AgentRun, ListResponse } from '@tines/shared';
import { api, apiContext, ApiFail, encodeCursor, readPage } from '$lib/server/api/core';
import { listRuns } from '$lib/server/api/runs';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const page = readPage(event);
	const params = event.url.searchParams;
	const population = params.get('population') as 'finalized' | 'pending' | null;
	const from = params.get('from');
	const to = params.get('to');
	if ((from === null) !== (to === null))
		throw new ApiFail(422, 'invalid_field', 'from and to are required together');
	if (population && !['finalized', 'pending'].includes(population))
		throw new ApiFail(422, 'invalid_field', 'population must be finalized or pending');
	if ((from || to) && !population)
		throw new ApiFail(422, 'invalid_field', 'period filters require population');
	const fromMs = from ? Date.parse(from) : undefined;
	const toMs = to ? Date.parse(to) : undefined;
	if (
		(fromMs !== undefined && !Number.isFinite(fromMs)) ||
		(toMs !== undefined && !Number.isFinite(toMs))
	)
		throw new ApiFail(422, 'invalid_field', 'from and to must be ISO timestamps');
	if (fromMs !== undefined && toMs !== undefined && fromMs >= toMs)
		throw new ApiFail(422, 'invalid_field', 'from must be before to');
	if (params.has('active') && population)
		throw new ApiFail(422, 'invalid_field', 'active cannot be combined with a period population');
	if (population === 'pending' && (params.has('outcome') || params.has('accounting_status')))
		throw new ApiFail(
			422,
			'invalid_field',
			'pending evidence cannot use outcome or accounting_status'
		);
	const { items, hasMore } = await listRuns(
		db,
		actor.userId,
		{
			issue: params.get('issue') ?? undefined,
			runner: params.get('runner') ?? undefined,
			projectId: params.get('project') ?? undefined,
			workflow: params.get('workflow') ?? undefined,
			state: params.get('state') ?? undefined,
			tier: params.get('tier') ?? undefined,
			outcome: (params.get('outcome') ?? undefined) as never,
			accountingStatus: (params.get('accounting_status') ?? undefined) as never,
			population: population ?? undefined,
			from: fromMs,
			to: toMs,
			active: ['1', 'true'].includes(params.get('active') ?? '')
		},
		page
	);
	const last = items[items.length - 1];
	const body: ListResponse<AgentRun> = {
		items,
		next_cursor:
			hasMore && last
				? encodeCursor(population === 'finalized' ? last.ended_at! : last.created_at, last.id)
				: null
	};
	return json(body);
});
