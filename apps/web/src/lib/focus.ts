import type { Project } from '@tines/shared';

/**
 * The project New issue opens with: the focus, else the last project focused
 * or created in, else the only live project. Never guess among multiple projects.
 */
export function defaultProjectId(
	projects: Project[],
	focusId: string | null | undefined,
	lastProjectId: string | null | undefined
): string {
	const known = (id: string | null | undefined) =>
		id && projects.some((project) => project.id === id) ? id : null;
	return known(focusId) ?? known(lastProjectId) ?? (projects.length === 1 ? projects[0].id : '');
}

/** Resolve an optimistic hint against the layout's current live project inventory. */
export function resolveClientFocus(
	hint: Project | null | undefined,
	serverFocus: Project | null,
	liveProjects: readonly Project[]
): Project | null {
	if (hint === undefined) return serverFocus;
	if (hint === null) return null;
	return liveProjects.find((project) => project.id === hint.id) ?? serverFocus;
}

/** Tracks focus writes without exposing their failures as unhandled rejections. */
export class FocusOperations {
	private operations = new Set<Promise<void>>();

	get pending(): boolean {
		return this.operations.size > 0;
	}

	track(operation: Promise<unknown>): void {
		const settlement = operation.then(
			() => {},
			() => {}
		);
		this.operations.add(settlement);
		void settlement.then(() => this.operations.delete(settlement));
	}

	/** Wait for everything pending now, including work registered while waiting. */
	async settled(): Promise<void> {
		while (this.operations.size > 0) {
			await Promise.all([...this.operations]);
		}
	}

	/** A finite predecessor snapshot, used before registering an ordered successor. */
	predecessor(): Promise<void> {
		return Promise.all([...this.operations]).then(() => {});
	}
}
