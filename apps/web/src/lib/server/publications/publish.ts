import {
	canonicalizeLibraryValue,
	parsePublicWorkflowDocument,
	withLibraryDocumentDigest,
	PUBLIC_WORKFLOW_POLICY_VERSION,
	type PublicationOwnerResult,
	type PublicationOwnerItem,
	type ListResponse,
	type PublicationReceipt,
	type PublishPublicationRequest,
	type WorkflowPackageDocument
} from '@tines/shared';
import { sql, type Kysely } from 'kysely';
import { newId, type Database } from '$lib/server/db';
import {
	ApiFail,
	encodeCursor,
	runAtomic,
	runKeyForbidden,
	type ActorContext,
	type Page
} from '../api/core';
import { requireAccess } from '../api/permissions';
import { packageActorKey } from '../library/token';
import { publicationConfig } from './config';
import { deriveOwnedPublicationDraft, PublicationDraftError } from './draft';
import { buildOwnedPublicationSourceProof, publicationSourceExpression } from './source';

const DAY_MS = 24 * 60 * 60 * 1000;

interface CandidateRow {
	id: string;
	user_id: string;
	actor_key: string;
	source_kind: 'owned_workflow' | 'file';
	source_provenance_json: string;
	document_json: string;
	document_digest: string;
	bytes_sha256: string;
	byte_length: number;
	metadata_json: string;
	review_digest: string;
	policy_version: number;
	expires_at: number;
	snapshot_id: string | null;
	published_at: number | null;
	owner_state: 'candidate' | 'published' | 'withdrawn';
	host_state: 'active' | 'removed';
	status_version: number;
	publication_receipt_json: string | null;
}

function exactRepoIds(document: WorkflowPackageDocument): string[] {
	return document.context
		.filter((item) => item.kind === 'repo')
		.map((item) => item.id)
		.sort();
}

function parseReceipt(row: CandidateRow): PublicationOwnerResult {
	if (!row.publication_receipt_json || !row.snapshot_id || row.published_at === null)
		throw new ApiFail(409, 'publication_not_committed', 'This publication has not been published');
	return {
		receipt: JSON.parse(row.publication_receipt_json) as PublicationReceipt,
		owner_state: row.owner_state === 'withdrawn' ? 'withdrawn' : 'published',
		host_state: row.host_state,
		status_version: row.status_version
	};
}

function publicOrigin(env: Env): string {
	const value = env.TINES_PUBLIC_URL ?? env.BETTER_AUTH_URL;
	if (!value)
		throw new ApiFail(503, 'publication_url_unavailable', 'Public host URL is not configured');
	try {
		const url = new URL(value);
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
			throw new Error('invalid');
		return url.origin;
	} catch {
		throw new ApiFail(503, 'publication_url_unavailable', 'Public host URL is not configured');
	}
}

async function candidateRow(db: Kysely<Database>, userId: string, candidateId: string) {
	return db
		.selectFrom('workflow_publication')
		.selectAll()
		.where('id', '=', candidateId)
		.where('user_id', '=', userId)
		.executeTakeFirst() as Promise<CandidateRow | undefined>;
}

function assertConfirmation(
	row: CandidateRow,
	actor: ActorContext,
	request: PublishPublicationRequest
): WorkflowPackageDocument {
	if (actor.agentRunId) throw runKeyForbidden();
	if (row.actor_key !== packageActorKey(actor))
		throw new ApiFail(403, 'publication_actor_mismatch', 'Prepare a fresh proof with this actor');
	if (
		request.review_digest !== row.review_digest ||
		request.sharing_rights !== true ||
		request.exact_content !== true
	)
		throw new ApiFail(409, 'confirmation_mismatch', 'Confirm the exact reviewed publication');
	const document = JSON.parse(row.document_json) as WorkflowPackageDocument;
	const supplied = [...request.reviewed_repo_ids].sort();
	if (
		new Set(supplied).size !== supplied.length ||
		canonicalizeLibraryValue(supplied) !== canonicalizeLibraryValue(exactRepoIds(document))
	)
		throw new ApiFail(
			409,
			'confirmation_mismatch',
			'Confirm every declared repository in the reviewed publication'
		);
	return document;
}

