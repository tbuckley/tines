/**
 * Project archiving, as the browser sees it. Archived projects stay readable
 * everywhere — they are hidden from the lists and pickers that feed new work,
 * and every control that would write is disabled with one shared tooltip.
 */
import type { Project } from '@tines/shared';

/** The one tooltip every control disabled by an archived project shows. */
export const PROJECT_ARCHIVED_TOOLTIP = 'Project archived — unarchive to make changes';

/** Live projects first (server order preserved within each half), archived after them. */
export function partitionProjects(projects: Project[]): { live: Project[]; archived: Project[] } {
	const live: Project[] = [];
	const archived: Project[] = [];
	for (const project of projects) (project.archived_at === null ? live : archived).push(project);
	return { live, archived };
}

/**
 * The project a URL filter names, by id or by name — the API accepts either,
 * so a stale link can name an archived project in either form.
 */
export function findProject(projects: Project[], ref: string | null | undefined): Project | null {
	if (!ref) return null;
	return projects.find((p) => p.id === ref || p.name === ref) ?? null;
}
