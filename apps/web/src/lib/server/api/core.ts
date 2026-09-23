import type { D1Result } from '@cloudflare/workers-types';
import {
	FULL_API_KEY_PERMISSIONS,
	parseApiKeyPermissions,
	type ApiErrorBody,
	type ApiKeyPermissions,
	type ArchivedFilter
} from '@tines/shared';
import { json, type RequestEvent } from '@sveltejs/kit';
import type { CompiledQuery } from 'kysely';
import { sha256Hex } from '$lib/server/crypto';
import { getDb } from '$lib/server/db';
import type { DispatchEffects } from '$lib/server/dispatch-effects';

interface DispatchCollector {
	ownerId?: string;
	pending: boolean;
	closed: boolean;
	effects?: DispatchEffects;
}

const dispatchCollectors = new WeakMap<RequestEvent, DispatchCollector>();

export function requestDispatchEffects(
	event: RequestEvent,
	authenticatedUserId: string
): DispatchEffects {
	const collector = dispatchCollectors.get(event);
	if (!collector) throw new Error('Dispatch effects requested outside api()');
	if (collector.ownerId !== undefined && collector.ownerId !== authenticatedUserId) {
		throw new Error('Dispatch effects owner mismatch');
	}
	collector.ownerId = authenticatedUserId;
	return (collector.effects ??= {
		signalDispatch() {
			if (!collector.closed) collector.pending = true;
		}
	});
}

async function drainDispatchEffects(
	event: RequestEvent,
	collector: DispatchCollector
): Promise<void> {
	collector.closed = true;
	dispatchCollectors.delete(event);
	if (!collector.pending || !collector.ownerId) return;
	try {
		const { queueDispatchPass } = await import('$lib/server/supervisor/engine');
		queueDispatchPass(event.platform, collector.ownerId);
	} catch (error) {
		console.error('Failed to schedule dispatch pass:', error);
	}
}

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
		const collector: DispatchCollector = { pending: false, closed: false };
		dispatchCollectors.set(event, collector);
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
		} finally {
			await drainDispatchEffects(event, collector);
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
	/** A Bearer header must never borrow a coincident browser session's consent authority. */
	bearerPresent?: boolean;
	/** Set when the key is a run key (bound to an agent run). */
	agentRunId?: string | null;
	/** Required on request actors. Optional only for legacy session test fixtures. */
	permissions?: ApiKeyPermissions;
	runRestriction?: {
		policy: 'run-v1';
		runId: string;
		issueId: string;
		projectId: string;
		launchStateId: string;
	} | null;
}

/** Full owner authority for trusted browser-session entry points. */
export function sessionActor(user: { id: string; name?: string }): ActorContext {
	return {
		userId: user.id,
		userName: user.name ?? '',
		apiKeyId: null,
		apiKeyName: null,
		viaSession: true,
		permissions: FULL_API_KEY_PERMISSIONS,
		runRestriction: null
	};
}

/**
 * Compatibility error for the remaining semantic run-key guards. New
 * authorization is operation-based in permissions.ts, never route-based.
 */
export function runKeyForbidden(details?: Record<string, unknown>): ApiFail {
	return new ApiFail(
		403,
		'run_key_forbidden',
		'Run keys cannot modify runners, routing rules, supervisor settings, parked issues, issue pins, or API keys, ' +
			'cannot create, edit or delete env context items, ' +
			'cannot import a library or install a workflow package, cannot archive or unarchive projects, cannot create, rename, or delete ' +
			'labels, and cannot apply or remove a label a routing rule is scoped to (reading the library and ' +
			'applying other existing labels is fine). ' +
			'Propose the change instead: file an issue titled "Context change: <scope label>" describing ' +
			'what should change and why; a human reviews and applies it.',
		details
	);
}

