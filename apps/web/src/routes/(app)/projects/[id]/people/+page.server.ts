import { error } from '@sveltejs/kit';
import { ApiFail } from '$lib/server/api/core';
import { getDb } from '$lib/server/db';
import { listInvitations, listPeople } from '$lib/server/api/invitations';
import { listInclusions } from '$lib/server/api/guidance-inclusions';
import { resolveProjectAccess } from '$lib/server/api/project-access';
import { sharedExecutionEnabled } from '$lib/server/api/shared-execution';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ locals, platform, params }) => {
	const db = getDb(platform!.env);
	const actor = {
		userId: locals.user!.id,
		userName: locals.user!.name,
		apiKeyId: null,
		apiKeyName: null,
		viaSession: true
	};
	const access = await resolveProjectAccess(db, actor, params.id).catch((e) => {
		if (e instanceof ApiFail) error(e.status, e.message);
		throw e;
	});
	const [people, invitations] = await Promise.all([
		listPeople(db, actor, params.id),
		access.role === 'owner' ? listInvitations(db, actor, params.id) : Promise.resolve([])
	]);
	const project = await db
		.selectFrom('project')
		.select(['name', 'sharing_revision'])
		.where('id', '=', params.id)
		.executeTakeFirstOrThrow();
	// The invite form's one-line guidance summary (Tines/752), owner-only and flagged.
	const includedGuidance =
		access.role === 'owner' && sharedExecutionEnabled(platform!.env)
			? (await listInclusions(db, platform!.env, actor, params.id)).items.length
			: null;
	return {
		people,
		includedGuidance,
		invitations,
		project,
		role: access.role,
		projectId: params.id,
		viewerId: actor.userId,
		membershipRevision: access.membershipRevision
	};
};
