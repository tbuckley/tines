import { createApiClient } from '@tines/shared';

/**
 * Browser-side client for the app's own API. Relative base URL: same-origin
 * fetch carries the Better Auth session cookie, so mutations from the UI go
 * through exactly the same HTTP API agents use.
 */
export const api = createApiClient({
	baseUrl: '',
	// Delegate at call time so the client init hook's focus barrier is observed
	// even when this module was evaluated before that hook ran.
	fetch: (input, init) => globalThis.fetch(input, init)
});
