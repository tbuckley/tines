// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type {
	AnalyticsEngineDataset,
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
	const __TINES_DEPLOYMENT__: Readonly<import('@tines/shared').VersionResponse>;
	/** True only in preview and e2e builds; gates /api/preview-login (lib/server/preview-login.ts). */
	const __TINES_PREVIEW_LOGIN__: boolean;
	/** Bindings and vars available on `platform.env` (see wrangler.jsonc). */
	interface Env {
		DB: D1Database;
		/** Artifact file storage (wrangler.jsonc `r2_buckets`); see lib/server/artifact-store.ts. */
		ARTIFACTS?: R2Bucket;
		/** Full run-log storage (wrangler.jsonc `r2_buckets`); see lib/server/run-log-store.ts. */
		RUN_LOGS?: R2Bucket;
		/** Real-user latency telemetry (wrangler.jsonc `analytics_engine_datasets`); see lib/server/telemetry.ts. */
		PERF?: AnalyticsEngineDataset;
		EMAIL?: SendEmail;
		EMAIL_FROM?: string;
		BETTER_AUTH_URL?: string;
		BETTER_AUTH_SECRET?: string;
		/** Preview worker secret only: bearer token for /api/preview-login (docs/preview-login.md). */
		PREVIEW_LOGIN_TOKEN?: string;
		GOOGLE_CLIENT_ID?: string;
		GOOGLE_CLIENT_SECRET?: string;
		/** Encrypts stored provider secrets (AES-GCM); see lib/server/crypto.ts. */
		SECRET_ENCRYPTION_KEY?: string;
		/** Local scale harness only: logs one marker per executed Kysely query. */
		USAGE_SCALE_SQL_TRACE?: string;
		/** Local stats profiler only: reproduces the pre-optimization marker loop. */
		STATS_SCALE_REPEAT_PREPARATION?: string;
		/** Isolated Worker-entry response probes; set only by e2e/server.sh. */
		E2E_PUBLICATION_BOUNDARY_TEST?: string;
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
		 * Release flag for shared execution guidance (Tines/752): `on` enables
		 * owner guidance inclusion and the shared projection. Unset in
		 * production and preview; see lib/server/api/shared-execution.ts.
		 */
		SHARED_EXECUTION?: string;
		/**
		 * Public base URL managed runs use to reach the API (self-seeding
		 * prompts, the agent's TINES_API_URL). Falls back to BETTER_AUTH_URL.
		 */
		TINES_PUBLIC_URL?: string;
		/** Creation gate for immutable public workflow snapshots. Defaults off. */
		PUBLIC_WORKFLOW_PUBLISHING_ENABLED?: string;
		PUBLIC_WORKFLOW_MAX_BYTES?: string;
		PUBLIC_WORKFLOW_DAILY_QUOTA?: string;
		PUBLIC_WORKFLOW_MODERATOR_USER_IDS?: string;
		PUBLIC_WORKFLOW_REPORT_HOURLY_QUOTA?: string;
		PUBLIC_WORKFLOW_REPORT_HMAC_SECRET?: string;
		PUBLIC_WORKFLOW_APPEAL_CONTACT?: string;
		PUBLIC_WORKFLOW_MODERATION_QUEUE_READY?: string;
		PUBLIC_WORKFLOW_MODERATION_JOURNEY_VERIFIED?: string;
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
