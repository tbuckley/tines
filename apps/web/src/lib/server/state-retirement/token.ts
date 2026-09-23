import {
	canonicalizeLibraryValue,
	type StateRetirementAllocation,
	type StateRetirementPlanV1
} from '@tines/shared';
import { ApiFail, type ActorContext } from '../api/core';

export const RETIREMENT_COMPILER_VERSION = 1;
export const RETIREMENT_PLAN_TTL_MS = 15 * 60_000;
export const RETIREMENT_TOKEN_MAX_BYTES = 512 * 1024;
const DOMAIN = 'tines:state-retirement:v1';
const PREFIX = 'srp1';
const ROLLBACK_DOMAIN = 'tines:state-retirement-rollback:v1';
const ROLLBACK_PREFIX = 'srr1';

export interface RetirementPlanTokenPayload {
	version: 1;
	compiler_version: number;
	id: string;
	hold_id: string;
	user_id: string;
	actor_key: string;
	issued_at: number;
	expires_at: number;
	inventory_digest: string;
	topology_digest: string;
	plan_digest: string;
	held_states: string[];
	allocations: StateRetirementAllocation[];
}

export interface RetirementRollbackTokenPayload {
	version: 1;
	receipt_id: string;
	hold_id: string;
	user_id: string;
	actor_key: string;
	issued_at: number;
	expires_at: number;
}

const plain = (value: unknown): value is Record<string, unknown> =>
	!!value &&
	typeof value === 'object' &&
	!Array.isArray(value) &&
	[null, Object.prototype].includes(Object.getPrototypeOf(value));
const bounded = (value: unknown, max = 200) =>
	typeof value === 'string' && value.length > 0 && value.length <= max;
const digest = (value: unknown) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
const exactKeys = (value: Record<string, unknown>, allowed: readonly string[]) =>
	Object.keys(value).every((key) => allowed.includes(key));

export function retirementActorKey(actor: ActorContext): string {
	if (actor.viaSession) return `session:${actor.userId}`;
	if (actor.apiKeyId) return `key:${actor.apiKeyId}`;
	throw new ApiFail(403, 'invalid_actor', 'An authenticated session or API key is required');
}

export function retirementKeyMaterial(env: {
	SECRET_ENCRYPTION_KEY?: string;
	BETTER_AUTH_SECRET?: string;
}): string {
	const material = env.SECRET_ENCRYPTION_KEY || env.BETTER_AUTH_SECRET;
	if (!material)
		throw new ApiFail(503, 'signing_unavailable', 'State-retirement signing is unavailable');
	return material;
}

function encode(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decode(value: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid base64url');
	const binary = atob(
		value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4)
	);
	const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
	if (encode(bytes) !== value) throw new Error('noncanonical base64url');
	return bytes;
}

async function hmacKey(material: string, domain = DOMAIN): Promise<CryptoKey> {
	const digestBytes = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(`${domain}:${material}`)
	);
	return crypto.subtle.importKey('raw', digestBytes, { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
		'verify'
	]);
}

const rollbackShape = (value: unknown): value is RetirementRollbackTokenPayload => {
	if (!plain(value)) return false;
	const p = value;
	return (
		exactKeys(p, [
			'version',
			'receipt_id',
			'hold_id',
			'user_id',
			'actor_key',
			'issued_at',
			'expires_at'
		]) &&
		p.version === 1 &&
		bounded(p.receipt_id, 150) &&
		bounded(p.hold_id, 150) &&
		bounded(p.user_id, 150) &&
		bounded(p.actor_key, 250) &&
		Number.isSafeInteger(p.issued_at) &&
		Number.isSafeInteger(p.expires_at) &&
		(p.expires_at as number) > (p.issued_at as number)
	);
};

export async function signRetirementRollback(
	payload: RetirementRollbackTokenPayload,
	material: string
): Promise<string> {
	if (!rollbackShape(payload)) throw new ApiFail(422, 'invalid_rollback', 'Invalid rollback token');
	const bytes = new TextEncoder().encode(canonicalizeLibraryValue(payload));
	const body = `${ROLLBACK_PREFIX}.${encode(bytes)}`;
	const signature = await crypto.subtle.sign(
		'HMAC',
		await hmacKey(material, ROLLBACK_DOMAIN),
		new TextEncoder().encode(body)
	);
	return `${body}.${encode(new Uint8Array(signature))}`;
}

export async function verifyRetirementRollback(
	token: unknown,
	material: string
): Promise<RetirementRollbackTokenPayload> {
	const invalid = () =>
		new ApiFail(422, 'invalid_rollback_token', 'Rollback token is invalid; prepare again');
	if (typeof token !== 'string' || token.length > 4096) throw invalid();
	const parts = token.split('.');
	if (parts.length !== 3 || parts[0] !== ROLLBACK_PREFIX) throw invalid();
	try {
		const signature = decode(parts[2]);
		if (
			signature.length !== 32 ||
			!(await crypto.subtle.verify(
				'HMAC',
				await hmacKey(material, ROLLBACK_DOMAIN),
				signature as BufferSource,
				new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
			))
		)
			throw invalid();
		const value = JSON.parse(
			new TextDecoder('utf-8', { fatal: true }).decode(decode(parts[1]))
		) as unknown;
		if (!rollbackShape(value)) throw invalid();
		return value;
	} catch {
		throw invalid();
	}
}

