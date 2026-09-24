import { error, redirect } from '@sveltejs/kit';
import { issuePageHref } from '$lib/issue-pagination';
import { ApiFail, sessionActor } from '$lib/server/api/core';
import { countIssuesByCategory, listIssues } from '$lib/server/api/issues';
import { actorForProject, resolveProjectAccess } from '$lib/server/api/project-access';
import { listLabelsInternal } from '$lib/server/api/labels';
import { scopeBlockersForMember } from '$lib/server/api/member-context';
import { loadWorkflows } from '$lib/server/api/workflows';
import { getDb } from '$lib/server/db';
import { issuePagination, readIssuePage } from '$lib/server/issue-pagination';
import { resolvePageFocus } from '$lib/server/page-focus';
import type { PageServerLoad } from './$types';

/**
 * What a `?project=` that did not become a redirect left behind: either the
 * ref names nothing at all, or it names a project that has since been
 * archived — which is still worth naming rather than reading as "All projects".
 */
export const load: PageServerLoad = async ({ locals, platform, url, depends }) => {
	depends('app:preferences');
	const db = getDb(platform!.env);
	const userId = locals.user!.id;

	// The project scope is the focus, not a URL filter (Tines/259) — one
	// PK-indexed query ahead of the lists that read it.
	const { focusId, lastProjectId, notice } = await resolvePageFocus(db, platform!.env, userId, url);
	// Focused on a project shared with this user: the owner's list, loaded
	// with the owner's scope so members see and file issues exactly as the
	// owner does (project-access.ts).
	let scopeActor = sessionActor(locals.user!);
	let viewerRole: 'owner' | 'member' = 'owner';
	if (focusId) {
		const access = await resolveProjectAccess(db, scopeActor, focusId);
		if (access.role === 'member') {
			scopeActor = await actorForProject(db, scopeActor, focusId);
			viewerRole = 'member';
		}
	}
	const scopeUserId = scopeActor.userId;
	let page;
	try {
		page = readIssuePage(url);
	} catch (e) {
		if (e instanceof ApiFail) error(e.status, e.message);
		throw e;
	}

	// `?project=` is a one-shot: it *sets* the focus and redirects, so the list
	// keeps one address. Every other filter rides along to the new URL.
	//
	// These are the only focus writes that happen in a `load`, which is safe only
	// while no in-app link carries `/issues?project=`: the app preloads links on
	// hover (`app.html`), so such a link would move the focus on hover alone.
	// A link that needs to offer a project must point at `/projects/<id>`, whose
	// page sets the focus client-side, or PATCH `/preferences` itself.
	const pageScope = focusId ?? 'all';
	const suppliedScope = url.searchParams.get('page_scope');
	if (page.cursor && suppliedScope !== null && suppliedScope !== pageScope) {
		redirect(303, issuePageHref(url));
	}

	const filters = {
		workflow: url.searchParams.get('workflow') ?? undefined,
		state: url.searchParams.get('state') ?? undefined,
		category: url.searchParams.get('category') ?? undefined,
		showDone: url.searchParams.get('done') === '1',
		showDuplicates: url.searchParams.get('duplicates') === '1',
		ready: url.searchParams.get('ready') === '1',
		q: url.searchParams.get('q') ?? undefined,
		// Repeatable: ?label=a&label=b narrows to issues carrying both.
		labels: url.searchParams.getAll('label')
	};

	// Everything but the category tab itself; the tabs' counts share it.
	// `projectId`, never `project`: a named project is shown whatever its
	// archived state, and a resolved focus is always live.
	const scope = {
		projectId: focusId ?? undefined,
		workflow: filters.workflow,
		state: filters.state,
		hideDuplicates: !filters.showDuplicates,
		ready: filters.ready,
		q: filters.q,
		labels: filters.labels
	};

	const [{ items: issues, hasMore }, counts, workflows, labels] = await Promise.all([
		listIssues(
			db,
			scopeUserId,
			{
				...scope,
				category: filters.category,
				// Ready already implies not-done, so the "show done" state is
				// simply parked in the URL while it is on.
				hideDone: !filters.showDone && !filters.category && !filters.state,
				brief: true
			},
			page
		),
		countIssuesByCategory(db, scopeUserId, scope),
		loadWorkflows(db, scopeUserId),
		listLabelsInternal(db, scopeUserId)
	]);

	// `projects` and `focus` come from the app layout.
	return {
		viewerRole,
		issues: scopeBlockersForMember(scopeActor, issues),
		counts,
		workflows,
		labels,
		filters,
		focusId,
		lastProjectId,
		notice,
		pagination: issuePagination(url, page, issues, hasMore, pageScope)
	};
};
