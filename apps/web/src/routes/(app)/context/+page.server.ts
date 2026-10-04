import { error, redirect } from '@sveltejs/kit';
import { CONTEXT_KINDS } from '@tines/shared';
import { issuePageHref } from '$lib/issue-pagination';
import {
	countSharedContextItems,
	hasGlobalAgentGuidelines,
	listContextItems
} from '$lib/server/api/context';
import { listLabelsInternal } from '$lib/server/api/labels';
import {
	actorForProject,
	assertMemberStillCurrent,
	resolveProjectAccess
} from '$lib/server/api/project-access';
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
	const { focusId, notice } = await resolvePageFocus(db, platform!.env, userId, url);
	// Focused on a project shared with this user: its items live in the owner's
	// account, so the list loads with the owner's scope (project-access.ts),
	// fenced below to that one project.
	let scopeActor = sessionActor(locals.user!);
	let viewerRole: 'owner' | 'member' = 'owner';
	if (focusId) {
		try {
			const access = await resolveProjectAccess(db, scopeActor, focusId);
			if (access.role === 'member') {
				scopeActor = await actorForProject(db, scopeActor, focusId);
				viewerRole = 'member';
			}
		} catch (e) {
			if (e instanceof ApiFail) error(e.status, e.message);
			throw e;
		}
	}
	const isMember = viewerRole === 'member';
	const scopeUserId = scopeActor.userId;
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
	const [{ items: listed, hasMore }, workflows, labels, hasAgentGuidelines, sharedItemCount] =
		await Promise.all([
			listContextItems(
				db,
				scopeActor,
				{
					...filters,
					// Artifacts pile up on every run and have their own Kind option; left
					// in the default view they push the guidance off the first page.
					excludeKinds: filters.kind ? undefined : ['artifact'],
					touchesProjectId: focusId ?? undefined
				},
				page
			),
			loadWorkflows(db, scopeUserId),
			listLabelsInternal(db, scopeUserId),
			// Offer the starter guidance until a global item by that name exists. Not
			// to a member: it would seed their own account, which this list does not show.
			isMember ? Promise.resolve(true) : hasGlobalAgentGuidelines(db, scopeUserId),
			// The owner's global and state-scoped library is not a member's to count.
			focusId && !isMember ? countSharedContextItems(db, scopeUserId) : Promise.resolve(null)
		]);
	let items = listed;
	if (isMember) {
		// `touchesProjectId` already fenced the rows to the shared project in SQL;
		// this drops an issue-scoped row that also names another project. The
		// service applied the env value rule.
		items = listed.filter((item) => !item.scope.project_id || item.scope.project_id === focusId);
		// A removal that won mid-load discards the response.
		try {
			await assertMemberStillCurrent(db, scopeActor);
		} catch (e) {
			if (e instanceof ApiFail) error(e.status, e.message);
			throw e;
		}
	}
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
		viewerRole,
		hasAgentGuidelines,
		// The cursors follow the rows read, not the rows shown: a member's
		// narrowing above may drop the page's first or last row.
		pagination: keysetPagination(url, page, listed, hasMore, (item) => item.updated_at, pageScope)
	};
};
