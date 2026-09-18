/**
 * The focus the client has just set, before the layout's data catches up
 * (Tines/259).
 *
 * Opening a project page focuses it, and the chrome has to say so at once.
 * The write is optimistic, while tracked focus operations hold subsequent
 * same-origin reads until the server and chrome agree.
 */
import type { Project } from '@tines/shared';
import { FocusOperations } from './focus';

export class FocusHint {
	/** `undefined` = no hint, so the layout's own data answers. */
	project = $state<Project | null | undefined>(undefined);
	private owner = 0;
	private operations = new FocusOperations();

	set(project: Project | null): number {
		const token = ++this.owner;
		this.project = project;
		return token;
	}

	clear(): void {
		this.owner++;
		this.project = undefined;
	}

	clearIfCurrent(token: number): boolean {
		if (token !== this.owner) return false;
		this.clear();
		return true;
	}

	get pending(): boolean {
		return this.operations.pending;
	}

	track(operation: Promise<unknown>): void {
		this.operations.track(operation);
	}

	settled(): Promise<void> {
		return this.operations.settled();
	}

	predecessor(): Promise<void> {
		return this.operations.predecessor();
	}
}

export const focusHint = new FocusHint();
