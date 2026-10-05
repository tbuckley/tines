import { error } from '@sveltejs/kit';
import { ApiFail, sessionActor } from '$lib/server/api/core';
import { getOrganization } from '$lib/server/api/organizations';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, params }) => {
	const actor = sessionActor({ id: locals.user!.id, name: locals.user!.name });
	const organization = await getOrganization(getDb(platform!.env), actor, params.id).catch((e) => {
		if (e instanceof ApiFail) error(e.status, e.message);
		throw e;
	});
	return { organization, viewerId: actor.userId };
};
