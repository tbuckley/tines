import {
	canonicalizeLibraryValue,
	parsePublicWorkflowDocument,
	validateModerationText,
	validateRequestId,
	type ModerationDecisionReceipt,
	type ModerationDecisionRequest,
	type PublicationMetadata,
	type PublicationReportReason,
	type WorkflowReportCase
} from '@tines/shared';
import { sql, type Kysely } from 'kysely';
import { sha256Hex } from '../crypto';
import { ApiFail, runAtomic, type ActorContext } from '../api/core';
import { newId, type Database } from '../db';
import { assertHostModerator } from './moderation-auth';

const AUDIT_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const ACTIONS = new Set(['dismiss', 'disable', 'restore', 'suspend', 'unsuspend']);

function boundedLimit(limit: number | undefined): number {
	return Number.isInteger(limit) && limit! >= 1 && limit! <= 100 ? limit! : 50;
}

function publicLabels(documentJson: string, metadataJson: string) {
	let displayName = 'Publisher';
	let title = 'Snapshot';
	try {
		displayName = (JSON.parse(metadataJson) as PublicationMetadata).display_name || displayName;
		const document = JSON.parse(documentJson) as {
			main_workflow_id?: string;
			workflows?: Array<{ id: string; name: string }>;
		};
		title =
			document.workflows?.find((item) => item.id === document.main_workflow_id)?.name || title;
	} catch {
		// Deliberately use neutral labels for malformed stored public bytes.
	}
	return { displayName, title };
}

export async function listModerationCases(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	options: { filter?: 'unread' | 'open' | 'resolved' | 'all'; limit?: number } = {}
): Promise<{ items: WorkflowReportCase[]; next_cursor: null }> {
	assertHostModerator(actor, env);
	const filter = options.filter ?? 'unread';
	let query = db
		.selectFrom('workflow_report_case as c')
		.leftJoin('workflow_publication as p', 'p.snapshot_id', 'c.snapshot_id')
		.leftJoin('workflow_publisher_status as s', 's.user_id', 'p.user_id')
		.select([
			'c.snapshot_id',
			'c.version',
			'c.read_through_version',
			'c.resolved_through_version',
			'c.latest_report_at',
			'p.document_json',
			'p.metadata_json',
			'p.owner_state',
			'p.host_state',
			'p.status_version',
			's.suspended',
			's.status_version as publisher_status_version'
		]);
	if (filter === 'unread') query = query.whereRef('c.version', '>', 'c.read_through_version');
	if (filter === 'open') query = query.whereRef('c.version', '>', 'c.resolved_through_version');
	if (filter === 'resolved') query = query.whereRef('c.version', '=', 'c.resolved_through_version');
	const rows = await query
		.orderBy('c.latest_report_at', 'desc')
		.orderBy('c.snapshot_id', 'asc')
		.limit(boundedLimit(options.limit))
		.execute();
	const items = await Promise.all(
		rows.map(async (row) => {
			const counts = await db
				.selectFrom('workflow_report')
				.select(['reason', (eb) => eb.fn.countAll<number>().as('count')])
				.where('snapshot_id', '=', row.snapshot_id)
				.where('case_version', '>', row.resolved_through_version)
				.groupBy('reason')
				.execute();
			const labels =
				row.document_json && row.metadata_json
					? publicLabels(row.document_json, row.metadata_json)
					: { displayName: 'Publisher', title: 'Snapshot no longer stored' };
			return {
				snapshot_id: row.snapshot_id,
				display_name: labels.displayName,
				title: labels.title,
				version: row.version,
				read_through_version: row.read_through_version,
				resolved_through_version: row.resolved_through_version,
				latest_report_at: row.latest_report_at,
				total: counts.reduce((sum, item) => sum + Number(item.count), 0),
				reason_counts: Object.fromEntries(
					counts.map((item) => [item.reason as PublicationReportReason, Number(item.count)])
				),
				owner_state:
					row.owner_state === 'published' || row.owner_state === 'withdrawn'
						? row.owner_state
						: null,
				host_state: row.host_state ?? null,
				status_version: row.status_version ?? null,
				suspended: row.suspended === 1,
				publisher_status_version: row.publisher_status_version ?? 0
			} satisfies WorkflowReportCase;
		})
	);
	return { items, next_cursor: null };
}