/** Publish once, or reconcile the durable receipt after a lost response. */
export async function publishPublication(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	candidateId: string,
	request: PublishPublicationRequest,
	now = Date.now(),
	/** Test-only synchronization at the exact boundary the transaction guard closes. */
	beforeAtomic?: () => Promise<void>
): Promise<PublicationOwnerResult> {
	requireAccess(actor, [{ domain: 'control_plane', access: 'write' }], 'publication.publish');
	const row = await candidateRow(db, actor.userId, candidateId);
	if (!row) throw new ApiFail(404, 'not_found', 'Not found');
	assertConfirmation(row, actor, request);
	if (row.published_at !== null) return parseReceipt(row);

	const config = publicationConfig(env);
	if (!config.valid || !config.enabled)
		throw new ApiFail(
			503,
			'publication_disabled',
			config.error ?? 'Public workflow publishing is not enabled on this host'
		);
	if (row.expires_at <= now)
		throw new ApiFail(
			409,
			'publication_proof_expired',
			'Prepare and review a fresh publication proof'
		);
	if (row.policy_version !== PUBLIC_WORKFLOW_POLICY_VERSION)
		throw new ApiFail(
			409,
			'publication_policy_changed',
			'Review under the current publication policy'
		);
	if (row.byte_length > config.maxBytes)
		throw new ApiFail(
			413,
			'publication_too_large',
			`Public workflow exceeds ${config.maxBytes} bytes`
		);

	const parsed = await parsePublicWorkflowDocument(row.document_json);
	if (
		parsed.diagnostics.length ||
		parsed.canonical_json !== row.document_json ||
		parsed.document.digest !== row.document_digest ||
		parsed.bytes_sha256 !== row.bytes_sha256
	)
		throw new ApiFail(
			409,
			'publication_proof_stale',
			'Prepare and review a fresh publication proof'
		);

	let sourceGuard = sql<boolean>`1`;
	if (row.source_kind === 'owned_workflow') {
		const provenance = JSON.parse(row.source_provenance_json) as {
			workflow_id: string;
			options: Parameters<typeof buildOwnedPublicationSourceProof>[3];
			exported_at: number;
			draft_version?: number;
			baseline?: { document_digest: string; exported_at: number };
		};
		if (provenance.draft_version !== undefined && provenance.draft_version !== 1)
			throw new ApiFail(409, 'publication_proof_stale', 'Prepare and review a fresh proof');
		if (provenance.draft_version === 1 && !provenance.baseline)
			throw new ApiFail(409, 'publication_proof_stale', 'Prepare and review a fresh proof');
		const rebuilt = await buildOwnedPublicationSourceProof(
			db,
			actor.userId,
			provenance.workflow_id,
			provenance.options,
			provenance.baseline?.exported_at ?? provenance.exported_at
		);
		let rebuiltJson = canonicalizeLibraryValue(rebuilt.document);
		if (provenance.draft_version === 1 && provenance.baseline) {
			if (rebuilt.document.digest !== provenance.baseline.document_digest)
				throw new ApiFail(
					409,
					'publication_source_changed',
					'The source changed; review a fresh proof'
				);
			try {
				const submitted = await withLibraryDocumentDigest({
					...parsed.document,
					exported_at: provenance.baseline.exported_at
				});
				rebuiltJson = canonicalizeLibraryValue(
					await deriveOwnedPublicationDraft(rebuilt.document, submitted, provenance.exported_at)
				);
			} catch (error) {
				if (error instanceof PublicationDraftError)
					throw new ApiFail(409, 'publication_proof_stale', 'Prepare and review a fresh proof');
				throw error;
			}
		}
		if (
			rebuilt.witnessFingerprint !==
				(
					await db
						.selectFrom('workflow_publication_source')
						.select('source_fingerprint')
						.where('publication_id', '=', row.id)
						.executeTakeFirst()
				)?.source_fingerprint ||
			rebuiltJson !== row.document_json
		)
			throw new ApiFail(
				409,
				'publication_source_changed',
				'The source changed; review a fresh proof'
			);
		sourceGuard = sql<boolean>`${publicationSourceExpression(actor.userId, rebuilt.selection)} = (
			SELECT source_witness_json FROM workflow_publication_source WHERE publication_id = ${row.id}
		)`;
	}

	const snapshotId = newId('pubs');
	const attemptNonce = newId('pat');
	const eventId = newId('evt');
	const statusVersion = row.status_version + 1;
	const publisherStatusVersion = sql<number>`COALESCE((SELECT status_version FROM workflow_publisher_status WHERE user_id = ${actor.userId}), 0)`;
	const receipt: PublicationReceipt = {
		snapshot_id: snapshotId,
		public_url: `${publicOrigin(env)}/p/${snapshotId}`,
		published_at: now,
		status_version: statusVersion,
		document_digest: row.document_digest,
		bytes_sha256: row.bytes_sha256,
		review_digest: row.review_digest
	};
	const receiptJson = canonicalizeLibraryValue(receipt);
	const cutoff = now - DAY_MS;
	const quotaFence = await db
		.selectFrom('workflow_publication_quota_fence')
		.select('version')
		.where('user_id', '=', actor.userId)
		.executeTakeFirst();
	const previousQuotaVersion = quotaFence?.version ?? 0;
	const quotaVersion = previousQuotaVersion + 1;
	const quotaNonce = newId('pqt');
	await beforeAtomic?.();
	try {
		const results = await runAtomic(env, [
			sql`INSERT INTO workflow_publication_quota_fence (user_id, version, attempt_nonce)
			VALUES (${actor.userId}, ${quotaVersion}, ${quotaNonce})
			ON CONFLICT(user_id) DO UPDATE SET version = excluded.version,
				attempt_nonce = excluded.attempt_nonce
			WHERE workflow_publication_quota_fence.version = ${previousQuotaVersion}`.compile(db),
			sql`UPDATE workflow_publication SET
				snapshot_id = ${snapshotId}, published_at = ${now}, owner_state = 'published',
				status_version = ${statusVersion}, confirmed_at = ${now},
				confirmed_actor_key = ${row.actor_key}, publication_receipt_json = ${receiptJson},
				attempt_nonce = ${attemptNonce}
			WHERE id = ${row.id} AND user_id = ${actor.userId} AND actor_key = ${row.actor_key}
				AND published_at IS NULL AND owner_state = 'candidate' AND host_state = 'active'
				AND expires_at > ${now} AND policy_version = ${PUBLIC_WORKFLOW_POLICY_VERSION}
				AND byte_length <= ${config.maxBytes}
				AND NOT EXISTS (SELECT 1 FROM workflow_publisher_status
					WHERE user_id = ${actor.userId} AND suspended = 1)
				AND (SELECT COUNT(*) FROM workflow_publication
					WHERE user_id = ${actor.userId} AND published_at >= ${cutoff}) < ${config.dailyQuota}
				AND EXISTS (SELECT 1 FROM workflow_publication_quota_fence
					WHERE user_id = ${actor.userId} AND version = ${quotaVersion}
						AND attempt_nonce = ${quotaNonce})
				AND ${sourceGuard}`.compile(db),
			sql`INSERT INTO workflow_publication_event
				(id, publication_id, snapshot_id, user_id, actor_key, action,
				 publication_status_version, publisher_status_version, reason, reference, created_at)
			SELECT ${eventId}, id, snapshot_id, user_id, ${row.actor_key}, 'published',
				status_version, ${publisherStatusVersion}, NULL, NULL, ${now}
			FROM workflow_publication WHERE id = ${row.id} AND attempt_nonce = ${attemptNonce}`.compile(db),
			sql`SELECT publication_receipt_json, owner_state, host_state, status_version
			FROM workflow_publication WHERE id = ${row.id} AND attempt_nonce = ${attemptNonce}`.compile(db)
		]);
		const committed = results.at(-1)?.results?.[0] as
			| {
					publication_receipt_json?: unknown;
					owner_state?: unknown;
					host_state?: unknown;
					status_version?: unknown;
			  }
			| undefined;
		if (typeof committed?.publication_receipt_json === 'string') {
			return {
				receipt: JSON.parse(committed.publication_receipt_json) as PublicationReceipt,
				owner_state: 'published',
				host_state: 'active',
				status_version: Number(committed.status_version)
			};
		}
	} catch (error) {
		const durable = await candidateRow(db, actor.userId, candidateId).catch(() => undefined);
		if (durable?.published_at !== null && durable?.published_at !== undefined)
			return parseReceipt(durable);
		if (!durable)
			throw new ApiFail(
				503,
				'publication_outcome_unknown',
				'Publication outcome is unknown; retry this candidate or check its result'
			);
		throw error;
	}

	const durable = await candidateRow(db, actor.userId, candidateId);
	if (durable?.published_at !== null && durable?.published_at !== undefined)
		return parseReceipt(durable);
	const publisher = await db
		.selectFrom('workflow_publisher_status')
		.select('suspended')
		.where('user_id', '=', actor.userId)
		.executeTakeFirst();
	if (publisher?.suspended)
		throw new ApiFail(403, 'publisher_suspended', 'Public workflow publishing is suspended');
	const quota = await db
		.selectFrom('workflow_publication')
		.select((eb) => [
			eb.fn.countAll<number>().as('count'),
			eb.fn.min<number>('published_at').as('oldest')
		])
		.where('user_id', '=', actor.userId)
		.where('published_at', '>=', cutoff)
		.executeTakeFirstOrThrow();
	if (Number(quota.count) >= config.dailyQuota && quota.oldest !== null) {
		const retryAt = Number(quota.oldest) + DAY_MS;
		throw new ApiFail(429, 'publication_quota_exceeded', 'Daily publication quota reached', {
			retry_at: retryAt,
			retry_after_seconds: Math.max(1, Math.ceil((retryAt - now) / 1000))
		});
	}
	throw new ApiFail(409, 'publication_proof_stale', 'The source or publication proof changed');
}

