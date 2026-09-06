import { createHmac } from 'node:crypto';
import type {
	APIRequestContext,
	APIResponse,
	BrowserContext,
	Page,
	Response
} from '@playwright/test';
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

/**
 * `page.goto` that returns once the page has hydrated, for a spec that is
 * about to click, fill or otherwise interact. The markup is server-rendered
 * but its listeners are not: a click or `change` dispatched before
 * SvelteKit's client has attached them is simply lost, and a spec that
 * retried it sat out the inner assertion's timeout (5 s by default) before
 * the second attempt landed. Network idle is the signal: the module scripts
 * are the last thing a fresh page fetches and hydration runs as they land, so
 * 500 ms of silence after them means the listeners are up. The retry
 * wrappers around first clicks (`clickUntil` and friends) still hold as a
 * belt to this brace; with this they pass first time.
 *
 * That half-second is the price, paid on every call, so a page that is only
 * read (assertions auto-retry and need no listeners) stays on a bare
 * `page.goto`.
 */
export function gotoHydrated(page: Page, url: string): Promise<Response | null> {
	return page.goto(url, { waitUntil: 'networkidle' });
}

/** Minimal bearer-auth API client over Playwright's request context. */
export function apiClient(request: APIRequestContext, apiKey: string) {
	const headers = { authorization: `Bearer ${apiKey}` };
	return {
		get: (path: string) => request.get(path, { headers }),
		post: (path: string, data?: unknown) => request.post(path, { headers, data }),
		put: (path: string, data?: unknown) => request.put(path, { headers, data }),
		patch: (path: string, data?: unknown) => request.patch(path, { headers, data }),
		// `data` for the endpoints whose body carries an option rather than a
		// payload — `DELETE /labels/:id` with `{ force: true }`.
		delete: (path: string, data?: unknown) => request.delete(path, { headers, data })
	};
}

/** The envelope every `/api/v1` failure carries (the server's `ApiErrorBody`). */
export type ErrorBody = {
	error: { code: string; message: string; details?: Record<string, unknown> };
};

/** Enough of a failed response to name it: status, URL, and the server's own reason. */
async function describeFailure(res: APIResponse): Promise<string> {
	const text = await res.text();
	let detail = text.length > 500 ? `${text.slice(0, 500)}… (${text.length} bytes)` : text;
	try {
		const { error } = JSON.parse(text) as Partial<ErrorBody>;
		if (error?.code) {
			detail = `${error.code}: ${error.message}`;
			if (error.details) detail += ` ${JSON.stringify(error.details)}`;
		}
	} catch {
		// Not JSON — a Kit HTML error page or a bare-text 405. Show the raw body.
	}
	return `${res.status()} ${res.statusText()} from ${res.url()} — ${detail}`;
}

/**
 * Reads a successful JSON response, throwing on any non-2xx.
 *
 * Fixtures are seeded through this in `beforeAll`, and before the check a
 * create that 4xx'd returned the *error envelope* typed as the created
 * object: the spec then ran against undefined ids and failed much later with
 * an assertion naming neither the request nor the reason. Raising the
 * server's own code and message at the call that failed turns a three-round
 * CI hunt into one line.
 *
 * Use `errorBody()` for a response the spec expects to fail.
 */
export async function body<T = Record<string, unknown>>(res: APIResponse): Promise<T> {
	if (!res.ok()) throw new Error(await describeFailure(res));
	return (await res.json()) as T;
}

/**
 * The counterpart for a response a spec asserts *is* an error: returns the
 * envelope, and throws if the request unexpectedly succeeded — otherwise a
 * `.error.code` assertion on a 200 compares `undefined` and reports the
 * absence of an error as the wrong error.
 */
export async function errorBody(res: APIResponse): Promise<ErrorBody> {
	if (res.ok()) {
		const text = await res.text();
		throw new Error(
			`Expected an error from ${res.url()}, got ${res.status()} — ` +
				(text.length > 200 ? `${text.slice(0, 200)}…` : text)
		);
	}
	return (await res.json()) as ErrorBody;
}

/** Unique per-process suffix so re-runs against a reused server don't collide. */
export const runId = Date.now().toString(36);
