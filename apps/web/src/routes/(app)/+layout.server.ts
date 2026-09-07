import { redirect } from '@sveltejs/kit';
import { partitionProjects } from '$lib/archived';
import { clearStaleFocus, resolveFocus } from '$lib/server/api/preferences';
import { listProjects } from '$lib/server/api/projects';
import { getDb } from '$lib/server/db';
import type { LayoutServerLoad } from './$types';

/**
 * The app chrome's own data: the project list and the user's project focus
 * (Tines/259), loaded once here so the pages below do not each re-list
 * projects. Pages read `data.projects` / `data.archivedProjects` / `data.focus`
 * straight out of the merged `data` — deliberately *not* through `parent()`,
 * which would serialise their own queries behind this load.
 */
export const load: LayoutServerLoad = async ({ locals, platform, depends }) => {
	if (!locals.user) redirect(302, '/');
	// The switcher's PATCH invalidates just this, so choosing a project does not
	// have to refetch every page's data.
	depends('app:preferences');

	const db = getDb(platform!.env);
	const [all, resolved] = await Promise.all([
		listProjects(db, locals.user.id, { archived: 'all' }),
		resolveFocus(db, locals.user.id)
	]);

	if (resolved.staleFocusId) {
		// The focused project was deleted or archived: drop the pointer so
		// unarchiving never silently restores the focus. Lazy and fire-and-forget
		// — the resolved focus below is already null either way.
		const clearing = clearStaleFocus(
			db,
			platform!.env,
			locals.user.id,
			resolved.staleFocusId
		).catch(() => {});
		if (platform?.ctx?.waitUntil) platform.ctx.waitUntil(clearing);
		else await clearing;
	}

	const { live, archived } = partitionProjects(all);
	return {
		user: locals.user,
		projects: live,
		// Archived projects stay *nameable*: several pages resolve a stale
		// ?project= against this half.
		archivedProjects: archived,
		focus: live.find((p) => p.id === resolved.focusId) ?? null,
		// Raw: the New-issue default checks it against `projects` itself.
		lastProjectId: resolved.lastProjectId
	};
};
