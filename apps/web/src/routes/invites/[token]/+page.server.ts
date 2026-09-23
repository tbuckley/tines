import { getDb } from '$lib/server/db';
import { invitationLanding } from '$lib/server/api/invitations';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ params, platform, locals, setHeaders }) => {
	setHeaders({ 'cache-control': 'private, no-store' });
	return {
		invitation: await invitationLanding(getDb(platform!.env), params.token, locals.user?.id),
		token: params.token
	};
};
