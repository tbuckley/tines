import { createApiClient } from '@tines/shared';

/**
 * Browser-side client for the app's own API. Relative base URL: same-origin
 * fetch carries the Better Auth session cookie, so mutations from the UI go
 * through exactly the same HTTP API agents use.
 */
export const api = createApiClient({ baseUrl: '' });
