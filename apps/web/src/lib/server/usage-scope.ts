import {
	UsageInputError,
	type CohortStateProof,
	type ResolvedUsageFilters,
	type UsageBy
} from '@tines/shared';

const encoder = new TextEncoder();
const MAX_TOKEN = 8_192;

export type UsageScopePayload =
	| {
			v: 1;
			owner: string;
			mode: 'period';
			from: number;
			to: number;
			timezone: string;
			timezone_source: 'supervisor_budget' | 'utc_fallback';
			filters: ResolvedUsageFilters;
			by: UsageBy;
	  }
	| {
			v: 1;
			owner: string;
			mode: 'issue';
			issue: string;
			cutoff: number;
			timezone: string;
			timezone_source: 'supervisor_budget' | 'utc_fallback';
	  }
	| {
			v: 1;
			owner: string;
			mode: 'cohort';
			from: number;
			to: number;
			timezone: string;
			timezone_source: 'supervisor_budget' | 'utc_fallback';
			project: string | null;
			workflow: string;
			selected_states: CohortStateProof[];
			selection_basis: 'all_current_done' | 'explicit' | 'retained_recorded_done' | 'unavailable';
			definitions_resolved_at: number;
			observed_through: number;
	  };

export type UsageCursorPayload = {
	v: 1;
	scope: string;
	kind: 'issues' | 'runs' | 'entries';
	population: 'all' | 'finalized' | 'pending';
	member: string | null;
	sort: 'cost' | 'time';
	direction: 'asc' | 'desc';
	traversal: 'after' | 'before';
	boundary: { cost: string | null; at: number; id: string };
};

export function usageKeyMaterial(env: {
	SECRET_ENCRYPTION_KEY?: string;
	BETTER_AUTH_SECRET?: string;
}): string | null {
	return env.SECRET_ENCRYPTION_KEY || env.BETTER_AUTH_SECRET || null;
}

