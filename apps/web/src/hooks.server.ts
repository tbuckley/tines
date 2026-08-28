import { building } from '$app/environment';
import { getAuth } from '$lib/server/auth';
import type { Handle } from '@sveltejs/kit';
import { svelteKitHandler } from 'better-auth/svelte-kit';

export const handle: Handle = async ({ event, resolve }) => {
	if (building || !event.platform) {
		return resolve(event);
	}

	const start = Date.now();
	const auth = getAuth(event.platform.env, event.url.origin);
	event.locals.auth = auth;

	const sessionData = await auth.api.getSession({ headers: event.request.headers });
	event.locals.user = sessionData?.user ?? null;
	event.locals.session = sessionData?.session ?? null;
	const authMs = Date.now() - start;

	// Mounts the Better Auth handler at /api/auth/* and passes everything else through.
	const response = await svelteKitHandler({ event, resolve, auth, building });

	// Where the request's server time goes (session lookup vs. everything
	// else), visible in the browser devtools Network → Timing tab.
	try {
		response.headers.set('Server-Timing', `auth;dur=${authMs}, total;dur=${Date.now() - start}`);
	} catch {
		// Asset/passthrough responses can have immutable headers.
	}
	return response;
};
