// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type {
	CacheStorage,
	D1Database,
	ExecutionContext,
	Fetcher,
	IncomingRequestCfProperties,
	R2Bucket,
	SendEmail
} from '@cloudflare/workers-types';
import type { getAuth } from '$lib/server/auth';

declare global {
	/** Bindings and vars available on `platform.env` (see wrangler.jsonc). */
	interface Env {
		DB: D1Database;
		/** Artifact file storage (wrangler.jsonc `r2_buckets`); see lib/server/artifact-store.ts. */
		ARTIFACTS?: R2Bucket;
		/** Full run-log storage (wrangler.jsonc `r2_buckets`); see lib/server/run-log-store.ts. */
		RUN_LOGS?: R2Bucket;
		EMAIL?: SendEmail;
		EMAIL_FROM?: string;
		BETTER_AUTH_URL?: string;
		BETTER_AUTH_SECRET?: string;
		GOOGLE_CLIENT_ID?: string;
		GOOGLE_CLIENT_SECRET?: string;
		/** Encrypts stored provider secrets (AES-GCM); see lib/server/crypto.ts. */
		SECRET_ENCRYPTION_KEY?: string;
		/** Local scale harness only: logs one marker per executed Kysely query. */
		USAGE_SCALE_SQL_TRACE?: string;
		/** Local stats profiler only: reproduces the pre-optimization marker loop. */
		STATS_SCALE_REPEAT_PREPARATION?: string;
		/**
		 * Self-referencing service binding (wrangler.jsonc `services`): lets
		 * the supervisor call its own API in-process — a worker on a custom
		 * domain cannot `fetch()` its own hostname (522, no origin behind it).
		 */
		SELF?: Fetcher;
		/**
		 * Origin that serves artifact sites (`/s/<token>/…`), e.g.
		 * `https://tines-web.<subdomain>.workers.dev` — a different registrable
		 * domain from the app, so a prototype's JavaScript cannot touch app
		 * cookies. Unset (local dev, e2e, previews) degrades to serving on the
		 * app origin under CSP `sandbox`; see lib/server/artifact-site.ts.
		 */
		ARTIFACT_SANDBOX_ORIGIN?: string;
		/**
		 * Public base URL managed runs use to reach the API (self-seeding
		 * prompts, the agent's TINES_API_URL). Falls back to BETTER_AUTH_URL.
		 */
		TINES_PUBLIC_URL?: string;
	}

	namespace App {
		// interface Error {}
		interface Locals {
			auth: ReturnType<typeof getAuth>;
			user: import('better-auth').User | null;
			session: import('better-auth').Session | null;
		}
		// interface PageData {}
		interface PageState {
			starterLanding?: { projectId: string; firstIssueId: string };
		}
		interface Platform {
			env: Env;
			cf?: IncomingRequestCfProperties;
			ctx: ExecutionContext;
			caches?: CacheStorage;
		}
	}
}

export {};
