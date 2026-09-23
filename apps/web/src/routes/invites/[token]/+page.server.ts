import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { ApiFail } from '$lib/server/api/core';
import { invitationLanding } from '$lib/server/api/invitations';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ params, platform, locals, setHeaders }) => {
	setHeaders({ 'cache-control': 'private, no-store' });
	let invitation;
	try {
		invitation = await invitationLanding(getDb(platform!.env), params.token, locals.user?.id);
	} catch (e) {
		if (e instanceof ApiFail) error(e.status, e.message);
		throw e;
	}
	return {
		invitation,
		token: params.token
	};
};
