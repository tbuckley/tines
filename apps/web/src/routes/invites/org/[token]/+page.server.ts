import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { ApiFail } from '$lib/server/api/core';
import { organizationInvitationLanding } from '$lib/server/api/organizations';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, platform, locals, setHeaders }) => {
	setHeaders({ 'cache-control': 'private, no-store' });
	try {
		return {
			invitation: await organizationInvitationLanding(
				getDb(platform!.env),
				params.token,
				locals.user?.id
			),
			token: params.token
		};
	} catch (e) {
		if (e instanceof ApiFail) error(e.status, e.message);
		throw e;
	}
};