export async function requireActor(event: RequestEvent): Promise<ActorContext> {
	const header = event.request.headers.get('authorization');
	const key = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
	// An Authorization header is an explicit credential choice. Never let a
	// malformed or unsupported bearer fall through to the browser session:
	// doing so turns a failed API-key request into a successful owner request.
	if (header === null && event.locals.user) {
		return sessionActor(event.locals.user);
	}

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
		.leftJoin('agent_run as run', 'run.id', 'api_key.agent_run_id')
		.leftJoin('issue as run_issue', 'run_issue.id', 'run.issue_id')
		.select([
			'api_key.id',
			'api_key.user_id',
			'api_key.name',
			'api_key.agent_run_id',
			'api_key.expires_at',
			'api_key.permissions',
			'run.status as run_status',
			'run.api_key_id as run_api_key_id',
			'run.issue_id as run_issue_id',
			'run.state_id_at_start as run_launch_state_id',
			'run_issue.project_id as run_project_id',
			'user.name as user_name'
		])
		.where('api_key.key_hash', '=', hash)
		.where('api_key.revoked_at', 'is', null)
		.executeTakeFirst();
	if (!row) {
		throw new ApiFail(401, 'unauthorized', 'Invalid or revoked API key');
	}
	let permissions: ApiKeyPermissions;
	try {
		permissions = parseApiKeyPermissions(JSON.parse(row.permissions));
	} catch {
		throw new ApiFail(401, 'invalid_key_permissions', 'API key permissions are invalid');
	}
	// Expiry is credential validity. Operation authorization is semantic and
	// enforced by the service guards; the legacy path fence is not consulted.
	if (row.expires_at !== null && row.expires_at <= Date.now()) {
		throw new ApiFail(
			401,
			'run_key_expired',
			'This run key has expired; the run it belonged to is over'
		);
	}
	let runRestriction: ActorContext['runRestriction'] = null;
	if (row.agent_run_id !== null) {
		if (
			(row.run_status !== 'launching' && row.run_status !== 'running') ||
			row.run_api_key_id !== row.id ||
			!row.run_issue_id ||
			!row.run_project_id ||
			!row.run_launch_state_id
		) {
			throw new ApiFail(401, 'run_key_inactive', 'This run key is no longer active');
		}
		runRestriction = {
			policy: 'run-v1',
			runId: row.agent_run_id,
			issueId: row.run_issue_id,
			projectId: row.run_project_id,
			launchStateId: row.run_launch_state_id
		};
	}

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
		agentRunId: row.agent_run_id,
		permissions,
		runRestriction
	};
}

export { sha256Hex };

/** Everything a route handler needs: scoped db, env, and the acting user. */
export async function apiContext(event: RequestEvent, { sessionOnly = false } = {}) {
	if (!event.platform) throw new ApiFail(500, 'no_platform', 'Platform bindings unavailable');
	const actor = await requireActor(event);
	if (sessionOnly && !actor.viaSession)
		throw new ApiFail(403, 'session_required', 'Sign in with your browser to continue');
	if (
		!['GET', 'HEAD'].includes(event.request.method) &&
		(event.request.headers.get('content-type') ?? '').includes('application/json')
	) {
		const payload = await event.request
			.clone()
			.json()
			.catch(() => null);
		const forbidden = new Set([
			'allow_my_agents',
			'allow_my_agents_future',
			'initial_allow_my_agents',
			'future_allow_my_agents',
			'my_agents',
			'personal_consent',
			'disclosure_version'
		]);
		const hasConsent = (value: unknown): boolean =>
			Array.isArray(value)
				? value.some(hasConsent)
				: value !== null &&
					typeof value === 'object' &&
					Object.entries(value).some(([field, child]) => forbidden.has(field) || hasConsent(child));
		if (hasConsent(payload)) {
			if (!actor.viaSession || actor.bearerPresent)
				throw new ApiFail(
					403,
					'consent_browser_required',
					'Personal agent permission is managed in the browser. No issue or permission change was applied.'
				);
			if (
				!/^\/api\/v1\/(?:projects\/[^/]+\/issues|issues\/[^/]+\/(?:transition|my-consent))$/.test(
					event.url.pathname
				)
			)
				throw new ApiFail(
					422,
					'invalid_field',
					'Personal permission is not accepted by this endpoint; use the issue permission control.'
				);
		}
	}
	return {
		db: getDb(event.platform.env),
		env: event.platform.env,
		actor,
		effects: requestDispatchEffects(event, actor.userId)
	};
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
 * is the maximum (Tines/238). Lives here because both the write path
 * (`workflows.ts`, validating) and the read path (`context.ts`, bounding the
 * chain CTE) need it and must not import each other.
 */
export const MAX_INHERITANCE_CHAIN = 3;
