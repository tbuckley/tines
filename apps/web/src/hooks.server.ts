import { building } from '$app/environment';
import { getAuth } from '$lib/server/auth';
import type { Handle } from '@sveltejs/kit';
import { svelteKitHandler } from 'better-auth/svelte-kit';

export const handle: Handle = async ({ event, resolve }) => {
	if (building || !event.platform) {
		return resolve(event);
	}

	const auth = getAuth(event.platform.env, event.url.origin);
	event.locals.auth = auth;

	const sessionData = await auth.api.getSession({ headers: event.request.headers });
	event.locals.user = sessionData?.user ?? null;
	event.locals.session = sessionData?.session ?? null;

	// Mounts the Better Auth handler at /api/auth/* and passes everything else through.
	return svelteKitHandler({ event, resolve, auth, building });
};
