import {
	canonicalizeLibraryValue,
	LABEL_COLORS,
	type PackageAllocation,
	type WorkflowPackageBudget,
	type WorkflowPackageChoices,
	type WorkflowPackageDocument
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
	budget: WorkflowPackageBudget;
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
		'witness_hash',
		'budget'
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
	return (
		choicesShape(p.choices) &&
		allocationShape(p.allocation) &&
		selectionShape(p.selection) &&
		budgetShape(p.budget)
	);
}

function budgetShape(value: unknown): boolean {
	if (
		!plain(value) ||
		!exactKeys(value, ['statements', 'max_parameters', 'max_sql_bytes', 'max_value_bytes'])
	)
		return false;
	return Object.values(value).every(
		(entry) => Number.isSafeInteger(entry) && (entry as number) >= 0
	);
}

const plain = (value: unknown): value is Record<string, unknown> =>
	!!value &&
	typeof value === 'object' &&
	!Array.isArray(value) &&
	[null, Object.prototype].includes(Object.getPrototypeOf(value));
const exactKeys = (value: Record<string, unknown>, allowed: readonly string[]) =>
	Object.keys(value).every((key) => allowed.includes(key));
const boundedText = (value: unknown, max = 200) =>
	typeof value === 'string' && value.length > 0 && value.length <= max;
const stringSet = (value: unknown) =>
	Array.isArray(value) &&
	value.every((entry) => boundedText(entry)) &&
	new Set(value).size === value.length;

function choicesShape(value: unknown): boolean {
	if (
		!plain(value) ||
		!exactKeys(value, ['workflow_names', 'schedule_names', 'inputs', 'schedule_ids', 'routing'])
	)
		return false;
	for (const field of ['workflow_names', 'schedule_names', 'inputs', 'routing']) {
		if (!Object.hasOwn(value, field)) continue;
		const map = value[field];
		if (!plain(map)) return false;
		for (const [id, entry] of Object.entries(map)) {
			if (!boundedText(id, 80)) return false;
			if (field === 'workflow_names' || field === 'schedule_names') {
				if (!boundedText(entry)) return false;
			} else if (field === 'routing') {
				if (!['smartest', 'balanced', 'cheapest'].includes(entry as string)) return false;
			} else {
				if (!plain(entry)) return false;
				if (Object.hasOwn(entry, 'value')) {
					if (
						!exactKeys(entry, ['value']) ||
						typeof entry.value !== 'string' ||
						entry.value.length > 10000
					)
						return false;
				} else if (entry.mode === 'reuse') {
					if (!exactKeys(entry, ['mode', 'id']) || !boundedText(entry.id, 100)) return false;
				} else if (entry.mode === 'create') {
					if (
						!exactKeys(entry, ['mode', 'name', 'color']) ||
						!boundedText(entry.name) ||
						!LABEL_COLORS.includes(entry.color as never)
					)
						return false;
				} else return false;
			}
		}
	}
	return !Object.hasOwn(value, 'schedule_ids') || stringSet(value.schedule_ids);
}

function allocationShape(value: unknown): boolean {
	if (!plain(value) || !exactKeys(value, ['records', 'labels'])) return false;
	for (const field of ['records', 'labels']) {
		const map = value[field];
		if (!plain(map)) return false;
		for (const [localId, allocated] of Object.entries(map)) {
			if (
				!boundedText(localId, 80) ||
				!plain(allocated) ||
				!exactKeys(allocated, ['id', 'event_id'])
			)
				return false;
			if (!boundedText(allocated.id, 150)) return false;
			if (allocated.event_id !== null && !boundedText(allocated.event_id, 150)) return false;
		}
	}
	return true;
}

function selectionShape(value: unknown): boolean {
	if (
		!plain(value) ||
		!exactKeys(value, [
			'workflow_ids',
			'workflow_names',
			'project_ids',
			'label_ids',
			'label_names',
			'schedules',
			'routing_scopes',
			'runner_ids'
		])
	)
		return false;
	for (const field of [
		'workflow_ids',
		'workflow_names',
		'project_ids',
		'label_ids',
		'label_names',
		'runner_ids'
	])
		if (!stringSet(value[field])) return false;
	if (!Array.isArray(value.schedules) || !Array.isArray(value.routing_scopes)) return false;
	for (const schedule of value.schedules)
		if (
			!plain(schedule) ||
			!exactKeys(schedule, ['project_id', 'name']) ||
			!boundedText(schedule.project_id) ||
			!boundedText(schedule.name)
		)
			return false;
	for (const scope of value.routing_scopes)
		if (
			!plain(scope) ||
			!exactKeys(scope, ['project_id', 'state_id']) ||
			(scope.project_id !== null && !boundedText(scope.project_id)) ||
			!boundedText(scope.state_id)
		)
			return false;
	return (
		new Set(value.schedules.map((entry) => JSON.stringify(entry))).size ===
			value.schedules.length &&
		new Set(value.routing_scopes.map((entry) => JSON.stringify(entry))).size ===
			value.routing_scopes.length
	);
}

/** A valid signature must not turn attacker-shaped IDs into compiler inputs. */
export function validatePackageAllocation(
	document: WorkflowPackageDocument,
	allocation: PackageAllocation
): void {
	const expected = new Map<string, { prefix: string; event: boolean }>();
	const add = (id: string, prefix: string, event: boolean) => expected.set(id, { prefix, event });
	for (const workflow of document.workflows) {
		add(workflow.id, 'wf', true);
		workflow.states.forEach((state) => add(state.id, 'wfs', false));
		workflow.transitions.forEach((transition) => add(transition.id, 'wft', false));
	}
	for (const item of document.context) {
		add(item.id, 'ctx', true);
		if (item.kind === 'skill') item.files.forEach((file) => add(file.id, 'ctf', false));
	}
	document.schedules.forEach((schedule) => add(schedule.id, 'sch', true));
	document.routing.forEach((routing) => add(routing.id, 'rul', true));
	const labelIds = document.inputs
		.filter((input) => input.type === 'label')
		.map((input) => input.id);
	if (
		Object.keys(allocation.records).length !== expected.size ||
		Object.keys(allocation.labels).length !== labelIds.length ||
		Object.keys(allocation.records).some((id) => !expected.has(id)) ||
		Object.keys(allocation.labels).some((id) => !labelIds.includes(id))
	)
		throw new ApiFail(
			422,
			'invalid_plan_token',
			'Package plan allocation is invalid; prepare again'
		);
	const used = new Set<string>();
	const check = (
		value: { id: string; event_id: string | null },
		prefix: string,
		event: boolean
	) => {
		if (
			!new RegExp(`^${prefix}_[A-Za-z0-9]{16}$`).test(value.id) ||
			(event
				? !value.event_id || !/^evt_[A-Za-z0-9]{16}$/.test(value.event_id)
				: value.event_id !== null) ||
			used.has(value.id) ||
			(value.event_id !== null && used.has(value.event_id))
		)
			throw new ApiFail(
				422,
				'invalid_plan_token',
				'Package plan allocation is invalid; prepare again'
			);
		used.add(value.id);
		if (value.event_id !== null) used.add(value.event_id);
	};
	for (const [id, shape] of expected) check(allocation.records[id], shape.prefix, shape.event);
	for (const id of labelIds) check(allocation.labels[id], 'lbl', true);
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
