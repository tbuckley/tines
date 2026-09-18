import { error, redirect } from '@sveltejs/kit';
import { hostModerationConfig } from '$lib/server/publications/config';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, platform, url }) => {
	if (!locals.user) redirect(302, `/?returnTo=${encodeURIComponent(url.pathname)}`);
	if (!hostModerationConfig(platform!.env).moderatorUserIds.has(locals.user.id))
		error(404, 'Not found');
	return { user: { name: locals.user.name } };
};
