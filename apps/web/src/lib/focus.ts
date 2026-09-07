/**
 * The project focus, as the browser sees it (Tines/259). The focus itself
 * lives on the app layout's data; this is the one rule that reads across it.
 */
import type { Project } from '@tines/shared';

/**
 * The project New issue opens with: the focus, else the last project focused
 * or created in, else — only when there is exactly one project, which behaves
 * as the focus — that one. `''` otherwise: under "All projects" with nothing
 * to fall back to, the select starts empty and required rather than guessing
 * at `projects[0]`.
 */
export function defaultProjectId(
	projects: Project[],
	focusId: string | null | undefined,
	lastProjectId: string | null | undefined
): string {
	const known = (id: string | null | undefined) =>
		id && projects.some((p) => p.id === id) ? id : null;
	return known(focusId) ?? known(lastProjectId) ?? (projects.length === 1 ? projects[0].id : '');
}
