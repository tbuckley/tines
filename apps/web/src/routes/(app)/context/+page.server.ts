import { AGENT_GUIDELINES_NAME, CONTEXT_KINDS } from '@tines/shared';
import { listContextItems } from '$lib/server/api/context';
import { listProjects } from '$lib/server/api/projects';
import { loadWorkflows } from '$lib/server/api/workflows';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, url }) => {
	const db = getDb(platform!.env);
	const userId = locals.user!.id;

	// An unrecognized kind (typo, stale link) would throw a 422 out of
	// listContextItems and 500 the page; treat it as "no kind filter".
	const rawKind = url.searchParams.get('kind');
	const filters = {
		kind: rawKind && (CONTEXT_KINDS as readonly string[]).includes(rawKind) ? rawKind : undefined,
		project: url.searchParams.get('project') ?? undefined,
		q: url.searchParams.get('q') ?? undefined
	};
	const [{ items }, projects, workflows, guidelines] = await Promise.all([
		listContextItems(db, userId, filters, { cursor: null, limit: 100 }),
		listProjects(db, userId),
		loadWorkflows(db, userId),
		// Offer the starter guidance until a global item by that name exists.
		listContextItems(db, userId, { kind: 'prompt', exact: true }, { cursor: null, limit: 100 })
	]);
	return {
		items,
		projects,
		workflows,
		filters,
		hasAgentGuidelines: guidelines.items.some((i) => i.name === AGENT_GUIDELINES_NAME)
	};
};
