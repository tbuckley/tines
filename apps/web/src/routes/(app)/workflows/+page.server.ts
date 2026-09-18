import { loadWorkflows } from '$lib/server/api/workflows';
import { countOpenIssuesByWorkflow } from '$lib/server/api/issues';
import { resolveFocus } from '$lib/server/api/preferences';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, depends }) => {
	depends('app:preferences');
	const db = getDb(platform!.env);
	const userId = locals.user!.id;
	const [workflows, { focusId }] = await Promise.all([
		loadWorkflows(db, userId),
		resolveFocus(db, userId)
	]);
	return {
		workflows,
		focusId,
		focusedOpenCounts: focusId ? await countOpenIssuesByWorkflow(db, userId, focusId) : null
	};
};
