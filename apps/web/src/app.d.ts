// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type {
	CacheStorage,
	D1Database,
	ExecutionContext,
	IncomingRequestCfProperties
} from '@cloudflare/workers-types';
import type { getAuth } from '$lib/server/auth';

declare global {
	/** Bindings and vars available on `platform.env` (see wrangler.jsonc). */
	interface Env {
		DB: D1Database;
		BETTER_AUTH_URL?: string;
		BETTER_AUTH_SECRET?: string;
		GOOGLE_CLIENT_ID?: string;
		GOOGLE_CLIENT_SECRET?: string;
	}

	namespace App {
		// interface Error {}
		interface Locals {
			auth: ReturnType<typeof getAuth>;
			user: import('better-auth').User | null;
			session: import('better-auth').Session | null;
		}
		// interface PageData {}
		// interface PageState {}
		interface Platform {
			env: Env;
			cf?: IncomingRequestCfProperties;
			ctx: ExecutionContext;
			caches?: CacheStorage;
		}
	}
}

export {};