/** Owner-scoped result lookup; it never returns candidate or snapshot bytes. */
export async function getPublicationResult(
	db: Kysely<Database>,
	actor: ActorContext,
	candidateId: string
): Promise<PublicationOwnerResult> {
	requireAccess(actor, [{ domain: 'control_plane', access: 'read' }], 'publication.read');
	const row = await candidateRow(db, actor.userId, candidateId);
	if (!row) throw new ApiFail(404, 'not_found', 'Not found');
	return parseReceipt(row);
}

export async function listPublications(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	options: { workflowId?: string; page?: Page } = {}
): Promise<ListResponse<PublicationOwnerItem>> {
	requireAccess(actor, [{ domain: 'control_plane', access: 'read' }], 'publication.read');
	const page = options.page ?? { cursor: null, limit: 100 };
	let query = db
		.selectFrom('workflow_publication')
		.leftJoin(
			'workflow_publisher_status',
			'workflow_publisher_status.user_id',
			'workflow_publication.user_id'
		)
		.select([
			'workflow_publication.id',
			'workflow_publication.snapshot_id',
			'workflow_publication.published_at',
			'workflow_publication.metadata_json',
			'workflow_publication.source_workflow_id',
			'workflow_publication.owner_state',
			'workflow_publication.host_state',
			'workflow_publication.status_version',
			'workflow_publication.document_digest',
			'workflow_publication.bytes_sha256',
			'workflow_publication.review_digest',
			'workflow_publication.host_decision_reason',
			'workflow_publication.host_decision_reference',
			'workflow_publisher_status.suspended',
			'workflow_publisher_status.decision_reason as suspension_reason',
			'workflow_publisher_status.decision_reference as suspension_reference'
		])
		.where('workflow_publication.user_id', '=', actor.userId)
		.where('workflow_publication.published_at', 'is not', null)
		.orderBy('workflow_publication.published_at', 'desc')
		.orderBy('workflow_publication.id', 'asc')
		.limit(page.limit + 1);
	if (options.workflowId)
		query = query.where('workflow_publication.source_workflow_id', '=', options.workflowId);
	if (page.cursor)
		query = query.where((eb) =>
			eb.or([
				eb('workflow_publication.published_at', '<', page.cursor!.createdAt),
				eb.and([
					eb('workflow_publication.published_at', '=', page.cursor!.createdAt),
					eb('workflow_publication.id', '>', page.cursor!.id)
				])
			])
		);
	const origin = publicOrigin(env);
	const rows = await query.execute();
	const selected = rows.slice(0, page.limit);
	const items: PublicationOwnerItem[] = selected.map((row) => ({
		candidate_id: row.id,
		snapshot_id: row.snapshot_id!,
		public_url: `${origin}/p/${row.snapshot_id}`,
		published_at: row.published_at!,
		metadata: JSON.parse(row.metadata_json),
		source_workflow_id: row.source_workflow_id,
		owner_state: row.owner_state === 'withdrawn' ? 'withdrawn' : 'published',
		host_state: row.host_state,
		status_version: row.status_version,
		document_digest: row.document_digest,
		bytes_sha256: row.bytes_sha256,
		review_digest: row.review_digest,
		host_removal:
			row.host_state === 'removed' && row.host_decision_reason && row.host_decision_reference
				? { reason: row.host_decision_reason, reference: row.host_decision_reference }
				: null,
		suspension:
			row.suspended === 1 && row.suspension_reason && row.suspension_reference
				? { reason: row.suspension_reason, reference: row.suspension_reference }
				: null
	}));
	const last = selected.at(-1);
	return {
		items,
		next_cursor: rows.length > page.limit && last ? encodeCursor(last.published_at!, last.id) : null
	};
}

