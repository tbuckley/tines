import type { D1Result } from '@cloudflare/workers-types';
import type { ApiErrorBody, ArchivedFilter } from '@tines/shared';
import { json, type RequestEvent } from '@sveltejs/kit';
import type { CompiledQuery } from 'kysely';
import { sha256Hex } from '$lib/server/crypto';
import { getDb } from '$lib/server/db';

/** Thrown by handlers/services; converted to a structured error response. */
export class ApiFail extends Error {
	constructor(
		public status: number,
		public code: string,
		message: string,
		public details?: Record<string, unknown>
	) {
		super(message);
		this.name = 'ApiFail';
	}
}

export const notFound = () => new ApiFail(404, 'not_found', 'Not found');

export function errorResponse(e: ApiFail): Response {
	const body: ApiErrorBody = {
		error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) }
	};
	return json(body, { status: e.status });
}

/**
 * SvelteKit answers a known route with an unsupported verb itself, before any
 * handler runs: a bare text body ("PUT method not allowed") with no
 * content-type. A JSON client that reads `(await res.json()).error` on every
 * non-2xx then dies on a parse error instead of surfacing the reason, so the
 * hook re-clothes that response in the documented envelope. Kit's `Allow`
 * header is already correct (RFC 9110 15.5.6) and is carried over.
 *
 * Scoped to /api/v1/*: only the JSON API promises the envelope. A 405 a
 * handler produced itself already carries a JSON content-type and is left
 * alone.
 */
export function jsonifyMethodNotAllowed(
	pathname: string,
	method: string,
	response: Response
): Response {
	if (response.status !== 405) return response;
	if (!pathname.startsWith('/api/v1/')) return response;
	if ((response.headers.get('content-type') ?? '').includes('application/json')) return response;

	const replacement = errorResponse(
		new ApiFail(405, 'method_not_allowed', `${method} is not allowed on this resource`)
	);
	const allow = response.headers.get('allow');
	if (allow) replacement.headers.set('allow', allow);
	return replacement;
}

/** Wraps a route handler: ApiFail → structured JSON error, else 500. */
export function api<E extends RequestEvent>(
	handler: (event: E) => Promise<Response> | Response
): (event: E) => Promise<Response> {
	return async (event) => {
		try {
			return await handler(event);
		} catch (e) {
			if (e instanceof ApiFail) return errorResponse(e);
			// Unique-index violations are the DB backstop behind app-level
			// duplicate checks; a concurrent write can slip past the check and
			// land here. Surface it as a conflict, not a server error.
			if (e instanceof Error && e.message.includes('UNIQUE constraint failed')) {
				return errorResponse(
					new ApiFail(409, 'conflict', 'A concurrent write created a conflicting record; retry')
				);
			}
			console.error('API error:', e);
			return errorResponse(new ApiFail(500, 'internal', 'Internal error'));
		}
	};
}

/** Valid JSON that isn't an object ("null", "[]", "42") would otherwise
 * pass the parse and crash on the first field access — a 500 for what is
 * malformed client input. Every endpoint takes an object payload. */
export function requireJsonObject(value: unknown): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new ApiFail(400, 'invalid_json', 'Request body must be a JSON object');
	}
	return value as Record<string, unknown>;
}

export async function readJson<T>(event: RequestEvent): Promise<T> {
	let parsed: unknown;
	try {
		parsed = await event.request.json();
	} catch {
		throw new ApiFail(400, 'invalid_json', 'Request body must be valid JSON');
	}
	return requireJsonObject(parsed) as T;
}

/** Like readJson, but an absent/empty body is fine (e.g. DELETE options). */
export async function readOptionalJson<T extends object>(event: RequestEvent): Promise<Partial<T>> {
	const text = await event.request.text();
	if (text.trim() === '') return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new ApiFail(400, 'invalid_json', 'Request body must be valid JSON');
	}
	return requireJsonObject(parsed) as Partial<T>;
}

export function requireString(value: unknown, field: string, { max = 10_000 } = {}): string {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new ApiFail(422, 'invalid_field', `"${field}" must be a non-empty string`, { field });
	}
	if (value.length > max) {
		throw new ApiFail(422, 'invalid_field', `"${field}" must be at most ${max} characters`, {
			field
		});
	}
	return value;
}

export function optionalString(
	value: unknown,
	field: string,
	{ max = 100_000 } = {}
): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'string') {
		throw new ApiFail(422, 'invalid_field', `"${field}" must be a string`, { field });
	}
	if (value.length > max) {
		throw new ApiFail(422, 'invalid_field', `"${field}" must be at most ${max} characters`, {
			field
		});
	}
	return value;
}

// ---------------------------------------------------------------------------
// Auth: resolve the acting user from a session cookie or a bearer API key.

export interface ActorContext {
	userId: string;
	userName: string;
	/** NULL when acting via a browser session. */
	apiKeyId: string | null;
	apiKeyName: string | null;
	viaSession: boolean;
	/** Set when the key is a run key (bound to an agent run). */
	agentRunId?: string | null;
}

