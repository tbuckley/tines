import { building } from '$app/environment';
import { getAuth } from '$lib/server/auth';
import type { Handle, RequestEvent } from '@sveltejs/kit';
import { svelteKitHandler } from 'better-auth/svelte-kit';

const FORM_CONTENT_TYPES = new Set([
	'application/x-www-form-urlencoded',
	'multipart/form-data',
	'text/plain'
]);

/**
 * CSRF guard replacing Kit's built-in checkOrigin (disabled in
 * vite.config.ts, where the rationale lives): the same
 * form-content-type-mutation origin check, scoped to requests that carry
 * cookies. A cookie-authenticated browser is the only surface a cross-site
 * form submission can ride — bearer-key clients set their own Authorization
 * header, which an attacker's page cannot forge cross-site without a
 * CORS preflight — and those clients (the CLI, agents) legitimately send
 * multipart artifact-folder uploads with no Origin header at all.
 */
function crossSiteFormSubmission(event: RequestEvent): boolean {
	const { request, url } = event;
	if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return false;
	const contentType = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
	if (!FORM_CONTENT_TYPES.has(contentType)) return false;
	if (!request.headers.get('cookie')) return false;
	return request.headers.get('origin') !== url.origin;
}

/**
 * Bearer-authenticated API traffic (the CLI, agent runners) never reads
 * `locals.user` — `requireActor()` takes its bearer branch when the user is
 * null and hashes the key itself. Resolving a cookie session for those
 * requests was pure overhead, so skip it.
 *
 * The skip must not change auth outcomes, only cost, so it applies exactly
 * when the session could not have won anyway:
 * - The header must carry a key `requireActor()` would actually extract
 *   (its `/^Bearer\s+(.+)$/` + trim); a malformed or empty Bearer value
 *   falls through to the session, as it always did.
 * - The request must carry no cookies: `requireActor()` prefers
 *   `locals.user` over the key, and skipping the session for a
 *   cookie-carrying request would silently flip that precedence (401 on a
 *   bad key, 403 on session-only endpoints despite a good one). Bearer
 *   clients send no cookies, so the fast path still covers all real
 *   bearer traffic.
 */
function usesBearerAuth(event: RequestEvent): boolean {
	if (!event.url.pathname.startsWith('/api/v1/')) return false;
	if (!/^Bearer\s+\S/i.test(event.request.headers.get('authorization') ?? '')) return false;
	return !event.request.headers.get('cookie');
}

export const handle: Handle = async ({ event, resolve }) => {
	if (building || !event.platform) {
		return resolve(event);
	}
	if (crossSiteFormSubmission(event)) {
		return new Response('Cross-site form submissions are forbidden', { status: 403 });
	}

	const startedAt = performance.now();
	const auth = getAuth(event.platform.env, event.url.origin);
	event.locals.auth = auth;

	let authMs = 0;
	if (usesBearerAuth(event)) {
		event.locals.user = null;
		event.locals.session = null;
	} else {
		const authStartedAt = performance.now();
		const sessionData = await auth.api.getSession({ headers: event.request.headers });
		authMs = performance.now() - authStartedAt;
		event.locals.user = sessionData?.user ?? null;
		event.locals.session = sessionData?.session ?? null;
	}

	// Mounts the Better Auth handler at /api/auth/* and passes everything else through.
	const response = await svelteKitHandler({ event, resolve, auth, building });

	// Server-Timing: per-request server cost, readable in DevTools -> Network
	// on any deployment. This is the production counterpart to the modelled
	// `pnpm perf:nav` probe — see docs/PERFORMANCE.md.
	try {
		response.headers.append(
			'Server-Timing',
			`auth;dur=${authMs.toFixed(1)}, app;dur=${(performance.now() - startedAt).toFixed(1)}`
		);
	} catch {
		// Immutable headers (e.g. a redirect Response built by Kit internals).
	}
	return response;
};