/** Owner-only active host status. Contains no report or moderator data. */
export async function getPublisherSuspension(db: Kysely<Database>, actor: ActorContext) {
	const row = await db
		.selectFrom('workflow_publisher_status')
		.select(['suspended', 'decision_reason', 'decision_reference'])
		.where('user_id', '=', actor.userId)
		.executeTakeFirst();
	return row?.suspended === 1 && row.decision_reason && row.decision_reference
		? { reason: row.decision_reason, reference: row.decision_reference }
		: null;
}

async function publicationBySnapshot(
	db: Kysely<Database>,
	userId: string,
	snapshotId: string
): Promise<CandidateRow> {
	const row = (await db
		.selectFrom('workflow_publication')
		.selectAll()
		.where('user_id', '=', userId)
		.where('snapshot_id', '=', snapshotId)
		.executeTakeFirst()) as CandidateRow | undefined;
	if (!row) throw new ApiFail(404, 'not_found', 'Not found');
	return row;
}

async function changeOwnerState(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	snapshotId: string,
	target: 'published' | 'withdrawn',
	now: number
): Promise<PublicationOwnerResult> {
	requireAccess(
		actor,
		[{ domain: 'control_plane', access: 'write' }],
		target === 'published' ? 'publication.restore' : 'publication.withdraw'
	);
	if (actor.agentRunId) throw runKeyForbidden();
	const row = await publicationBySnapshot(db, actor.userId, snapshotId);
	if (row.owner_state === target) return parseReceipt(row);
	if (target === 'withdrawn' && row.owner_state !== 'published')
		throw new ApiFail(409, 'publication_state_changed', 'Publication state changed; refresh');
	if (target === 'published') {
		const config = publicationConfig(env);
		if (!config.valid || !config.enabled)
			throw new ApiFail(
				503,
				'publication_disabled',
				config.error ?? 'Public workflow publishing is not enabled on this host'
			);
		if (row.owner_state !== 'withdrawn')
			throw new ApiFail(409, 'publication_state_changed', 'Publication state changed; refresh');
		if (row.host_state !== 'active')
			throw new ApiFail(403, 'publication_host_removed', 'This publication cannot be restored');
		const parsed = await parsePublicWorkflowDocument(row.document_json);
		if (
			parsed.diagnostics.length ||
			parsed.canonical_json !== row.document_json ||
			parsed.document.digest !== row.document_digest ||
			parsed.bytes_sha256 !== row.bytes_sha256 ||
			row.policy_version !== PUBLIC_WORKFLOW_POLICY_VERSION ||
			row.byte_length > config.maxBytes
		)
			throw new ApiFail(409, 'publication_policy_changed', 'This snapshot cannot be restored');
	}

	const nonce = newId('pst');
	const nextVersion = row.status_version + 1;
	const action = target === 'published' ? 'restored' : 'withdrawn';
	const eventId = newId('evt');
	const publisherStatusVersion = sql<number>`COALESCE((SELECT status_version FROM workflow_publisher_status WHERE user_id = ${actor.userId}), 0)`;
	const availabilityGuard =
		target === 'published'
			? sql<boolean>`host_state = 'active' AND NOT EXISTS (
				SELECT 1 FROM workflow_publisher_status WHERE user_id = ${actor.userId} AND suspended = 1
			)`
			: sql<boolean>`1`;
	const results = await runAtomic(env, [
		sql`UPDATE workflow_publication SET owner_state = ${target}, status_version = ${nextVersion},
			attempt_nonce = ${nonce}
		WHERE id = ${row.id} AND user_id = ${actor.userId} AND owner_state = ${row.owner_state}
			AND status_version = ${row.status_version} AND ${availabilityGuard}`.compile(db),
		sql`INSERT INTO workflow_publication_event
			(id, publication_id, snapshot_id, user_id, actor_key, action,
			 publication_status_version, publisher_status_version, reason, reference, created_at)
		SELECT ${eventId}, id, snapshot_id, user_id, ${packageActorKey(actor)}, ${action},
			status_version, ${publisherStatusVersion}, NULL, NULL, ${now}
		FROM workflow_publication WHERE id = ${row.id} AND attempt_nonce = ${nonce}`.compile(db),
		sql`SELECT publication_receipt_json, snapshot_id, published_at, owner_state, host_state,
			status_version, id, user_id, actor_key, source_kind, source_provenance_json,
			document_json, document_digest, bytes_sha256, byte_length, metadata_json,
			review_digest, policy_version, expires_at
		FROM workflow_publication WHERE id = ${row.id} AND attempt_nonce = ${nonce}`.compile(db)
	]);
	const changed = results.at(-1)?.results?.[0] as CandidateRow | undefined;
	if (changed) return parseReceipt(changed);
	const current = await publicationBySnapshot(db, actor.userId, snapshotId);
	if (current.owner_state === target) return parseReceipt(current);
	if (target === 'published')
		throw new ApiFail(403, 'publication_unavailable', 'This publication cannot be restored');
	throw new ApiFail(409, 'publication_state_changed', 'Publication state changed; refresh');
}

export const withdrawPublication = (
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	snapshotId: string,
	now = Date.now()
) => changeOwnerState(db, env, actor, snapshotId, 'withdrawn', now);

export const restorePublication = (
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	snapshotId: string,
	now = Date.now()
) => changeOwnerState(db, env, actor, snapshotId, 'published', now);
