import type { D1Result } from '@cloudflare/workers-types';
import type { ApiErrorBody } from '@tines/shared';
import { json, type RequestEvent } from '@sveltejs/kit';
import type { CompiledQuery } from 'kysely';
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
function requireJsonObject(value: unknown): Record<string, unknown> {
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

export function optionalString(value: unknown, field: string, { max = 100_000 } = {}): string | undefined {
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

const CONTROL_PLANE_PATTERNS = [
	/^\/api\/v1\/runners(\/|$)/,
	/^\/api\/v1\/routing-rules(\/|$)/,
	/^\/api\/v1\/supervisor\/settings(\/|$)/,
	/^\/api\/v1\/issues\/[^/]+\/resume$/,
	/^\/api\/v1\/api-keys(\/|$)/
];

/** True for paths a run key must never reach (all methods). */
export function isControlPlanePath(pathname: string): boolean {
	return CONTROL_PLANE_PATTERNS.some((p) => p.test(pathname));
}

/**
 * Gate applied to every key-authenticated request: expired run keys are dead
 * (401), and live run keys get 403s on the control plane, pointing at the
 * proposal convention instead.
 */
export function assertRunKeyAllowed(
	key: { agentRunId: string | null; expiresAt: number | null },
	pathname: string,
	now = Date.now()
): void {
	if (key.expiresAt !== null && key.expiresAt <= now) {
		throw new ApiFail(401, 'run_key_expired', 'This run key has expired; the run it belonged to is over');
	}
	if (key.agentRunId !== null && isControlPlanePath(pathname)) {
		throw new ApiFail(
			403,
			'run_key_forbidden',
			'Run keys cannot modify runners, routing rules, supervisor settings, parked issues, or API keys. ' +
				'Propose the change instead: file an issue titled "Context change: <scope label>" describing ' +
				'what should change and why; a human reviews and applies it.'
		);
	}
}

async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
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
		throw new ApiFail(401, 'unauthorized', 'Sign in or pass an API key as "Authorization: Bearer <key>"');
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
		event.url.pathname
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
		throw new ApiFail(403, 'session_required', 'API keys are managed from the web UI (browser session), not with a key');
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

// ---------------------------------------------------------------------------
// Cursor pagination (newest first): cursor encodes (created_at, id).

export interface Page {
	cursor: { createdAt: number; id: string } | null;
	limit: number;
}

export function readPage(event: RequestEvent, { defaultLimit = 50, maxLimit = 100 } = {}): Page {
	const rawLimit = event.url.searchParams.get('limit');
	let limit = rawLimit ? Number.parseInt(rawLimit, 10) : defaultLimit;
	if (!Number.isFinite(limit) || limit < 1) limit = defaultLimit;
	limit = Math.min(limit, maxLimit);

	const rawCursor = event.url.searchParams.get('cursor');
	let cursor: Page['cursor'] = null;
	if (rawCursor) {
		try {
			const decoded = atob(rawCursor.replace(/-/g, '+').replace(/_/g, '/'));
			const sep = decoded.indexOf(':');
			const createdAt = Number(decoded.slice(0, sep));
			const id = decoded.slice(sep + 1);
			if (!Number.isFinite(createdAt) || !id) throw new Error('bad cursor');
			cursor = { createdAt, id };
		} catch {
			throw new ApiFail(400, 'invalid_cursor', 'Malformed pagination cursor');
		}
	}
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
