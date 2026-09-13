import { json } from '@sveltejs/kit';
import { api, apiContext, ApiFail, notFound } from '$lib/server/api/core';
import { getUsageEvidence } from '$lib/server/api/usage-evidence';
import { usageKeyMaterial, verifyUsageScope } from '$lib/server/usage-scope';
import type { RequestHandler } from './$types';

const recognized = [
	'scope',
	'kind',
	'population',
	'member',
	'sort',
	'direction',
	'limit',
	'cursor'
];

export const GET: RequestHandler = api(async (event) => {
	const { db, actor, env } = await apiContext(event);
	const params = event.url.searchParams;
	for (const name of params.keys())
		if (!recognized.includes(name))
			throw new ApiFail(422, 'invalid_field', `Unsupported usage evidence parameter "${name}"`, {
				field: name
			});
	for (const name of recognized) {
		if (params.getAll(name).length > 1)
			throw new ApiFail(422, 'invalid_field', `Duplicate "${name}" parameter`, { field: name });
		if (params.has(name) && params.get(name) === '')
			throw new ApiFail(422, 'invalid_field', `"${name}" cannot be empty`, { field: name });
	}
	const material = usageKeyMaterial(env);
	if (!material)
		throw new ApiFail(
			500,
			'usage_signing_unavailable',
			'Usage evidence needs SECRET_ENCRYPTION_KEY or BETTER_AUTH_SECRET'
		);
	const scopeToken = params.get('scope');
	if (!scopeToken)
		throw new ApiFail(422, 'invalid_field', 'scope is required', { field: 'scope' });
	let scope;
	try {
		scope = await verifyUsageScope(scopeToken, material);
	} catch (error) {
		throw new ApiFail(422, 'invalid_scope', (error as Error).message, {
			field: 'scope',
			remedy: 'restart from the usage report'
		});
	}
	if (scope.owner !== actor.userId) throw notFound();
	const kind = (params.get('kind') ?? 'issues') as 'issues' | 'runs';
	const population = (params.get('population') ?? 'finalized') as 'finalized' | 'pending';
	const sort = (params.get('sort') ?? (population === 'pending' ? 'time' : 'cost')) as
		| 'cost'
		| 'time';
	const direction = (params.get('direction') ?? 'desc') as 'asc' | 'desc';
	if (!['issues', 'runs'].includes(kind))
		throw new ApiFail(422, 'invalid_field', 'kind must be issues or runs', { field: 'kind' });
	if (!['finalized', 'pending'].includes(population))
		throw new ApiFail(422, 'invalid_field', 'population must be finalized or pending', {
			field: 'population'
		});
	if (!['cost', 'time'].includes(sort))
		throw new ApiFail(422, 'invalid_field', 'sort must be cost or time', { field: 'sort' });
	if (!['asc', 'desc'].includes(direction))
		throw new ApiFail(422, 'invalid_field', 'direction must be asc or desc', {
			field: 'direction'
		});
	const limitText = params.get('limit') ?? '50';
	if (!/^\d+$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > 100)
		throw new ApiFail(422, 'invalid_field', 'limit must be an integer from 1 to 100', {
			field: 'limit'
		});
	try {
		const result = await getUsageEvidence(
			db,
			actor.userId,
			scopeToken,
			scope,
			{
				kind,
				population,
				member: params.get('member'),
				sort,
				direction,
				limit: Number(limitText),
				cursor: params.get('cursor')
			},
			material
		);
		return json(result, { headers: { 'cache-control': 'private, no-store' } });
	} catch (error) {
		throw new ApiFail(422, 'invalid_evidence_selection', (error as Error).message, {
			remedy: 'restart evidence from its usage report'
		});
	}
});
