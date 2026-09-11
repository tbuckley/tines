import {
	canonicalizeLibraryValue,
	type PackageAllocation,
	type WorkflowPackageChoices
} from '@tines/shared';
import { ApiFail, type ActorContext } from '../api/core';
import type { DestinationSelection } from './destination';

export const PACKAGE_COMPILER_VERSION = 1;
export const PACKAGE_PLAN_TTL_MS = 15 * 60_000;
export const PACKAGE_TOKEN_MAX_BYTES = 512 * 1024;
const DOMAIN = 'tines:workflow-install:v1';
const PREFIX = 'wip1';
export interface PackagePlanPayload {
	version: 1;
	compiler_version: number;
	id: string;
	user_id: string;
	actor_key: string;
	issued_at: number;
	expires_at: number;
	document_digest: string;
	plan_digest: string;
	choices: WorkflowPackageChoices;
	allocation: PackageAllocation;
	selection: DestinationSelection;
	witness_hash: string;
}
export function packageActorKey(actor: ActorContext): string {
	if (actor.viaSession) return `session:${actor.userId}`;
	if (actor.apiKeyId) return `key:${actor.apiKeyId}`;
	throw new ApiFail(403, 'invalid_actor', 'An authenticated session or API key is required');
}
export function packageKeyMaterial(env: {
	SECRET_ENCRYPTION_KEY?: string;
	BETTER_AUTH_SECRET?: string;
}): string {
	const material = env.SECRET_ENCRYPTION_KEY || env.BETTER_AUTH_SECRET;
	if (!material)
		throw new ApiFail(503, 'signing_unavailable', 'Workflow package signing is unavailable');
	return material;
}
const encode = (bytes: Uint8Array) => {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};
function decode(text: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('Invalid base64url');
	const binary = atob(
		text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4)
	);
	const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
	if (encode(bytes) !== text) throw new Error('Noncanonical base64url');
	return bytes;
}
async function key(material: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(`${DOMAIN}:${material}`)
	);
	return crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
		'verify'
	]);
}
function payloadShape(value: unknown): value is PackagePlanPayload {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const p = value as Record<string, unknown>;
	const required = [
		'version',
		'compiler_version',
		'id',
		'user_id',
		'actor_key',
		'issued_at',
		'expires_at',
		'document_digest',
		'plan_digest',
		'choices',
		'allocation',
		'selection',
		'witness_hash'
	];
	if (Object.keys(p).length !== required.length || !required.every((k) => Object.hasOwn(p, k)))
		return false;
	if (
		p.version !== 1 ||
		!Number.isSafeInteger(p.compiler_version) ||
		!Number.isSafeInteger(p.issued_at) ||
		!Number.isSafeInteger(p.expires_at)
	)
		return false;
	if (
		(p.issued_at as number) < 0 ||
		(p.expires_at as number) - (p.issued_at as number) !== PACKAGE_PLAN_TTL_MS
	)
		return false;
	for (const field of ['id', 'user_id', 'actor_key'])
		if (
			typeof p[field] !== 'string' ||
			!(p[field] as string).length ||
			(p[field] as string).length > 150
		)
			return false;
	for (const field of ['document_digest', 'plan_digest'])
		if (typeof p[field] !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(p[field] as string))
			return false;
	if (typeof p.witness_hash !== 'string' || !/^[0-9a-f]{64}$/.test(p.witness_hash)) return false;
	for (const field of ['choices', 'allocation', 'selection'])
		if (!p[field] || typeof p[field] !== 'object' || Array.isArray(p[field])) return false;
	return true;
}
export async function signPackagePlan(
	payload: PackagePlanPayload,
	material: string
): Promise<string> {
	if (!payloadShape(payload))
		throw new ApiFail(422, 'invalid_plan', 'Invalid package plan payload');
	const bytes = new TextEncoder().encode(canonicalizeLibraryValue(payload));
	if (bytes.length > PACKAGE_TOKEN_MAX_BYTES)
		throw new ApiFail(422, 'package_too_large', 'Signed plan exceeds 512 KiB');
	const signed = `${PREFIX}.${encode(bytes)}`;
	const signature = await crypto.subtle.sign(
		'HMAC',
		await key(material),
		new TextEncoder().encode(signed)
	);
	return `${signed}.${encode(new Uint8Array(signature))}`;
}
/** Signature verification precedes decoding/parsing. Expiry is checked after receipt recovery by install. */
export async function verifyPackagePlan(
	token: unknown,
	material: string
): Promise<PackagePlanPayload> {
	const invalid = () =>
		new ApiFail(422, 'invalid_plan_token', 'Package plan token is invalid; prepare again');
	if (
		typeof token !== 'string' ||
		token.length > Math.ceil((PACKAGE_TOKEN_MAX_BYTES * 4) / 3) + 100
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
				await key(material),
				signature as BufferSource,
				new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
			))
		)
			throw invalid();
		const bytes = decode(parts[1]);
		if (bytes.length > PACKAGE_TOKEN_MAX_BYTES) throw invalid();
		const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
		if (!payloadShape(payload)) throw invalid();
		return payload;
	} catch {
		throw invalid();
	}
}