const b64 = (bytes: Uint8Array) => {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const unb64 = (text: string) => {
	const value = text.replace(/-/g, '+').replace(/_/g, '/');
	const binary = atob(value + '='.repeat((4 - (value.length % 4)) % 4));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

async function key(material: string, domain: string) {
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${domain}:${material}`));
	return crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
		'verify'
	]);
}

async function sign(value: object, material: string, domain: string): Promise<string> {
	const body = b64(encoder.encode(JSON.stringify(value)));
	const signature = await crypto.subtle.sign(
		'HMAC',
		await key(material, domain),
		encoder.encode(body)
	);
	return `${body}.${b64(new Uint8Array(signature))}`;
}

async function verify(token: string, material: string, domain: string): Promise<unknown> {
	if (token.length > MAX_TOKEN) throw new UsageInputError('Token is too large', 'scope');
	const parts = token.split('.');
	if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)))
		throw new UsageInputError('Malformed or invalid token', 'scope');
	try {
		if (
			!(await crypto.subtle.verify(
				'HMAC',
				await key(material, domain),
				unb64(parts[1]) as BufferSource,
				encoder.encode(parts[0])
			))
		)
			throw new Error('signature');
		return JSON.parse(new TextDecoder().decode(unb64(parts[0]))) as unknown;
	} catch {
		throw new UsageInputError('Malformed or invalid token', 'scope');
	}
}

export const mintUsageScope = (payload: UsageScopePayload, material: string) =>
	sign(payload, material, 'tines-usage-scope-v1');
export async function verifyUsageScope(
	token: string,
	material: string
): Promise<UsageScopePayload> {
	const value = await verify(token, material, 'tines-usage-scope-v1');
	if (!validScope(value))
		throw new UsageInputError('Malformed or unsupported usage scope', 'scope');
	return value;
}
export const mintUsageCursor = (payload: UsageCursorPayload, material: string) =>
	sign(payload, material, 'tines-usage-cursor-v1');
export async function verifyUsageCursor(
	token: string,
	material: string
): Promise<UsageCursorPayload> {
	const value = await verify(token, material, 'tines-usage-cursor-v1');
	if (!validCursor(value))
		throw new UsageInputError('Malformed or unsupported evidence cursor', 'cursor');
	return value;
}

function plain(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}
function safeTime(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function validScope(value: unknown): value is UsageScopePayload {
	if (!plain(value) || value.v !== 1 || typeof value.owner !== 'string') return false;
	if (value.mode === 'issue')
		return (
			Object.keys(value).sort().join(',') ===
				'cutoff,issue,mode,owner,timezone,timezone_source,v' &&
			typeof value.issue === 'string' &&
			value.issue.length > 0 &&
			safeTime(value.cutoff) &&
			typeof value.timezone === 'string' &&
			['supervisor_budget', 'utc_fallback'].includes(String(value.timezone_source))
		);
	if (value.mode === 'cohort') {
		if (
			Object.keys(value).sort().join(',') !==
				'definitions_resolved_at,from,mode,observed_through,owner,project,selected_states,selection_basis,timezone,timezone_source,to,v,workflow' ||
			!safeTime(value.from) ||
			!safeTime(value.to) ||
			!safeTime(value.definitions_resolved_at) ||
			!safeTime(value.observed_through) ||
			value.from >= value.to ||
			value.to > value.observed_through ||
			typeof value.workflow !== 'string' ||
			!(value.project === null || typeof value.project === 'string') ||
			typeof value.timezone !== 'string' ||
			!['supervisor_budget', 'utc_fallback'].includes(String(value.timezone_source)) ||
			!['all_current_done', 'explicit', 'retained_recorded_done', 'unavailable'].includes(
				String(value.selection_basis)
			) ||
			!Array.isArray(value.selected_states)
		)
			return false;
		const ids = new Set<string>();
		for (const state of value.selected_states) {
			if (
				!plain(state) ||
				Object.keys(state).sort().join(',') !== 'basis,category,id,name,proof_event_id' ||
				typeof state.id !== 'string' ||
				typeof state.name !== 'string' ||
				state.category !== 'done' ||
				!['current_definition', 'recorded_entry'].includes(String(state.basis)) ||
				!(state.proof_event_id === null || typeof state.proof_event_id === 'string') ||
				ids.has(state.id)
			)
				return false;
			ids.add(state.id);
		}
		return true;
	}
	const filters = value.filters;
	return (
		value.mode === 'period' &&
		Object.keys(value).sort().join(',') ===
			'by,filters,from,mode,owner,timezone,timezone_source,to,v' &&
		safeTime(value.from) &&
		safeTime(value.to) &&
		value.from < value.to &&
		typeof value.timezone === 'string' &&
		['supervisor_budget', 'utc_fallback'].includes(String(value.timezone_source)) &&
		plain(filters) &&
		Object.keys(filters).every((name) =>
			['project', 'workflow', 'state', 'runner', 'tier', 'outcome', 'accounting_status'].includes(
				name
			)
		) &&
		Object.values(filters).every((entry) => typeof entry === 'string' && entry.length > 0) &&
		(filters.outcome === undefined ||
			['advanced', 'stalled', 'interrupted', 'unknown'].includes(String(filters.outcome))) &&
		(filters.accounting_status === undefined ||
			['priced', 'unpriced', 'unreported'].includes(String(filters.accounting_status))) &&
		['project', 'workflow', 'state', 'outcome', 'runner', 'tier'].includes(String(value.by))
	);
}
function validCursor(value: unknown): value is UsageCursorPayload {
	if (!plain(value) || !plain(value.boundary)) return false;
	return (
		value.v === 1 &&
		Object.keys(value).sort().join(',') ===
			'boundary,direction,kind,member,population,scope,sort,traversal,v' &&
		Object.keys(value.boundary).sort().join(',') === 'at,cost,id' &&
		typeof value.scope === 'string' &&
		['issues', 'runs', 'entries'].includes(String(value.kind)) &&
		['all', 'finalized', 'pending'].includes(String(value.population)) &&
		(value.member === null || typeof value.member === 'string') &&
		['cost', 'time'].includes(String(value.sort)) &&
		['asc', 'desc'].includes(String(value.direction)) &&
		['after', 'before'].includes(String(value.traversal)) &&
		(value.boundary.cost === null || typeof value.boundary.cost === 'string') &&
		safeTime(value.boundary.at) &&
		typeof value.boundary.id === 'string'
	);
}
