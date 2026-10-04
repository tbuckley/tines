import type { ContextItem } from '@tines/shared';
import type { Kysely } from 'kysely';
import type { Database } from '$lib/server/db';
import { listContextItems, type ContextItemFilters } from './context';
import { ApiFail, type ActorContext, type Page } from './core';
import { assertMemberStillCurrent, memberActor, resolveProjectAccess } from './project-access';
import { listSharedProjects } from './shared-projects';

// Apart from member-context.ts, which the context service itself imports:
// this list calls back into the service.

/**
 * A member's shared-project context across every project shared with them,
 * each list fenced in SQL to its own project (so pages never come back short)
 * and re-checked against the membership before it is returned. A project the
 * member lost mid-request contributes no rows; the rest still list.
 */
export async function listSharedContextItems(
	db: Kysely<Database>,
	requester: ActorContext,
	filters: Pick<ContextItemFilters, 'kind' | 'state' | 'label' | 'q' | 'archived'>,
	page: Page
): Promise<{ items: ContextItem[]; hasMore: boolean }> {
	const projects = await listSharedProjects(db, requester, filters.archived ?? 'false');
	// Only the dimensions a member may filter by: a caller's wider filter
	// object (`exact`, `project`, `issue`) must not narrow or widen the fence.
	const { kind, state, label, q } = filters;
	const pages = await Promise.all(
		projects.map(async (project) => {
			try {
				const access = await resolveProjectAccess(db, requester, project.id);
				if (access.role !== 'member') return { items: [], hasMore: false };
				const actor = memberActor(requester, access, project.owner.name);
				const { items, hasMore } = await listContextItems(
					db,
					actor,
					{ kind, state, label, q, touchesProjectId: project.id },
					page
				);
				await assertMemberStillCurrent(db, actor);
				return { items, hasMore };
			} catch (error) {
				if (error instanceof ApiFail && error.status === 404) return { items: [], hasMore: false };
				throw error;
			}
		})
	);
	const merged = mergeContextPages(pages.flatMap((p) => p.items));
	return {
		items: merged.slice(0, page.limit),
		hasMore: merged.length > page.limit || pages.some((p) => p.hasMore)
	};
}

/** The list order: `updated_at` desc, then `id` desc. */
export function mergeContextPages(items: ContextItem[]): ContextItem[] {
	return [...items].sort((a, b) => b.updated_at - a.updated_at || (a.id < b.id ? 1 : -1));
}
