export interface DispatchEffects {
	signalDispatch(): void;
	/**
	 * Also dispatch for another account's fleet once the request finishes: a
	 * project member's decision can make the owner's issue runnable, and only
	 * the owner's agents are admitted in a shared project.
	 */
	signalDispatchFor?(userId: string): void;
}
