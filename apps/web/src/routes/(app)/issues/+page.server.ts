import { error, redirect } from '@sveltejs/kit';
import { clearIssuePagination, issuePageHref } from '$lib/issue-pagination';
import { ApiFail } from '$lib/server/api/core';
import { countIssuesByCategory, listAwaitingIssues, listIssues } from '$lib/server/api/issues';
import { resolveFocus, setFocus } from '$lib/server/api/preferences';
import { listLabels } from '$lib/server/api/labels';
import { listProjects } from '$lib/server/api/projects';
import { loadWorkflows } from '$lib/server/api/workflows';
import { getDb } from '$lib/server/db';
import { issuePagination, readIssuePage } from '$lib/server/issue-pagination';
import type { PageServerLoad } from './$types';

/**
 * What a `?project=` that did not become a redirect left behind: either the
 * ref names nothing at all, or it names a project that has since been
 * archived — which is still worth naming rather than reading as "All projects".
 */
export type IssuesNotice =
	| { kind: 'unknown'; ref: string }
	| { kind: 'archived'; ref: string; project: { id: string; name: string } };

export const load: PageServerLoad = async ({ locals, platform, url }) => {
	const db = getDb(platform!.env);
	const userId = locals.user!.id;

	// The project scope is the focus, not a URL filter (Tines/259) — one
	// PK-indexed query ahead of the lists that read it.
	const { focusId, lastProjectId } = await resolveFocus(db, userId);
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
	// This is the one focus write that happens in a `load`, which is safe only
	// while no in-app link carries `/issues?project=`: the app preloads links on
	// hover (`app.html`), so such a link would move the focus on hover alone.
	// A link that needs to offer a project must point at `/projects/<id>`, whose
	// page sets the focus client-side, or PATCH `/preferences` itself.
	const ref = url.searchParams.get('project');
	let notice: IssuesNotice | null = null;
	if (ref) {
		const all = await listProjects(db, userId, { archived: 'all' });
		const hit = all.find((p) => p.id === ref || p.name === ref);
		if (hit && hit.archived_at === null) {
			await setFocus(db, platform!.env, userId, hit.id);
			const rest = new URLSearchParams(url.searchParams);
			rest.delete('project');
			clearIssuePagination(rest);
			const qs = rest.toString();
			redirect(303, `/issues${qs ? `?${qs}` : ''}`);
		}
		// No write either way: a link that names nothing (or names a frozen
		// project) leaves the focus exactly as the user last set it.
		notice = hit
			? { kind: 'archived', ref, project: { id: hit.id, name: hit.name } }
			: { kind: 'unknown', ref };
	}

	const pageScope = focusId ?? 'all';
	const suppliedScope = url.searchParams.get('page_scope');
	if (page.cursor && suppliedScope !== null && suppliedScope !== pageScope) {
		redirect(303, issuePageHref(url));
	}

	const categoryParam = url.searchParams.get('category') ?? undefined;
	const filters = {
		state: url.searchParams.get('state') ?? undefined,
		category: categoryParam === 'awaiting' ? 'awaiting_human' : categoryParam,
		showDone: url.searchParams.get('done') === '1',
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
		state: filters.state,
		ready: filters.ready,
		q: filters.q,
		labels: filters.labels
	};

	const listFilters = {
		...scope,
		category: filters.category,
		// Ready already implies not-done, so the "show done" state is
		// simply parked in the URL while it is on.
		hideDone: !filters.showDone && !filters.category && !filters.state,
		brief: true
	};
	const issuesPromise =
		filters.category === 'awaiting_human'
			? listAwaitingIssues(db, userId, listFilters, page)
			: listIssues(db, userId, listFilters, page);
	const [{ items: issues, hasMore }, counts, workflows, labels] = await Promise.all([
		issuesPromise,
		countIssuesByCategory(db, userId, scope),
		loadWorkflows(db, userId),
		listLabels(db, userId)
	]);

	// `projects` and `focus` come from the app layout.
	return {
		issues,
		counts,
		workflows,
		labels,
		filters,
		focusId,
		lastProjectId,
		notice,
		pagination: issuePagination(
			url,
			page,
			issues,
			hasMore,
			pageScope,
			filters.category === 'awaiting_human'
				? (item) => item.state_entered_at ?? item.created_at
				: undefined
		)
	};
};