function allocationShape(value: unknown): value is StateRetirementAllocation[] {
	if (!Array.isArray(value) || value.length > 20_000) return false;
	return value.every((entry) => {
		if (
			!plain(entry) ||
			!exactKeys(entry, [
				'source_item_id',
				'copy_item_id',
				'copy_file_ids',
				'name',
				'scope',
				'position',
				'version',
				'source_version'
			])
		)
			return false;
		return (
			bounded(entry.source_item_id, 150) &&
			bounded(entry.copy_item_id, 150) &&
			bounded(entry.name, 200) &&
			Array.isArray(entry.copy_file_ids) &&
			entry.copy_file_ids.every((id) => bounded(id, 150)) &&
			plain(entry.scope) &&
			['project_id', 'workflow_state_id', 'label_id', 'issue_id'].every((key) =>
				Object.hasOwn(entry.scope as object, key)
			) &&
			Number.isSafeInteger(entry.position) &&
			Number.isSafeInteger(entry.version) &&
			(entry.version as number) >= 0 &&
			Number.isSafeInteger(entry.source_version) &&
			(entry.source_version as number) >= 0 &&
			entry.version === 1
		);
	});
}

function payloadShape(value: unknown): value is RetirementPlanTokenPayload {
	if (!plain(value)) return false;
	const p = value;
	const keys = [
		'version',
		'compiler_version',
		'id',
		'hold_id',
		'user_id',
		'actor_key',
		'issued_at',
		'expires_at',
		'inventory_digest',
		'topology_digest',
		'plan_digest',
		'held_states',
		'allocations'
	];
	if (!exactKeys(p, keys) || !keys.every((key) => Object.hasOwn(p, key))) return false;
	if (
		p.version !== 1 ||
		p.compiler_version !== RETIREMENT_COMPILER_VERSION ||
		!bounded(p.id, 150) ||
		!bounded(p.hold_id, 150) ||
		!bounded(p.user_id, 150) ||
		!bounded(p.actor_key, 250)
	)
		return false;
	if (
		!Number.isSafeInteger(p.issued_at) ||
		!Number.isSafeInteger(p.expires_at) ||
		(p.expires_at as number) !== (p.issued_at as number) + RETIREMENT_PLAN_TTL_MS
	)
		return false;
	if (!digest(p.inventory_digest) || !digest(p.topology_digest) || !digest(p.plan_digest))
		return false;
	return (
		Array.isArray(p.held_states) &&
		p.held_states.every((id) => bounded(id, 150)) &&
		new Set(p.held_states).size === p.held_states.length &&
		allocationShape(p.allocations)
	);
}

export async function signRetirementPlan(
	payload: RetirementPlanTokenPayload,
	material: string
): Promise<string> {
	if (!payloadShape(payload))
		throw new ApiFail(422, 'invalid_plan', 'Invalid state-retirement plan');
	const bytes = new TextEncoder().encode(canonicalizeLibraryValue(payload));
	if (bytes.byteLength > RETIREMENT_TOKEN_MAX_BYTES)
		throw new ApiFail(
			422,
			'retirement_plan_too_large',
			'Signed state-retirement plan exceeds 512 KiB'
		);
	const body = `${PREFIX}.${encode(bytes)}`;
	const signature = await crypto.subtle.sign(
		'HMAC',
		await hmacKey(material),
		new TextEncoder().encode(body)
	);
	return `${body}.${encode(new Uint8Array(signature))}`;
}

export async function verifyRetirementPlan(
	token: unknown,
	material: string
): Promise<RetirementPlanTokenPayload> {
	const invalid = () =>
		new ApiFail(422, 'invalid_plan_token', 'State-retirement plan token is invalid; prepare again');
	if (
		typeof token !== 'string' ||
		token.length > Math.ceil((RETIREMENT_TOKEN_MAX_BYTES * 4) / 3) + 100
	)
		throw invalid();
	const parts = token.split('.');
	if (parts.length !== 3 || parts[0] !== PREFIX) throw invalid();
	try {
		const signature = decode(parts[2]);
		if (
			signature.length !== 32 ||
			!(await crypto.subtle.verify(
				'HMAC',
				await hmacKey(material),
				signature as BufferSource,
				new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
			))
		)
			throw invalid();
		const bytes = decode(parts[1]);
		if (bytes.byteLength > RETIREMENT_TOKEN_MAX_BYTES) throw invalid();
		const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
		if (!payloadShape(value)) throw invalid();
		return value;
	} catch {
		throw invalid();
	}
}

export function tokenPayloadForPlan(
	plan: StateRetirementPlanV1,
	input: Omit<RetirementPlanTokenPayload, 'plan_digest' | 'allocations'>,
	planDigest: string
): RetirementPlanTokenPayload {
	return { ...input, plan_digest: planDigest, allocations: plan.allocations };
}
