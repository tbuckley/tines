import { sql, type RawBuilder } from 'kysely';
import { sha256Hex } from '$lib/server/crypto';

const TOKEN_VERSION = 'v1';
const KEY_PREFIX = 'tines:issue-transfer:v1:';
export const TRANSFER_PREVIEW_TTL_MS = 15 * 60_000;

export interface TransferWitnessPayload {
	v: 1;
	u: string;
	i: string;
	s: string;
	d: string;
	a: string;
	n: number;
	e: number;
	h: { issue: string; context: string };
}

export interface TransferWitnessSections {
	issue: string;
	context: string;
}

export function transferKeyMaterial(env: {
	SECRET_ENCRYPTION_KEY?: string;
	BETTER_AUTH_SECRET?: string;
}): string | null {
	return env.SECRET_ENCRYPTION_KEY || env.BETTER_AUTH_SECRET || null;
}

function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
	const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmacKey(keyMaterial: string): Promise<CryptoKey> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(KEY_PREFIX + keyMaterial)
	);
	return crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
		'verify'
	]);
}

export async function hashTransferWitness(
	sections: TransferWitnessSections
): Promise<TransferWitnessPayload['h']> {
	return {
		issue: await sha256Hex(sections.issue),
		context: await sha256Hex(sections.context)
	};
}

export async function mintTransferWitness(
	payload: TransferWitnessPayload,
	keyMaterial: string
): Promise<string> {
	const body = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
	const signed = `${TOKEN_VERSION}.${body}`;
	const signature = await crypto.subtle.sign(
		'HMAC',
		await hmacKey(keyMaterial),
		new TextEncoder().encode(signed)
	);
	return `${signed}.${toBase64Url(new Uint8Array(signature))}`;
}

export type VerifiedTransferWitness =
	{ ok: true; payload: TransferWitnessPayload } | { ok: false; reason: 'invalid' | 'expired' };

export async function verifyTransferWitness(
	token: string,
	keyMaterial: string,
	now = Date.now()
): Promise<VerifiedTransferWitness> {
	const parts = token.split('.');
	if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return { ok: false, reason: 'invalid' };
	let payload: unknown;
	let valid = false;
	try {
		valid = await crypto.subtle.verify(
			'HMAC',
			await hmacKey(keyMaterial),
			fromBase64Url(parts[2]) as BufferSource,
			new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
		);
		payload = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1])));
	} catch {
		return { ok: false, reason: 'invalid' };
	}
	if (!valid || !isTransferWitnessPayload(payload)) return { ok: false, reason: 'invalid' };
	if (payload.e <= now) return { ok: false, reason: 'expired' };
	return { ok: true, payload };
}

function isTransferWitnessPayload(value: unknown): value is TransferWitnessPayload {
	if (!value || typeof value !== 'object') return false;
	const p = value as Record<string, unknown>;
	const h = p.h as Record<string, unknown> | undefined;
	return (
		p.v === 1 &&
		typeof p.u === 'string' &&
		typeof p.i === 'string' &&
		typeof p.s === 'string' &&
		typeof p.d === 'string' &&
		typeof p.a === 'string' &&
		typeof p.n === 'number' &&
		typeof p.e === 'number' &&
		!!h &&
		typeof h.issue === 'string' &&
		typeof h.context === 'string'
	);
}

/**
 * The compact slice-1 witness. Later slices extend these fixed sections with
 * the context and routing dependency domains before the service is exposed.
 * The same expressions are read for preview and embedded in commit guards.
 */
export function transferWitnessExpressions(
	issueId: string,
	destinationId: string
): { issue: RawBuilder<string | null>; context: RawBuilder<string> } {
	const issue = sql<string | null>`(
		SELECT json_object(
			'issue', json_object(
				'id', issue.id, 'project_id', issue.project_id, 'number', issue.number,
				'title', issue.title, 'description', issue.description,
				'workflow_id', issue.workflow_id, 'state_id', issue.state_id,
				'scheduled_task_id', issue.scheduled_task_id,
				'pinned_runner_id', issue.pinned_runner_id, 'pinned_tier', issue.pinned_tier,
				'attempt_count', issue.attempt_count, 'needs_attention', issue.needs_attention,
				'state_entered_at', issue.state_entered_at, 'created_at', issue.created_at,
				'updated_at', issue.updated_at,
				'project_assignment_token', issue.project_assignment_token
			),
			'source', json_object(
				'id', source.id, 'name', source.name, 'user_id', source.user_id,
				'archived_at', source.archived_at
			),
			'destination', json_object(
				'id', destination.id, 'name', destination.name, 'user_id', destination.user_id,
				'archived_at', destination.archived_at
			)
		)
		FROM issue
		JOIN project AS source ON source.id = issue.project_id
		JOIN project AS destination ON destination.id = ${destinationId}
		WHERE issue.id = ${issueId}
	)`;
	const context = sql<string>`COALESCE((
		SELECT json_group_array(json(row_json)) FROM (
			SELECT json_object(
				'id', context_item.id, 'user_id', context_item.user_id,
				'kind', context_item.kind, 'name', context_item.name,
				'description', context_item.description, 'project_id', context_item.project_id,
				'workflow_state_id', context_item.workflow_state_id,
				'issue_id', context_item.issue_id, 'label_id', context_item.label_id,
				'body', context_item.body, 'repo_url', context_item.repo_url,
				'repo_branch', context_item.repo_branch, 'repo_dir', context_item.repo_dir,
				'config', context_item.config, 'position', context_item.position,
				'version', context_item.version, 'created_at', context_item.created_at,
				'updated_at', context_item.updated_at
			) AS row_json
			FROM context_item
			WHERE issue_id = ${issueId}
				AND project_id = (SELECT project_id FROM issue WHERE id = ${issueId})
			ORDER BY id
		)
	), '[]')`;
	return { issue, context };
}
