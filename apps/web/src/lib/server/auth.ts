import { getRequestEvent } from '$app/server';
import { betterAuth } from 'better-auth';
import { magicLink } from 'better-auth/plugins';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { D1Dialect } from 'kysely-d1';

/** Minutes until a magic link expires; also quoted in the email body. */
const MAGIC_LINK_EXPIRY_MINUTES = 10;

async function sendMagicLinkEmail(env: Env, email: string, url: string) {
	if (!env.EMAIL || !env.EMAIL_FROM) {
		throw new Error('Email sending is not configured (EMAIL binding / EMAIL_FROM var missing)');
	}
	await env.EMAIL.send({
		to: email,
		from: { email: env.EMAIL_FROM, name: 'Tines' },
		subject: 'Sign in to Tines',
		text: `Sign in to Tines by opening this link:\n\n${url}\n\nThe link expires in ${MAGIC_LINK_EXPIRY_MINUTES} minutes. If you didn't request it, you can ignore this email.`,
		html: `<div style="font-family: system-ui, -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
	<h1 style="font-size: 20px; margin: 0 0 12px;">Sign in to Tines</h1>
	<p style="margin: 0 0 20px; color: #444;">Click the button below to sign in. The link expires in ${MAGIC_LINK_EXPIRY_MINUTES} minutes.</p>
	<p style="margin: 0 0 20px;"><a href="${url}" style="display: inline-block; background: #18181b; color: #fff; text-decoration: none; padding: 10px 18px; border-radius: 8px;">Sign in</a></p>
	<p style="margin: 0; color: #888; font-size: 13px;">If the button doesn't work, paste this link into your browser:<br><a href="${url}" style="color: #888;">${url}</a></p>
	<p style="margin: 12px 0 0; color: #888; font-size: 13px;">If you didn't request this email, you can safely ignore it.</p>
</div>`
	});
}

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
		plugins: [
			magicLink({
				expiresIn: MAGIC_LINK_EXPIRY_MINUTES * 60,
				storeToken: 'hashed',
				sendMagicLink: async ({ email, url }) => {
					await sendMagicLinkEmail(env, email, url);
				}
			}),
			// Per better-auth docs, sveltekitCookies must be the last plugin.
			sveltekitCookies(getRequestEvent)
		]
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
