import {
	canonicalizeLibraryValue,
	validatePublicationReportRequest,
	type PublicationReportReceipt,
	type PublicationReportRequest
} from '@tines/shared';
import { sql, type Kysely } from 'kysely';
import { sha256Hex } from '../crypto';
import { ApiFail, runAtomic } from '../api/core';
import { newId, type Database } from '../db';
import { hostModerationConfig } from './config';
import { resolvePublicSnapshot } from './public';

const HOUR_MS = 60 * 60 * 1000;
const RETRY_TTL_MS = 2 * HOUR_MS;

function decodeBase64(value: string): Uint8Array {
	const binary = atob(value);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmac(secret: string, domain: string, value: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		decodeBase64(secret).buffer as ArrayBuffer,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const bytes = new Uint8Array(
		await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${domain}\0${value}`))
	);
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface ReportSubjects {
	network: string;
	account?: string;
}

export async function acceptPublicationReport(
	db: Kysely<Database>,
	env: Env,
	snapshotId: string,
	input: PublicationReportRequest,
	subjects: ReportSubjects,
	now = Date.now()
): Promise<{ status: 200 | 201; body: PublicationReportReceipt }> {
	let request: Required<PublicationReportRequest>;
	try {
		request = validatePublicationReportRequest(input);
	} catch (error) {
		throw new ApiFail(
			422,
			'invalid_report',
			error instanceof Error ? error.message : 'Invalid report'
		);
	}
	const config = hostModerationConfig(env);
	if (!config.valid || !config.hmacSecret)
		throw new ApiFail(503, 'reporting_unavailable', 'Reporting is temporarily unavailable');
	if (!subjects.network)
		throw new ApiFail(503, 'reporting_unavailable', 'Reporting is temporarily unavailable');

	const bodyHash = await sha256Hex(
		canonicalizeLibraryValue({
			snapshot_id: snapshotId,
			reason: request.reason,
			note: request.note
		})
	);
	const requestToken = await hmac(config.hmacSecret, 'request', request.request_id);
	const existing = await db
		.selectFrom('workflow_report_request')
		.select(['body_hash', 'receipt_id', 'created_at', 'expires_at'])
		.where('request_token', '=', requestToken)
		.where('expires_at', '>', now)
		.executeTakeFirst();
	if (existing) {
		if (existing.body_hash !== bodyHash)
			throw new ApiFail(
				409,
				'report_request_conflict',
				'Use a new request ID for changed report details'
			);
		return {
			status: 200,
			body: {
				receipt: { reference: existing.receipt_id, received_at: existing.created_at },
				retry_until: existing.expires_at
			}
		};
	}

	const snapshot = await resolvePublicSnapshot(db, snapshotId);
	if (!snapshot)
		throw new ApiFail(404, 'publication_unavailable', 'This publication is not available.');
	const networkToken = await hmac(config.hmacSecret, 'network', subjects.network);
	const accountToken = subjects.account
		? await hmac(config.hmacSecret, 'account', subjects.account)
		: null;
	const receiptId = newId('rpt');
	const nonce = newId('rat');
	const expiresAt = now + RETRY_TTL_MS;
	const cutoff = now - HOUR_MS;
	const noteHash = await sha256Hex(request.note);
	const subjectGuards = [
		sql<boolean>`(SELECT COUNT(*) FROM workflow_report_rate_event WHERE subject_kind = 'network' AND subject_token = ${networkToken} AND accepted_at > ${cutoff}) < ${config.reportHourlyQuota}`,
		...(accountToken
			? [
					sql<boolean>`(SELECT COUNT(*) FROM workflow_report_rate_event WHERE subject_kind = 'account' AND subject_token = ${accountToken} AND accepted_at > ${cutoff}) < ${config.reportHourlyQuota}`
				]
			: [])
	];
	const allowed = sql<boolean>`${sql.join(subjectGuards, sql` AND `)}`;
	const freshRequest = sql<boolean>`EXISTS (SELECT 1 FROM workflow_report_request WHERE request_token = ${requestToken} AND attempt_nonce = ${nonce})`;
	const results = await runAtomic(env, [
		sql`DELETE FROM workflow_report_request WHERE request_token = ${requestToken} AND expires_at <= ${now}`.compile(
			db
		),
		sql`INSERT INTO workflow_report_request
			(request_token, body_hash, receipt_id, created_at, expires_at, attempt_nonce)
		SELECT ${requestToken}, ${bodyHash}, ${receiptId}, ${now}, ${expiresAt}, ${nonce}
		WHERE ${allowed}
		AND EXISTS (SELECT 1 FROM workflow_publication p
			LEFT JOIN workflow_publisher_status s ON s.user_id = p.user_id
			WHERE p.snapshot_id = ${snapshotId} AND p.owner_state = 'published'
			AND p.host_state = 'active' AND (s.suspended IS NULL OR s.suspended = 0)
			AND p.document_digest = ${snapshot.document_digest} AND p.bytes_sha256 = ${snapshot.bytes_sha256})
		ON CONFLICT(request_token) DO NOTHING`.compile(db),
		sql`INSERT INTO workflow_report_rate_event
			(receipt_id, subject_kind, subject_token, accepted_at, expires_at)
		SELECT ${receiptId}, 'network', ${networkToken}, ${now}, ${expiresAt} WHERE ${freshRequest}`.compile(
			db
		),
		...(accountToken
			? [
					sql`INSERT INTO workflow_report_rate_event
					(receipt_id, subject_kind, subject_token, accepted_at, expires_at)
				SELECT ${receiptId}, 'account', ${accountToken}, ${now}, ${expiresAt} WHERE ${freshRequest}`.compile(
						db
					)
				]
			: []),
		sql`INSERT INTO workflow_report_case
			(snapshot_id, version, read_through_version, resolved_through_version, latest_report_at, updated_at)
		SELECT ${snapshotId}, 1, 0, 0, ${now}, ${now} WHERE ${freshRequest}
		ON CONFLICT(snapshot_id) DO UPDATE SET
			version = workflow_report_case.version + 1,
			latest_report_at = excluded.latest_report_at,
			updated_at = excluded.updated_at`.compile(db),
		sql`INSERT INTO workflow_report
			(id, snapshot_id, case_version, reason, note, note_hash, created_at, resolved_at)
		SELECT ${receiptId}, ${snapshotId}, version, ${request.reason}, ${request.note}, ${noteHash}, ${now}, NULL
		FROM workflow_report_case WHERE snapshot_id = ${snapshotId} AND ${freshRequest}`.compile(db),
		sql`SELECT receipt_id, created_at, expires_at FROM workflow_report_request
		WHERE request_token = ${requestToken} AND attempt_nonce = ${nonce}`.compile(db)
	]);
	const committed = results.at(-1)?.results?.[0] as
		{ receipt_id?: unknown; created_at?: unknown; expires_at?: unknown } | undefined;
	if (typeof committed?.receipt_id === 'string')
		return {
			status: 201,
			body: {
				receipt: { reference: committed.receipt_id, received_at: Number(committed.created_at) },
				retry_until: Number(committed.expires_at)
			}
		};

	const reconciled = await db
		.selectFrom('workflow_report_request')
		.select(['body_hash', 'receipt_id', 'created_at', 'expires_at'])
		.where('request_token', '=', requestToken)
		.where('expires_at', '>', now)
		.executeTakeFirst();
	if (reconciled) {
		if (reconciled.body_hash !== bodyHash)
			throw new ApiFail(
				409,
				'report_request_conflict',
				'Use a new request ID for changed report details'
			);
		return {
			status: 200,
			body: {
				receipt: { reference: reconciled.receipt_id, received_at: reconciled.created_at },
				retry_until: reconciled.expires_at
			}
		};
	}
	const tokens = [
		{ kind: 'network' as const, token: networkToken },
		...(accountToken ? [{ kind: 'account' as const, token: accountToken }] : [])
	];
	const retryTimes = await Promise.all(
		tokens.map(async ({ kind, token }) => {
			const rows = await db
				.selectFrom('workflow_report_rate_event')
				.select('accepted_at')
				.where('subject_kind', '=', kind)
				.where('subject_token', '=', token)
				.where('accepted_at', '>', cutoff)
				.orderBy('accepted_at', 'asc')
				.execute();
			return rows.length >= config.reportHourlyQuota
				? rows[rows.length - config.reportHourlyQuota].accepted_at + HOUR_MS
				: 0;
		})
	);
	const retryAt = Math.max(...retryTimes);
	if (retryAt > now)
		throw new ApiFail(429, 'report_rate_limited', 'Report limit reached; try again later', {
			retry_at: retryAt,
			retry_after_seconds: Math.max(1, Math.ceil((retryAt - now) / 1000))
		});
	if (!(await resolvePublicSnapshot(db, snapshotId)))
		throw new ApiFail(404, 'publication_unavailable', 'This publication is not available.');
	throw new ApiFail(503, 'reporting_unavailable', 'Reporting is temporarily unavailable');
}