export async function inspectModerationSnapshot(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	snapshotId: string
) {
	assertHostModerator(actor, env);
	const row = await db
		.selectFrom('workflow_publication as p')
		.leftJoin('workflow_publisher_status as s', 's.user_id', 'p.user_id')
		.select([
			'p.snapshot_id',
			'p.user_id',
			'p.document_json',
			'p.document_digest',
			'p.bytes_sha256',
			'p.review_digest',
			'p.metadata_json',
			'p.published_at',
			'p.owner_state',
			'p.host_state',
			'p.status_version',
			'p.host_decision_reason',
			'p.host_decision_reference',
			's.suspended',
			's.status_version as publisher_status_version',
			's.decision_reason as suspension_reason',
			's.decision_reference as suspension_reference'
		])
		.where('p.snapshot_id', '=', snapshotId)
		.executeTakeFirst();
	if (!row) throw new ApiFail(404, 'not_found', 'Not found');
	let document = null;
	let diagnostics: string[] = [];
	try {
		const parsed = await parsePublicWorkflowDocument(row.document_json);
		document = parsed.diagnostics.length ? null : parsed.document;
		diagnostics = parsed.diagnostics.map((item) => item.message);
	} catch {
		diagnostics = ['Stored snapshot could not be parsed'];
	}
	const reportGroups = await db
		.selectFrom('workflow_report')
		.select([
			'reason',
			'note',
			'note_hash',
			(eb) => eb.fn.countAll<number>().as('count'),
			(eb) => eb.fn.max<number>('created_at').as('latest_report_at')
		])
		.where('snapshot_id', '=', snapshotId)
		.groupBy(['reason', 'note_hash', 'note'])
		.orderBy('latest_report_at', 'desc')
		.limit(100)
		.execute();
	const reportCase = await db
		.selectFrom('workflow_report_case')
		.selectAll()
		.where('snapshot_id', '=', snapshotId)
		.executeTakeFirst();
	return {
		snapshot_id: row.snapshot_id,
		publisher_id: row.user_id,
		metadata: JSON.parse(row.metadata_json) as PublicationMetadata,
		document,
		...(document ? {} : { raw_document_json: row.document_json }),
		diagnostics,
		hashes: {
			document_digest: row.document_digest,
			bytes_sha256: row.bytes_sha256,
			review_digest: row.review_digest
		},
		published_at: row.published_at,
		owner_state: row.owner_state,
		host_state: row.host_state,
		status_version: row.status_version,
		host_removal:
			row.host_state === 'removed'
				? { reason: row.host_decision_reason, reference: row.host_decision_reference }
				: null,
		suspension:
			row.suspended === 1
				? { reason: row.suspension_reason, reference: row.suspension_reference }
				: null,
		publisher_status_version: row.publisher_status_version ?? 0,
		case: reportCase ?? null,
		reports: reportGroups.map((item) => ({ ...item, count: Number(item.count) }))
	};
}

export async function markModerationCaseRead(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	snapshotId: string,
	throughVersion: number
) {
	assertHostModerator(actor, env);
	if (!Number.isSafeInteger(throughVersion) || throughVersion < 1)
		throw new ApiFail(422, 'invalid_field', 'through_version must be a positive integer');
	await db
		.updateTable('workflow_report_case')
		.set((eb) => ({
			read_through_version: eb.fn('max', ['read_through_version', eb.val(throughVersion)])
		}))
		.where('snapshot_id', '=', snapshotId)
		.where('version', '>=', throughVersion)
		.execute();
	const row = await db
		.selectFrom('workflow_report_case')
		.select(['version', 'read_through_version', 'resolved_through_version'])
		.where('snapshot_id', '=', snapshotId)
		.executeTakeFirst();
	if (!row) throw new ApiFail(404, 'not_found', 'Not found');
	return row;
}

function validateDecision(input: ModerationDecisionRequest) {
	if (!input || typeof input !== 'object' || Array.isArray(input))
		throw new ApiFail(422, 'invalid_decision', 'Invalid moderation decision');
	try {
		validateRequestId(input.request_id);
		validateModerationText(input.reason, true);
	} catch (error) {
		throw new ApiFail(
			422,
			'invalid_decision',
			error instanceof Error ? error.message : 'Invalid decision'
		);
	}
	if (!ACTIONS.has(input.action)) throw new ApiFail(422, 'invalid_decision', 'Invalid action');
	const allowed = new Set([
		'request_id',
		'action',
		'target',
		'reason',
		'expected_snapshot_version',
		'expected_publisher_version',
		'case_through_version'
	]);
	if (Object.keys(input).some((key) => !allowed.has(key)))
		throw new ApiFail(422, 'invalid_decision', 'Unknown decision field');
	if (!input.target || typeof input.target !== 'object' || Array.isArray(input.target))
		throw new ApiFail(422, 'invalid_decision', 'Decision target is required');
	if (Object.keys(input.target).some((key) => !['snapshot_id', 'publisher_id'].includes(key)))
		throw new ApiFail(422, 'invalid_decision', 'Unknown decision target field');
	for (const value of [
		input.expected_snapshot_version,
		input.expected_publisher_version,
		input.case_through_version
	]) {
		if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
			throw new ApiFail(422, 'invalid_decision', 'Decision versions must be nonnegative integers');
	}
}

