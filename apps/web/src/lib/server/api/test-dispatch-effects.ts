import type { DispatchEffects } from '$lib/server/dispatch-effects';

/** Explicit no-op for tests whose behavior is unrelated to dispatch signaling. */
export const TEST_NOOP_DISPATCH_EFFECTS: DispatchEffects = {
	signalDispatch() {}
};
