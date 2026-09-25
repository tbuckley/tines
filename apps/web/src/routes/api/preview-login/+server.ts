import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	PREVIEW_LOGIN_USER,
	PREVIEW_SESSION_TTL_MS,
	checkPreviewLogin,
	signSessionToken
} from '$lib/server/preview-login';

/**
 * POST /api/preview-login — preview deployments only; see
 * lib/server/preview-login.ts for the gates and docs/preview-login.md for use.
 * Sets the session cookie and also returns it, so a Playwright script can
 * plant it in a browser context.
 */
export const POST: RequestHandler = async ({ request, url, platform, locals, cookies }) => {
	const env = platform?.env;
	const verdict = await checkPreviewLogin({
		enabledInBuild: __TINES_PREVIEW_LOGIN__,
		configuredToken: env?.PREVIEW_LOGIN_TOKEN,
		authorization: request.headers.get('authorization'),
		hostname: url.hostname
	});
	if (verdict === 'disabled' || !env?.BETTER_AUTH_SECRET) {
		return new Response('Not found', { status: 404 });
	}
	if (verdict === 'denied') return json({ error: 'invalid preview login token' }, { status: 401 });

	const ctx = await locals.auth.$context;
	const found = await ctx.internalAdapter.findUserByEmail(PREVIEW_LOGIN_USER.email);
	const user =
		found?.user ??
		(await ctx.internalAdapter.createUser(
			{ email: PREVIEW_LOGIN_USER.email, name: PREVIEW_LOGIN_USER.name, emailVerified: true },
			{ method: 'magic-link' }
		));
	const expiresAt = new Date(Date.now() + PREVIEW_SESSION_TTL_MS);
	const session = await ctx.internalAdapter.createSession(user.id, false, { expiresAt });

	const cookie = {
		name: ctx.authCookies.sessionToken.name,
		value: await signSessionToken(session.token, env.BETTER_AUTH_SECRET)
	};
	cookies.set(cookie.name, cookie.value, {
		path: '/',
		httpOnly: true,
		secure: url.protocol === 'https:',
		sameSite: 'lax',
		expires: expiresAt
	});
	return json(
		{
			user: { id: user.id, email: user.email, name: user.name },
			expiresAt: expiresAt.toISOString(),
			cookie
		},
		{ headers: { 'cache-control': 'no-store' } }
	);
};
