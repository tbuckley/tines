import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// A signed-in user who mistypes a URL should still get the app's chrome, so
// unmatched paths resolve to a real (app) route that throws straight into
// (app)/+error.svelte. Anything under /api/ is excluded by the notApi matcher.
export const load: PageLoad = () => {
	error(404, 'There is no page at this address.');
};
