import { getRequestEvent } from '$app/server';
import { betterAuth } from 'better-auth';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { D1Dialect } from 'kysely-d1';

let auth: ReturnType<typeof createAuth> | undefined;

function createAuth(env: Env) {
	return betterAuth({
		database: {
			dialect: new D1Dialect({ database: env.DB }),
			type: 'sqlite'
		},
		baseURL: env.BETTER_AUTH_URL,
		secret: env.BETTER_AUTH_SECRET,
		socialProviders:
			env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
				? {
						google: {
							clientId: env.GOOGLE_CLIENT_ID,
							clientSecret: env.GOOGLE_CLIENT_SECRET
						}
					}
				: {},
		plugins: [sveltekitCookies(getRequestEvent)]
	});
}

/**
 * Better Auth instance, memoized per isolate. Bindings on `env` are stable for
 * the lifetime of a Worker isolate (and of the dev server), so this is safe.
 */
export function getAuth(env: Env) {
	auth ??= createAuth(env);
	return auth;
}