// ---------------------------------------------------------------------------
// Run keys: api_key rows with agent_run_id set. They carry issue-action
// authority but are fenced off the control plane — an agent must not be able
// to raise its own budget, un-park itself, re-route work, or touch
// credentials. Ordinary named keys keep their full authority.
//
// The fence is per method, not per path: a surface an agent must *understand*
// to do its job can be readable while its writes stay fenced (the label
// library is the one such surface today).

/**
 * A fenced surface. Every method is fenced unless `readable` is set, in which
 * case GET/HEAD pass: reading is classification, writing is control.
 */
type ControlPlaneRule = { pattern: RegExp; readable?: boolean };

const CONTROL_PLANE_RULES: ControlPlaneRule[] = [
	// The fleet's shape is legible to a run (Tines/256): an agent already reads
	// its own dispatch explainer, which names runners, their status and their
	// caps, so the fleet reads behind `tines supervisor status` disclose nothing
	// new. Only the GETs open — `register`, `rotate-token` and the PATCH/DELETE
	// writes stay fenced (`poll` is runner-token auth, never a run key), and the
	// settings GET nulls `github_pat_hint` for run keys.
	{ pattern: /^\/api\/v1\/runners(\/|$)/, readable: true },
	{ pattern: /^\/api\/v1\/routing-rules(\/|$)/ },
	{ pattern: /^\/api\/v1\/supervisor\/settings(\/|$)/, readable: true },
	{ pattern: /^\/api\/v1\/issues\/[^/]+\/resume$/ },
	{ pattern: /^\/api\/v1\/api-keys(\/|$)/ },
	// The label library is vocabulary, not classification: run keys may read it
	// (`tines labels list` — the launch prompt points at it) and may apply and
	// remove existing labels (/issues/:id/labels stays open to them), but
	// cannot mint, rename, or delete the terms themselves.
	{ pattern: /^\/api\/v1\/labels(\/|$)/, readable: true },
	// Bulk library writes: an agent must propose context changes, not apply
	// a whole library over the top of them.
	{ pattern: /^\/api\/v1\/import(\/|$)/ },
	// Archiving is an operator act: an agent must not freeze (or thaw) the
	// project it is working in, least of all the one draining around it.
	{ pattern: /^\/api\/v1\/projects\/[^/]+\/(archive|unarchive)$/ },
	// Per-user UI preferences (the project focus): an agent has no focus of its
	// own and must not read or move its owner's. GET is fenced too.
	{ pattern: /^\/api\/v1\/preferences(\/|$)/ }
];

/** SvelteKit answers HEAD from the GET handler, so both are reads. */
const READ_METHODS = new Set(['GET', 'HEAD']);

/** True when a run key must not make `method` requests to `pathname`. */
export function isControlPlanePath(pathname: string, method: string): boolean {
	const read = READ_METHODS.has(method.toUpperCase());
	return CONTROL_PLANE_RULES.some((r) => r.pattern.test(pathname) && !(read && r.readable));
}

/**
 * The fence's 403, shared by the path fence and field-level guards (pins on
 * PATCH /issues/:id live on an otherwise run-key-legal route).
 */
export function runKeyForbidden(details?: Record<string, unknown>): ApiFail {
	return new ApiFail(
		403,
		'run_key_forbidden',
		'Run keys cannot modify runners, routing rules, supervisor settings, parked issues, issue pins, or API keys, ' +
			'cannot import a library, cannot archive or unarchive projects, cannot create, rename, or delete ' +
			'labels, and cannot apply or remove a label a routing rule is scoped to (reading the library and ' +
			'applying other existing labels is fine). ' +
			'Propose the change instead: file an issue titled "Context change: <scope label>" describing ' +
			'what should change and why; a human reviews and applies it.',
		details
	);
}

/**
 * Gate applied to every key-authenticated request: expired run keys are dead
 * (401), and live run keys get 403s on the control plane, pointing at the
 * proposal convention instead.
 */
export function assertRunKeyAllowed(
	key: { agentRunId: string | null; expiresAt: number | null },
	pathname: string,
	method: string,
	now = Date.now()
): void {
	if (key.expiresAt !== null && key.expiresAt <= now) {
		throw new ApiFail(
			401,
			'run_key_expired',
			'This run key has expired; the run it belonged to is over'
		);
	}
	if (key.agentRunId !== null && isControlPlanePath(pathname, method)) {
		throw runKeyForbidden();
	}
}

