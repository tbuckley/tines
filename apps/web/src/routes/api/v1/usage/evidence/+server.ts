import { json } from '@sveltejs/kit';
import { api, apiContext, ApiFail, notFound } from '$lib/server/api/core';
import { getUsageEvidence, type EvidenceRequest } from '$lib/server/api/usage-evidence';
import { getCohortUsageEvidence } from '$lib/server/api/usage-cohorts';
import { getIssueUsage, getUsage } from '$lib/server/api/usage';
import { usageKeyMaterial, verifyUsageScope } from '$lib/server/usage-scope';
import type { RequestHandler } from './$types';
import { requireAccess } from '$lib/server/api/permissions';

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
	if (!scopeToken) throw new ApiFail(422, 'invalid_field', 'scope is required', { field: 'scope' });
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
	if (scope.mode === 'issue') {
		const issue = await db
			.selectFrom('issue')
			.innerJoin('project', 'project.id', 'issue.project_id')
			.select(['issue.id', 'issue.project_id'])
			.where('issue.id', '=', scope.issue)
			.where('project.user_id', '=', actor.userId)
			.executeTakeFirst();
		if (!issue) throw notFound();
		requireAccess(
			actor,
			[{ domain: 'project', access: 'read', projectId: issue.project_id }],
			'usage.issue',
			{ projectId: issue.project_id, issueId: issue.id }
		);
	} else {
		requireAccess(
			actor,
			[
				{ domain: 'control_plane', access: 'read' },
				{ domain: 'workspace', access: 'read' }
			],
			'usage.read'
		);
	}
	const kind = (params.get('kind') ?? 'issues') as 'issues' | 'runs' | 'entries';
	const population = (params.get('population') ??
		(scope.mode === 'cohort' && kind !== 'runs' ? 'all' : 'finalized')) as
		'all' | 'finalized' | 'pending';
	const sort = (params.get('sort') ??
		(population === 'pending' || kind === 'entries' ? 'time' : 'cost')) as 'cost' | 'time';
	const direction = (params.get('direction') ?? 'desc') as 'asc' | 'desc';
	if (!['issues', 'runs', 'entries'].includes(kind))
		throw new ApiFail(422, 'invalid_field', 'kind must be issues, runs, or entries', {
			field: 'kind'
		});
	if (!['all', 'finalized', 'pending'].includes(population))
		throw new ApiFail(422, 'invalid_field', 'population must be all, finalized, or pending', {
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
		const evidenceRequest = {
			kind,
			population,
			member: params.get('member'),
			sort,
			direction,
			limit: Number(limitText),
			cursor: params.get('cursor')
		} satisfies EvidenceRequest;
		const result =
			scope.mode === 'cohort'
				? await getCohortUsageEvidence(
						db,
						actor.userId,
						scopeToken,
						scope,
						evidenceRequest,
						material
					)
				: await getUsageEvidence(
						db,
						actor.userId,
						scopeToken,
						scope,
						evidenceRequest,
						material,
						actor
					);
		if (scope.mode !== 'cohort' && params.has('member') && result.total_count === 0)
			throw new Error('member is not a contributor in this selection');
		if (scope.mode === 'cohort')
			return json(result, { headers: { 'cache-control': 'private, no-store' } });
		const parent =
			scope.mode === 'issue'
				? await getIssueUsage(db, actor.userId, scope.issue, scope.cutoff)
				: await getUsage(
						db,
						actor.userId,
						{
							from: new Date(scope.from).toISOString(),
							to: new Date(scope.to).toISOString(),
							...scope.filters,
							by: scope.by
						},
						Date.now(),
						actor
					);
		const parentTotal = parent?.mode === 'issue' ? parent.issue.aggregate : parent?.matching_total;
		if (parent?.mode === 'issue') {
			result.attempt_count = parent.issue.attempt_count;
			result.pending_count = parent.issue.pending_count;
		}
		if (parentTotal) {
			if (params.has('member')) result.parent_matching_total = parentTotal;
			else if (population === 'pending') result.matching_total = parentTotal;
		}
		return json(result, { headers: { 'cache-control': 'private, no-store' } });
	} catch (error) {
		throw new ApiFail(422, 'invalid_evidence_selection', (error as Error).message, {
			remedy: 'restart evidence from its usage report'
		});
	}
});
