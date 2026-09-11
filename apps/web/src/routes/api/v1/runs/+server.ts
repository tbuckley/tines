import { json } from '@sveltejs/kit';
import type { AgentRun, ListResponse, UsagePendingRun } from '@tines/shared';
import {
	api,
	apiContext,
	ApiFail,
	encodeCursor,
	notFound,
	readPage,
	type Page
} from '$lib/server/api/core';
import { listRuns } from '$lib/server/api/runs';
import type { RequestHandler } from './$types';

interface UsageRunsCursor {
	v: 'usage-runs-v1';
	mode: 'finalized' | 'pending';
	from: number;
	to: number;
	filters: string;
	at: number;
	id: string;
}

const encodeUsageCursor = (value: UsageRunsCursor) =>
	btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function decodeUsageCursor(raw: string): UsageRunsCursor {
	try {
		const value = JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/'))) as UsageRunsCursor;
		if (
			value.v !== 'usage-runs-v1' ||
			!['finalized', 'pending'].includes(value.mode) ||
			!Number.isFinite(value.from) ||
			!Number.isFinite(value.to) ||
			!Number.isFinite(value.at) ||
			typeof value.filters !== 'string' ||
			!value.id
		)
			throw new Error('invalid');
		return value;
	} catch {
		throw new ApiFail(400, 'invalid_cursor', 'Malformed usage evidence cursor');
	}
}

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const params = event.url.searchParams;
	const recognized = [
		'population',
		'from',
		'to',
		'issue',
		'runner',
		'project',
		'workflow',
		'state',
		'tier',
		'outcome',
		'accounting_status',
		'active',
		'cursor',
		'limit'
	];
	for (const name of recognized) {
		if (params.getAll(name).length > 1)
			throw new ApiFail(422, 'invalid_field', `Duplicate "${name}" parameter`, { field: name });
		if (params.has(name) && params.get(name) === '')
			throw new ApiFail(422, 'invalid_field', `"${name}" cannot be empty`, { field: name });
	}
	const population = params.get('population') as 'finalized' | 'pending' | null;
	const from = params.get('from');
	const to = params.get('to');
	if ((from === null) !== (to === null))
		throw new ApiFail(422, 'invalid_field', 'from and to are required together');
	if (population && !['finalized', 'pending'].includes(population))
		throw new ApiFail(422, 'invalid_field', 'population must be finalized or pending');
	if ((from || to) && !population)
		throw new ApiFail(422, 'invalid_field', 'period filters require population');
	if (population && (from === null || to === null))
		throw new ApiFail(422, 'invalid_field', 'population requires from and to');
	const fromMs = from ? Date.parse(from) : undefined;
	const toMs = to ? Date.parse(to) : undefined;
	const explicitOffset =
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
	if (
		(from !== null && !explicitOffset.test(from)) ||
		(to !== null && !explicitOffset.test(to)) ||
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
	const outcome = params.get('outcome');
	if (outcome && !['advanced', 'stalled', 'interrupted', 'unknown'].includes(outcome))
		throw new ApiFail(422, 'invalid_field', 'Invalid outcome', { field: 'outcome' });
	const accountingStatus = params.get('accounting_status');
	if (accountingStatus && !['priced', 'unpriced', 'unreported'].includes(accountingStatus))
		throw new ApiFail(422, 'invalid_field', 'Invalid accounting status', {
			field: 'accounting_status'
		});
	if (accountingStatus && population !== 'finalized')
		throw new ApiFail(422, 'invalid_field', 'accounting_status requires finalized population');
	if (params.has('state') && !params.has('workflow'))
		throw new ApiFail(422, 'invalid_field', 'state requires workflow qualification');
	const tier = params.get('tier');
	if (tier && !['smartest', 'balanced', 'cheapest', 'unknown'].includes(tier))
		throw new ApiFail(422, 'invalid_field', 'Invalid tier', { field: 'tier' });
	const owned = async (
		table: 'project' | 'runner' | 'workflow',
		id: string | null,
		allowBuiltIn = false
	) => {
		if (!id || id === 'unknown') return;
		const row = await db
			.selectFrom(table)
			.select('id')
			.where('id', '=', id)
			.where((eb) =>
				allowBuiltIn
					? eb.or([eb('user_id', '=', actor.userId), eb('user_id', 'is', null)])
					: eb('user_id', '=', actor.userId)
			)
			.executeTakeFirst();
		if (!row) throw notFound();
	};
	await owned('project', params.get('project'));
	await owned('runner', params.get('runner'));
	await owned('workflow', params.get('workflow'), true);
	const issue = params.get('issue');
	if (issue) {
		const row = await db
			.selectFrom('issue')
			.innerJoin('project', 'project.id', 'issue.project_id')
			.select('issue.id')
			.where('issue.id', '=', issue)
			.where('project.user_id', '=', actor.userId)
			.executeTakeFirst();
		if (!row) throw notFound();
	}
	const state = params.get('state');
	const workflow = params.get('workflow');
	if (state && state !== 'unknown') {
		const row = await db
			.selectFrom('workflow_state')
			.innerJoin('workflow', 'workflow.id', 'workflow_state.workflow_id')
			.select('workflow_state.id')
			.where('workflow_state.id', '=', state)
			.where('workflow_state.workflow_id', '=', workflow!)
			.where((eb) =>
				eb.or([eb('workflow.user_id', '=', actor.userId), eb('workflow.user_id', 'is', null)])
			)
			.executeTakeFirst();
		if (!row) throw notFound();
	}
	const filterIdentity = JSON.stringify(
		['issue', 'runner', 'project', 'workflow', 'state', 'tier', 'outcome', 'accounting_status'].map(
			(name) => [name, params.get(name)]
		)
	);
	let page: Page;
	if (population) {
		const rawLimit = params.get('limit');
		const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : 50;
		const limit = Math.min(Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50, 100);
		const rawCursor = params.get('cursor');
		const cursor = rawCursor ? decodeUsageCursor(rawCursor) : null;
		if (
			cursor &&
			(cursor.mode !== population ||
				cursor.from !== fromMs ||
				cursor.to !== toMs ||
				cursor.filters !== filterIdentity)
		)
			throw new ApiFail(422, 'cursor_mismatch', 'Cursor does not match usage evidence filters');
		page = { limit, cursor: cursor ? { createdAt: cursor.at, id: cursor.id } : null };
	} else page = readPage(event);
	const { items, hasMore, nextBoundary } = await listRuns(
		db,
		actor.userId,
		{
			issue: params.get('issue') ?? undefined,
			runner: params.get('runner') ?? undefined,
			projectId: params.get('project') ?? undefined,
			workflow: params.get('workflow') ?? undefined,
			state: params.get('state') ?? undefined,
			tier: params.get('tier') ?? undefined,
			outcome: (outcome ?? undefined) as never,
			accountingStatus: (accountingStatus ?? undefined) as never,
			population: population ?? undefined,
			from: fromMs,
			to: toMs,
			active: ['1', 'true'].includes(params.get('active') ?? '')
		},
		page
	);
	const body: ListResponse<AgentRun | UsagePendingRun> = {
		items,
		next_cursor:
			hasMore && nextBoundary
				? population
					? encodeUsageCursor({
							v: 'usage-runs-v1',
							mode: population,
							from: fromMs!,
							to: toMs!,
							filters: filterIdentity,
							at: nextBoundary.createdAt,
							id: nextBoundary.id
						})
					: encodeCursor(nextBoundary.createdAt, nextBoundary.id)
				: null,
		...(population && fromMs !== undefined && toMs !== undefined
			? {
					usage_window: {
						from: fromMs,
						to: toMs,
						timezone: 'UTC',
						population,
						cursor_version: 'usage-runs-v1'
					}
				}
			: {})
	};
	return json(body);
});
