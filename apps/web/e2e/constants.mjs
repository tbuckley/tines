/**
 * Shared constants for the e2e suite. `seed.mjs` (plain node) writes these
 * into the local D1 database before `wrangler dev` starts; the Playwright
 * specs use the same values to authenticate.
 *
 * Everything here is test-only and never touches a real deployment: the
 * server is started with BETTER_AUTH_SECRET below and a throwaway D1 state
 * dir (.wrangler-e2e), recreated on every server start.
 */

export const PORT = Number(process.env.E2E_PORT ?? 8788);
export const BASE_URL = `http://127.0.0.1:${PORT}`;
export const AUTH_SECRET = 'tines-e2e-secret';

export const ALICE = {
	id: 'usr_e2e_alice',
	name: 'Alice E2E',
	email: 'alice@e2e.test',
	apiKey: 'tines_e2ealice0000000000000000000000000000000000',
	apiKeyName: 'alice-key',
	sessionToken: 'e2e-session-alice'
};

export const BOB = {
	id: 'usr_e2e_bob',
	name: 'Bob E2E',
	email: 'bob@e2e.test',
	apiKey: 'tines_e2ebob000000000000000000000000000000000000',
	apiKeyName: 'bob-key',
	sessionToken: 'e2e-session-bob'
};
