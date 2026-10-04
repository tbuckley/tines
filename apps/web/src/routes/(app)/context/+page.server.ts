import { error, redirect } from '@sveltejs/kit';
import { CONTEXT_KINDS } from '@tines/shared';
import { issuePageHref } from '$lib/issue-pagination';
import {
	countSharedContextItems,
	hasGlobalAgentGuidelines,
	listContextItems
} from '$lib/server/api/context';
import { listLabelsInternal } from '$lib/server/api/labels';
import { loadWorkflows } from '$lib/server/api/workflows';
import { getDb } from '$lib/server/db';
import { keysetPagination, readIssuePage } from '$lib/server/issue-pagination';
import { resolvePageFocus } from '$lib/server/page-focus';
import { ApiFail, sessionActor } from '$lib/server/api/core';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, url, depends }) => {
	depends('app:preferences');
	const db = getDb(platform!.env);
	const userId = locals.user!.id;
	const actor = sessionActor(locals.user!);
	const { focusId, notice } = await resolvePageFocus(db, platform!.env, userId, url);
	let page;
	try {
		page = readIssuePage(url);
	} catch (e) {
		if (e instanceof ApiFail) error(e.status, e.message);
		throw e;
	}
	// A cursor belongs to the focus it was minted under; under another focus it
	// would land mid-list, so go back to the first page with the filters kept.
	const pageScope = focusId ?? 'all';
	const suppliedScope = url.searchParams.get('page_scope');
	if (page.cursor && suppliedScope !== null && suppliedScope !== pageScope) {
		redirect(303, issuePageHref(url));
	}

	// An unrecognized kind (typo, stale link) would throw a 422 out of
	// listContextItems and 500 the page; treat it as "no kind filter".
	const rawKind = url.searchParams.get('kind');
	const filters = {
		kind: rawKind && (CONTEXT_KINDS as readonly string[]).includes(rawKind) ? rawKind : undefined,
		workflow: url.searchParams.get('workflow') ?? undefined,
		label: url.searchParams.get('label') ?? undefined,
		q: url.searchParams.get('q') ?? undefined
	};
	const [{ items, hasMore }, workflows, labels, hasAgentGuidelines, sharedItemCount] =
		await Promise.all([
			listContextItems(
				db,
				actor,
				{
					...filters,
					// Artifacts pile up on every run and have their own Kind option; left
					// in the default view they push the guidance off the first page.
					excludeKinds: filters.kind ? undefined : ['artifact'],
					touchesProjectId: focusId ?? undefined
				},
				page
			),
			loadWorkflows(db, userId),
			listLabelsInternal(db, userId),
			// Offer the starter guidance until a global item by that name exists.
			hasGlobalAgentGuidelines(db, userId),
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
		hasAgentGuidelines,
		pagination: keysetPagination(url, page, items, hasMore, (item) => item.updated_at, pageScope)
	};
};
