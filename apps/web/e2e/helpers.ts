import { createHmac } from 'node:crypto';
import type { APIRequestContext, APIResponse, BrowserContext } from '@playwright/test';
import { AUTH_SECRET, BASE_URL } from './constants.mjs';

/**
 * Better Auth session cookies are `<token>.<base64 HMAC-SHA256(token)>`,
 * signed with the server's auth secret. Recreating that signature lets a
 * browser context act as the seeded session without a Google sign-in.
 */
export function signedSessionCookie(sessionToken: string): string {
	const signature = createHmac('sha256', AUTH_SECRET).update(sessionToken).digest('base64');
	return `${sessionToken}.${signature}`;
}

export async function signIn(context: BrowserContext, sessionToken: string): Promise<void> {
	await context.addCookies([
		{
			name: 'better-auth.session_token',
			value: signedSessionCookie(sessionToken),
			url: BASE_URL,
			httpOnly: true,
			sameSite: 'Lax'
		}
	]);
}

/** Minimal bearer-auth API client over Playwright's request context. */
export function apiClient(request: APIRequestContext, apiKey: string) {
	const headers = { authorization: `Bearer ${apiKey}` };
	return {
		get: (path: string) => request.get(path, { headers }),
		post: (path: string, data?: unknown) => request.post(path, { headers, data }),
		put: (path: string, data?: unknown) => request.put(path, { headers, data }),
		patch: (path: string, data?: unknown) => request.patch(path, { headers, data }),
		delete: (path: string) => request.delete(path, { headers })
	};
}

export async function body<T = Record<string, unknown>>(res: APIResponse): Promise<T> {
	return (await res.json()) as T;
}

/** Unique per-process suffix so re-runs against a reused server don't collide. */
export const runId = Date.now().toString(36);
