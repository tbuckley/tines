import { json } from '@sveltejs/kit';
import {
	parseUsageBound,
	validateTimezone,
	type AgentRun,
	type ListResponse,
	type UsagePendingRun
} from '@tines/shared';
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
	v: 'usage-runs-v2';
	mode: 'finalized' | 'pending';
	from: number;
	to: number;
	filters: string;
	timezone: string;
	timezone_source: 'supervisor_budget' | 'utc_fallback';
	at: number;
	id: string;
}

const encodeUsageCursor = (value: UsageRunsCursor) =>
	btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function decodeUsageCursor(raw: string): UsageRunsCursor {
	try {
		if (raw.length > 16_384 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error('invalid');
		const value = JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/'))) as UsageRunsCursor;
		if ((value as { v?: string }).v === 'usage-runs-v1')
			throw new ApiFail(
				422,
				'unsupported_cursor_version',
				'This usage evidence cursor predates retained identity support; restart without cursor',
				{ field: 'cursor', remedy: 'restart without cursor using the same bounds and filters' }
			);
		if (
			value.v !== 'usage-runs-v2' ||
			!['finalized', 'pending'].includes(value.mode) ||
			!Number.isFinite(value.from) ||
			!Number.isFinite(value.to) ||
			!Number.isSafeInteger(value.from) ||
			!Number.isSafeInteger(value.to) ||
			!Number.isSafeInteger(value.at) ||
			typeof value.filters !== 'string' ||
			!value.id ||
			!['supervisor_budget', 'utc_fallback'].includes(value.timezone_source) ||
			validateTimezone(value.timezone) !== value.timezone
		)
			throw new Error('invalid');
		return value;
	} catch (error) {
		if (error instanceof ApiFail) throw error;
		throw new ApiFail(422, 'invalid_cursor', 'Malformed usage evidence cursor', {
			field: 'cursor',
			remedy: 'restart without cursor using the same bounds and filters'
		});
	}
}

async function evidenceTimezone(
	db: Parameters<typeof listRuns>[0],
	userId: string
): Promise<{ timezone: string; timezone_source: 'supervisor_budget' | 'utc_fallback' }> {
	const row = await db
		.selectFrom('supervisor_settings')
		.select('budget')
		.where('user_id', '=', userId)
		.executeTakeFirst();
	if (row?.budget) {
		try {
			const value = JSON.parse(row.budget) as { timezone?: unknown };
			if (typeof value.timezone === 'string')
				return { timezone: validateTimezone(value.timezone), timezone_source: 'supervisor_budget' };
		} catch {
			// Invalid settings retain the documented UTC fallback.
		}
	}
	return { timezone: 'UTC', timezone_source: 'utc_fallback' };
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
		'limit',
		'timezone',
		'timezone_source'
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
	let fromMs: number | undefined;
	let toMs: number | undefined;
	try {
		fromMs = from ? parseUsageBound(from, 'UTC', false) : undefined;
		toMs = to ? parseUsageBound(to, 'UTC', false) : undefined;
	} catch {
		throw new ApiFail(
			422,
			'invalid_usage_period',
			'from and to must be valid ISO timestamps with explicit offsets',
			{ field: 'from/to', accepted: 'ISO timestamp with Z or signed offset' }
		);
	}
	if (fromMs !== undefined && toMs !== undefined && fromMs >= toMs)
		throw new ApiFail(422, 'invalid_field', 'from must be before to');
	if (toMs !== undefined && toMs > Date.now())
		throw new ApiFail(422, 'invalid_usage_period', 'to cannot be in the future', { field: 'to' });
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
	let resolvedZone: {
		timezone: string;
		timezone_source: 'supervisor_budget' | 'utc_fallback';
	} | null = null;
	if (population) {
		const rawLimit = params.get('limit');
		if (rawLimit && !/^[1-9]\d*$/.test(rawLimit))
			throw new ApiFail(422, 'invalid_field', 'limit must be an integer from 1 to 100', {
				field: 'limit',
				accepted: 'integer 1..100',
				remedy: 'omit limit for 50'
			});
		const limit = rawLimit ? Number(rawLimit) : 50;
		if (!Number.isSafeInteger(limit) || limit > 100)
			throw new ApiFail(422, 'invalid_field', 'limit must be an integer from 1 to 100', {
				field: 'limit',
				accepted: 'integer 1..100',
				remedy: 'omit limit for 50'
			});
		const rawCursor = params.get('cursor');
		const cursor = rawCursor ? decodeUsageCursor(rawCursor) : null;
		const timezoneParam = params.get('timezone');
		const timezoneSourceParam = params.get('timezone_source');
		if ((timezoneParam === null) !== (timezoneSourceParam === null))
			throw new ApiFail(
				422,
				'invalid_field',
				'timezone and timezone_source are required together',
				{ field: 'timezone' }
			);
		try {
			resolvedZone = cursor
				? { timezone: cursor.timezone, timezone_source: cursor.timezone_source }
				: timezoneParam && timezoneSourceParam
					? {
							timezone: validateTimezone(timezoneParam),
							timezone_source: timezoneSourceParam as 'supervisor_budget' | 'utc_fallback'
						}
					: await evidenceTimezone(db, actor.userId);
		} catch {
			throw new ApiFail(422, 'invalid_field', 'Invalid IANA timezone', { field: 'timezone' });
		}
		if (
			!['supervisor_budget', 'utc_fallback'].includes(resolvedZone.timezone_source) ||
			(resolvedZone.timezone_source === 'utc_fallback' && resolvedZone.timezone !== 'UTC')
		)
			throw new ApiFail(422, 'invalid_field', 'Invalid timezone provenance', {
				field: 'timezone_source'
			});
		if (
			cursor &&
			(cursor.mode !== population ||
				cursor.from !== fromMs ||
				cursor.to !== toMs ||
				cursor.filters !== filterIdentity ||
				(timezoneParam !== null &&
					(timezoneParam !== cursor.timezone || timezoneSourceParam !== cursor.timezone_source)))
		)
			throw new ApiFail(422, 'cursor_mismatch', 'Cursor does not match usage evidence filters');
		page = { limit, cursor: cursor ? { createdAt: cursor.at, id: cursor.id } : null };
	} else page = readPage(event);
	const { items, hasMore, nextBoundary, scanComplete } = await listRuns(
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
							v: 'usage-runs-v2',
							mode: population,
							from: fromMs!,
							to: toMs!,
							filters: filterIdentity,
							timezone: resolvedZone!.timezone,
							timezone_source: resolvedZone!.timezone_source,
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
						timezone: resolvedZone!.timezone,
						timezone_source: resolvedZone!.timezone_source,
						population,
						cursor_version: 'usage-runs-v2',
						scan_complete: scanComplete,
						accounting_basis: 'finalized_by_ended_at_v1',
						attribution_basis: 'current_issue_project_start_state_workflow_v1'
					}
				}
			: {})
	};
	return json(body);
});
