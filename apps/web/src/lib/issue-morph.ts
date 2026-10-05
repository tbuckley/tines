/**
 * Shared-element names for the issue title and state morphing between a list
 * row and its issue page, given to the one row a navigation morphs and to no
 * other.
 *
 * Before a view transition can start, the browser snapshots every element
 * with a `view-transition-name`, each separately, while the page is frozen.
 * When every row of a 100-row list carried its two names, each navigation
 * away from the list and each filter switch waited on 200 snapshots: about
 * 400 ms in headless Chromium against 20 ms with none (docs/PERFORMANCE.md,
 * "What a view transition captures"). So rows carry their names in
 * `data-vt-name` and the layout applies them only to the morphing row.
 */

const ISSUE_ROUTE = '/(app)/issues/[project]/[number]';

type End = { route: { id: string | null }; url: URL } | null;

/** The issue page a navigation enters or leaves, if either end is one. */
export function morphingIssueHref(from: End, to: End): string | null {
	if (to?.route.id === ISSUE_ROUTE) return to.url.pathname;
	if (from?.route.id === ISSUE_ROUTE) return from.url.pathname;
	return null;
}

/**
 * Name the list row linking to `href` for the transition, and unname every
 * other row. Call it on the old page before the transition starts and on the
 * new page before its update resolves: each page is captured as it stands.
 */
export function nameMorphingRow(href: string | null) {
	for (const el of document.querySelectorAll<HTMLElement>('[data-vt-name]')) {
		const row = el.closest('a');
		el.style.viewTransitionName =
			href !== null && row?.getAttribute('href') === href ? (el.dataset.vtName ?? '') : '';
	}
}
