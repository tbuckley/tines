import { json } from '@sveltejs/kit';
import type { UpdateIssueRequest } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { getIssueDetail, updateIssue } from '$lib/server/api/issues';
import { readSharedIssue } from '$lib/server/api/shared-issues';
import { resolveIssueAccess } from '$lib/server/api/project-access';
import { removeMember } from '$lib/server/api/invitations';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const access = await resolveIssueAccess(db, actor, event.params.id);
	const beforeFinalCheck =
		access.role === 'member' &&
		import.meta.env.VITE_TINES_E2E === '1' &&
		event.request.headers.get('x-tines-e2e-membership-race') === 'remove-before-return'
			? async () => {
					const owner = await db
						.selectFrom('user')
						.select('name')
						.where('id', '=', access.ownerId)
						.executeTakeFirstOrThrow();
					await removeMember(
						db,
						env,
						{
							userId: access.ownerId,
							userName: owner.name,
							apiKeyId: null,
							apiKeyName: null,
							viaSession: true
						},
						access.projectId,
						actor.userId,
						access.membershipRevision
					);
				}
			: undefined;
	return json(
		access.role === 'owner'
			? await getIssueDetail(db, actor.userId, { id: event.params.id }, { round: true })
			: await readSharedIssue(db, actor, { id: event.params.id }, beforeFinalCheck)
	);
});

export const PATCH: RequestHandler = api(async (event) => {
	const { db, env, actor, effects } = await apiContext(event);
	const body = await readJson<UpdateIssueRequest>(event);
	const issue = await updateIssue(db, env, actor, effects, event.params.id, body);
	return json(issue);
});
