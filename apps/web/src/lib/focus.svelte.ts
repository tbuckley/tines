/**
 * The focus the client has just set, before the layout's data catches up
 * (Tines/259).
 *
 * Opening a project page focuses it, and the chrome has to say so at once.
 * Doing that with `invalidate('app:preferences')` costs a load rerun that
 * *cancels a link click landing in its window* — a tab tapped right after the
 * project page settles did nothing. The write is optimistic instead: the
 * chrome reads this hint, the PATCH lands behind it, and every page load
 * already reads the focus from the server for itself.
 */
import type { Project } from '@tines/shared';

class FocusHint {
	/** `undefined` = no hint, so the layout's own data answers. */
	project = $state<Project | null | undefined>(undefined);

	set(project: Project | null): void {
		this.project = project;
	}

	clear(): void {
		this.project = undefined;
	}
}

export const focusHint = new FocusHint();