export async function decideModeration(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	input: ModerationDecisionRequest,
	now = Date.now()
): Promise<ModerationDecisionReceipt> {
	assertHostModerator(actor, env);
	validateDecision(input);
	const reason = validateModerationText(input.reason, true).trim();
	const targetKind =
		input.action === 'suspend' || input.action === 'unsuspend' ? 'publisher' : 'snapshot';
	const targetId =
		targetKind === 'publisher' ? input.target.publisher_id : input.target.snapshot_id;
	if (!targetId) throw new ApiFail(422, 'invalid_decision', 'Decision target is required');
	const requestHash = await sha256Hex(canonicalizeLibraryValue({ ...input, reason }));
	const oldAudit = await db
		.selectFrom('workflow_moderation_audit')
		.selectAll()
		.where('actor_user_id', '=', actor.userId)
		.where('request_id', '=', input.request_id)
		.executeTakeFirst();
	if (oldAudit) {
		if (oldAudit.request_hash !== requestHash)
			throw new ApiFail(
				409,
				'moderation_request_conflict',
				'Use a new request ID for changed details'
			);
		return {
			decision_id: oldAudit.id,
			action: oldAudit.action,
			target: { kind: oldAudit.target_kind, id: oldAudit.target_id },
			decided_at: oldAudit.created_at
		};
	}

	const snapshot = input.target.snapshot_id
		? await db
				.selectFrom('workflow_publication')
				.select([
					'snapshot_id',
					'user_id',
					'owner_state',
					'host_state',
					'status_version',
					'document_digest',
					'bytes_sha256'
				])
				.where('snapshot_id', '=', input.target.snapshot_id)
				.executeTakeFirst()
		: undefined;
	if (targetKind === 'snapshot' && !snapshot) throw new ApiFail(404, 'not_found', 'Not found');
	const publisherId = targetKind === 'publisher' ? targetId : snapshot!.user_id;
	const publisher = await db
		.selectFrom('workflow_publisher_status')
		.selectAll()
		.where('user_id', '=', publisherId)
		.executeTakeFirst();
	if (
		targetKind === 'publisher' &&
		((snapshot && snapshot.user_id !== publisherId) || (!snapshot && !publisher))
	)
		throw new ApiFail(404, 'not_found', 'Not found');
	const currentPublisherVersion = publisher?.status_version ?? 0;
	const auditId = newId('mod');
	let before: Record<string, unknown>;
	let after: Record<string, unknown>;
	if (input.action === 'dismiss') {
		const reportCase = await db
			.selectFrom('workflow_report_case')
			.selectAll()
			.where('snapshot_id', '=', targetId)
			.executeTakeFirst();
		const cutoff = input.case_through_version;
		if (
			!reportCase ||
			!Number.isSafeInteger(cutoff) ||
			cutoff! < 1 ||
			cutoff! > reportCase.version ||
			cutoff! <= reportCase.resolved_through_version
		)
			throw new ApiFail(409, 'moderation_state_changed', 'Reload the moderation case');
		before = { resolved_through_version: reportCase.resolved_through_version };
		after = { resolved_through_version: cutoff };
	} else if (targetKind === 'snapshot') {
		if (
			input.expected_snapshot_version !== undefined &&
			input.expected_snapshot_version !== snapshot!.status_version
		)
			throw new ApiFail(409, 'moderation_state_changed', 'Reload the snapshot status');
		const desired = input.action === 'disable' ? 'removed' : 'active';
		if (snapshot!.host_state === desired)
			throw new ApiFail(409, 'moderation_state_changed', 'The requested state is already active');
		before = { host_state: snapshot!.host_state, status_version: snapshot!.status_version };
		after = { host_state: desired, status_version: snapshot!.status_version + 1 };
	} else {
		if (
			input.expected_publisher_version !== undefined &&
			input.expected_publisher_version !== currentPublisherVersion
		)
			throw new ApiFail(409, 'moderation_state_changed', 'Reload the publisher status');
		const desired = input.action === 'suspend' ? 1 : 0;
		if ((publisher?.suspended ?? 0) === desired)
			throw new ApiFail(409, 'moderation_state_changed', 'The requested state is already active');
		before = { suspended: publisher?.suspended ?? 0, status_version: currentPublisherVersion };
		after = { suspended: desired, status_version: currentPublisherVersion + 1 };
	}
	const beforeJson = canonicalizeLibraryValue(before);
	const afterJson = canonicalizeLibraryValue(after);
	const queries = [
		sql`INSERT INTO workflow_moderation_audit
			(id, request_id, request_hash, actor_user_id, actor_name, action, target_kind,
			 target_id, snapshot_id, document_digest, bytes_sha256, publisher_user_id,
			 before_json, after_json, case_cutoff, reason, created_at, expires_at)
		SELECT ${auditId}, ${input.request_id}, ${requestHash}, ${actor.userId}, ${actor.userName},
			${input.action}, ${targetKind}, ${targetId}, ${snapshot?.snapshot_id ?? input.target.snapshot_id ?? null},
			${snapshot?.document_digest ?? null}, ${snapshot?.bytes_sha256 ?? null}, ${publisherId},
			${beforeJson}, ${afterJson}, ${input.case_through_version ?? null}, ${reason}, ${now}, ${now + AUDIT_TTL_MS}
		WHERE ${
			targetKind === 'snapshot'
				? sql<boolean>`EXISTS (SELECT 1 FROM workflow_publication WHERE snapshot_id = ${targetId} AND status_version = ${snapshot!.status_version} AND host_state = ${snapshot!.host_state})`
				: currentPublisherVersion === 0
					? sql<boolean>`NOT EXISTS (SELECT 1 FROM workflow_publisher_status WHERE user_id = ${publisherId})`
					: sql<boolean>`EXISTS (SELECT 1 FROM workflow_publisher_status WHERE user_id = ${publisherId} AND status_version = ${currentPublisherVersion} AND suspended = ${publisher!.suspended})`
		}
		ON CONFLICT(actor_user_id, request_id) DO NOTHING`.compile(db)
	];
	const freshAudit = sql<boolean>`EXISTS (SELECT 1 FROM workflow_moderation_audit WHERE id = ${auditId} AND actor_user_id = ${actor.userId})`;
	if (input.action === 'dismiss') {
		queries.push(
			sql`UPDATE workflow_report_case SET
				read_through_version = max(read_through_version, ${input.case_through_version!}),
				resolved_through_version = max(resolved_through_version, ${input.case_through_version!}), updated_at = ${now}
			WHERE snapshot_id = ${targetId} AND version >= ${input.case_through_version!} AND ${freshAudit}`.compile(
				db
			),
			sql`UPDATE workflow_report SET resolved_at = ${now}
			WHERE snapshot_id = ${targetId} AND case_version <= ${input.case_through_version!}
			AND resolved_at IS NULL AND ${freshAudit}`.compile(db)
		);
	} else if (targetKind === 'snapshot') {
		const removed = input.action === 'disable';
		queries.push(
			sql`UPDATE workflow_publication SET host_state = ${removed ? 'removed' : 'active'},
				status_version = status_version + 1,
				host_decision_reason = ${removed ? reason : null},
				host_decision_reference = ${removed ? auditId : null}
			WHERE snapshot_id = ${targetId} AND status_version = ${snapshot!.status_version}
			AND host_state = ${snapshot!.host_state} AND ${freshAudit}`.compile(db)
		);
		if (removed && input.case_through_version)
			queries.push(
				sql`UPDATE workflow_report_case SET
					read_through_version = max(read_through_version, ${input.case_through_version}),
					resolved_through_version = max(resolved_through_version, ${input.case_through_version}), updated_at = ${now}
				WHERE snapshot_id = ${targetId} AND version >= ${input.case_through_version} AND ${freshAudit}`.compile(
					db
				),
				sql`UPDATE workflow_report SET resolved_at = ${now}
				WHERE snapshot_id = ${targetId} AND case_version <= ${input.case_through_version}
				AND resolved_at IS NULL AND ${freshAudit}`.compile(db)
			);
	} else {
		const suspended = input.action === 'suspend' ? 1 : 0;
		queries.push(
			sql`INSERT INTO workflow_publisher_status
				(user_id, suspended, status_version, decision_reference, decision_reason)
			SELECT ${publisherId}, ${suspended}, ${currentPublisherVersion + 1},
				${suspended ? auditId : null}, ${suspended ? reason : null} WHERE ${freshAudit}
			ON CONFLICT(user_id) DO UPDATE SET suspended = excluded.suspended,
				status_version = workflow_publisher_status.status_version + 1,
				decision_reference = excluded.decision_reference,
				decision_reason = excluded.decision_reason`.compile(db)
		);
	}
	queries.push(sql`SELECT id FROM workflow_moderation_audit WHERE id = ${auditId}`.compile(db));
	const results = await runAtomic(env, queries);
	if (!results.at(-1)?.results?.length)
		throw new ApiFail(409, 'moderation_state_changed', 'Reload the current moderation state');
	return {
		decision_id: auditId,
		action: input.action,
		target: { kind: targetKind, id: targetId },
		decided_at: now
	};
}
