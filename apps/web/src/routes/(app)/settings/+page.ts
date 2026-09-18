import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// The settings header implies a /settings parent; land it on the first tab.
export const load: PageLoad = () => {
	redirect(302, '/settings/appearance');
};