export async function requireActor(event: RequestEvent): Promise<ActorContext> {
	if (event.locals.user) {
		return {
			userId: event.locals.user.id,
			userName: event.locals.user.name,
			apiKeyId: null,
			apiKeyName: null,
			viaSession: true
		};
	}

	const header = event.request.headers.get('authorization');
	const key = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
	if (!key || !event.platform) {
		throw new ApiFail(
			401,
			'unauthorized',
			'Sign in or pass an API key as "Authorization: Bearer <key>"'
		);
	}

	const db = getDb(event.platform.env);
	const hash = await sha256Hex(key);
	const row = await db
		.selectFrom('api_key')
		.innerJoin('user', 'user.id', 'api_key.user_id')
		.select([
			'api_key.id',
			'api_key.user_id',
			'api_key.name',
			'api_key.agent_run_id',
			'api_key.expires_at',
			'user.name as user_name'
		])
		.where('api_key.key_hash', '=', hash)
		.where('api_key.revoked_at', 'is', null)
		.executeTakeFirst();
	if (!row) {
		throw new ApiFail(401, 'unauthorized', 'Invalid or revoked API key');
	}
	assertRunKeyAllowed(
		{ agentRunId: row.agent_run_id, expiresAt: row.expires_at },
		event.url.pathname,
		event.request.method
	);

	const touch = db
		.updateTable('api_key')
		.set({ last_used_at: Date.now() })
		.where('id', '=', row.id)
		.execute();
	// Don't block the request on the last-used bookkeeping write.
	event.platform.ctx?.waitUntil?.(touch);

	return {
		userId: row.user_id,
		userName: row.user_name,
		apiKeyId: row.id,
		apiKeyName: row.name,
		viaSession: false,
		agentRunId: row.agent_run_id
	};
}

/** API key management requires a browser session, not a key. */
export async function requireSessionActor(event: RequestEvent): Promise<ActorContext> {
	const actor = await requireActor(event);
	if (!actor.viaSession) {
		throw new ApiFail(
			403,
			'session_required',
			'API keys are managed from the web UI (browser session), not with a key'
		);
	}
	return actor;
}

export { sha256Hex };

/** Everything a route handler needs: scoped db, env, and the acting user. */
export async function apiContext(event: RequestEvent, { sessionOnly = false } = {}) {
	if (!event.platform) throw new ApiFail(500, 'no_platform', 'Platform bindings unavailable');
	const actor = sessionOnly ? await requireSessionActor(event) : await requireActor(event);
	return { db: getDb(event.platform.env), env: event.platform.env, actor };
}

/**
 * `?archived=` on the four lists that hide archived projects by default.
 * Absent means `'false'` — the default every list shares.
 */
export function readArchived(params: URLSearchParams): ArchivedFilter {
	const raw = params.get('archived');
	if (raw === null || raw === '') return 'false';
	if (raw === 'true' || raw === 'false' || raw === 'all') return raw;
	throw new ApiFail(422, 'invalid_field', '"archived" must be one of true, false, all', {
		field: 'archived'
	});
}

// ---------------------------------------------------------------------------
// Cursor pagination (newest first): cursor encodes (created_at, id).

export interface Page {
	cursor: { createdAt: number; id: string } | null;
	limit: number;
}

export function decodeCursor(rawCursor: string): NonNullable<Page['cursor']> {
	try {
		const decoded = atob(rawCursor.replace(/-/g, '+').replace(/_/g, '/'));
		const sep = decoded.indexOf(':');
		if (sep < 1) throw new Error('bad cursor');
		const createdAt = Number(decoded.slice(0, sep));
		const id = decoded.slice(sep + 1);
		if (!Number.isFinite(createdAt) || !id) throw new Error('bad cursor');
		return { createdAt, id };
	} catch {
		throw new ApiFail(400, 'invalid_cursor', 'Malformed pagination cursor');
	}
}

export function readPage(event: RequestEvent, { defaultLimit = 50, maxLimit = 100 } = {}): Page {
	const rawLimit = event.url.searchParams.get('limit');
	let limit = rawLimit ? Number.parseInt(rawLimit, 10) : defaultLimit;
	if (!Number.isFinite(limit) || limit < 1) limit = defaultLimit;
	limit = Math.min(limit, maxLimit);

	const rawCursor = event.url.searchParams.get('cursor');
	const cursor = rawCursor ? decodeCursor(rawCursor) : null;
	return { cursor, limit };
}

export function encodeCursor(createdAt: number, id: string): string {
	return btoa(`${createdAt}:${id}`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Trims a page of rows (fetched with limit+1) and produces the next cursor.
 */
export function pageResult<T extends { created_at: number; id: string }>(
	rows: T[],
	limit: number
): { items: T[]; next_cursor: string | null } {
	const items = rows.slice(0, limit);
	const last = items[items.length - 1];
	return {
		items,
		next_cursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null
	};
}

// ---------------------------------------------------------------------------
// Atomic multi-statement writes. kysely-d1 has no transactions; D1's `batch`
// runs statements in one implicit transaction, so mutations and the events
// that describe them are committed together.

/**
 * Returns one result per statement so callers can check `meta.changes` on
 * guarded writes (e.g. the transition compare-and-swap).
 */
export async function runAtomic(env: Env, queries: CompiledQuery[]): Promise<D1Result[]> {
	if (queries.length === 0) return [];
	return env.DB.batch(
		queries.map((q) => env.DB.prepare(q.sql).bind(...(q.parameters as unknown[])))
	);
}

/**
 * Longest legal state-inheritance chain, counting the state itself: A → B → C
 * is the maximum (Tines/238). Defined in `@tines/shared` so the client-side
 * depth warnings agree with the write path's validation, and re-exported here
 * because both the write path (`workflows.ts`) and the read path
 * (`context.ts`, bounding the chain CTE) already import from this module.
 */
export { MAX_INHERITANCE_CHAIN } from '@tines/shared';
