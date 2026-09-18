import { AGENT_GUIDELINES_NAME, CONTEXT_KINDS } from '@tines/shared';
import { countSharedContextItems, listContextItems } from '$lib/server/api/context';
import { listLabels } from '$lib/server/api/labels';
import { loadWorkflows } from '$lib/server/api/workflows';
import { getDb } from '$lib/server/db';
import { resolvePageFocus } from '$lib/server/page-focus';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, url, depends }) => {
	depends('app:preferences');
	const db = getDb(platform!.env);
	const userId = locals.user!.id;
	const { focusId, notice } = await resolvePageFocus(db, platform!.env, userId, url);

	// An unrecognized kind (typo, stale link) would throw a 422 out of
	// listContextItems and 500 the page; treat it as "no kind filter".
	const rawKind = url.searchParams.get('kind');
	const filters = {
		kind: rawKind && (CONTEXT_KINDS as readonly string[]).includes(rawKind) ? rawKind : undefined,
		workflow: url.searchParams.get('workflow') ?? undefined,
		label: url.searchParams.get('label') ?? undefined,
		q: url.searchParams.get('q') ?? undefined
	};
	const [{ items }, workflows, labels, guidelines, sharedItemCount] = await Promise.all([
		listContextItems(
			db,
			userId,
			{ ...filters, touchesProjectId: focusId ?? undefined },
			{ cursor: null, limit: 100 }
		),
		loadWorkflows(db, userId),
		listLabels(db, userId),
		// Offer the starter guidance until a global item by that name exists.
		listContextItems(db, userId, { kind: 'prompt', exact: true }, { cursor: null, limit: 100 }),
		focusId ? countSharedContextItems(db, userId) : Promise.resolve(null)
	]);
	// The project halves come from the app layout; the page derives the archived
	// name it needs (so a ?project= naming an archived project is not "All projects").
	return {
		items,
		workflows,
		labels,
		filters,
		focusId,
		notice,
		sharedItemCount,
		hasAgentGuidelines: guidelines.items.some((i) => i.name === AGENT_GUIDELINES_NAME)
	};
};
