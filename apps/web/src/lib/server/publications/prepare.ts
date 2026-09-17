import {
	canonicalizeLibraryValue,
	diagnosticOf,
	parseLibraryV3Document,
	parsePublicWorkflowDocument,
	publicationReviewDigest,
	validatePublicationMetadata,
	PUBLICATION_CANDIDATE_TTL_MS,
	PUBLIC_WORKFLOW_POLICY_VERSION,
	type PreparePublicationRequest,
	type PublicationMetadata,
	type PublicationProof,
	type WorkflowPackageDocument
} from '@tines/shared';
import { sql, type Kysely } from 'kysely';
import { newId, type Database } from '$lib/server/db';
import { sha256Hex } from '$lib/server/crypto';
import { ApiFail, runAtomic, type ActorContext } from '../api/core';
import { packageActorKey } from '../library/token';
import { validatePortableLibrary } from '../library/validate';
import { publicationConfig } from './config';
import { deriveOwnedPublicationDraft, PublicationDraftError } from './draft';
import { buildOwnedPublicationSourceProof } from './source';

const MAX_PRIVATE_VALUE_BYTES = 64 * 1024;
const MAX_SOURCE_WITNESS_BYTES = 1024 * 1024;
const MAX_LIVE_CANDIDATES = 20;
const utf8Length = (value: string) => new TextEncoder().encode(value).byteLength;

function invalidMetadata(value: PublicationMetadata): PublicationMetadata {
	try {
		return validatePublicationMetadata(value);
	} catch (error) {
		throw new ApiFail(
			422,
			'invalid_publication_metadata',
			error instanceof Error ? error.message : 'Invalid publication metadata'
		);
	}
}

function proofFromRow(row: {
	id: string;
	expires_at: number;
	byte_length: number;
	metadata_json: string;
	document_json: string;
	document_digest: string;
	bytes_sha256: string;
	review_digest: string;
}): PublicationProof {
	return {
		candidate_id: row.id,
		expires_at: row.expires_at,
		byte_length: row.byte_length,
		metadata: JSON.parse(row.metadata_json) as PublicationMetadata,
		document: JSON.parse(row.document_json) as WorkflowPackageDocument,
		document_digest: row.document_digest,
		bytes_sha256: row.bytes_sha256,
		review_digest: row.review_digest
	};
}

/** Actor-bound, retryable preparation. It never allocates a public snapshot ID. */
export async function preparePublication(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	request: PreparePublicationRequest,
	now = Date.now()
): Promise<PublicationProof> {
	const config = publicationConfig(env);
	if (!config.valid || !config.enabled)
		throw new ApiFail(
			503,
			'publication_disabled',
			config.error ?? 'Public workflow publishing is not enabled on this host'
		);
	if (
		typeof request.prepare_request_id !== 'string' ||
		request.prepare_request_id.length < 1 ||
		request.prepare_request_id.length > 100
	)
		throw new ApiFail(422, 'invalid_field', 'prepare_request_id must be 1–100 characters');
	const metadata = invalidMetadata(request.metadata);
	const requestHash = `sha256:${await sha256Hex(
		`TINES-PUBLICATION-PREPARE\u0000${canonicalizeLibraryValue(request)}`
	)}`;
	const existing = await db
		.selectFrom('workflow_publication')
		.select([
			'id',
			'expires_at',
			'byte_length',
			'metadata_json',
			'document_json',
			'document_digest',
			'bytes_sha256',
			'review_digest',
			'prepare_request_hash',
			'actor_key'
		])
		.where('user_id', '=', actor.userId)
		.where('prepare_request_id', '=', request.prepare_request_id)
		.executeTakeFirst();
	if (existing) {
		if (
			existing.prepare_request_hash !== requestHash ||
			existing.actor_key !== packageActorKey(actor)
		)
			throw new ApiFail(
				409,
				'prepare_request_conflict',
				'prepare_request_id was already used for different publication content'
			);
		return proofFromRow(existing);
	}

	let document: WorkflowPackageDocument;
	let documentJson: string;
	let witnessRaw: string;
	let witnessFingerprint: string;
	let provenance: unknown;
	let selection: unknown;
	let sourceWorkflowId: string | null = null;
	if (request.source.kind === 'owned_workflow') {
		const draft = request.source.draft;
		if (draft && Object.hasOwn(request.source.options, 'authoring'))
			throw new ApiFail(
				422,
				'invalid_publication_source',
				'Draft publication options cannot contain authoring'
			);
		const built = await buildOwnedPublicationSourceProof(
			db,
			actor.userId,
			request.source.workflow_id,
			request.source.options,
			draft?.baseline.exported_at ?? now
		);
		if (draft && built.document.digest !== draft.baseline.document_digest)
			throw new ApiFail(
				409,
				'publication_source_changed',
				'The source changed; review the latest source before sharing'
			);
		if (draft) {
			if (utf8Length(draft.document_json) > 1024 * 1024)
				throw new ApiFail(413, 'publication_too_large', 'Publication draft exceeds 1048576 bytes');
			let submitted: WorkflowPackageDocument;
			try {
				const parsedDraft = await parseLibraryV3Document(draft.document_json);
				if (parsedDraft.profile !== 'workflow') throw new Error('Expected workflow profile');
				submitted = parsedDraft;
			} catch (error) {
				throw new ApiFail(422, 'invalid_publication_draft', 'Publication draft needs repair', {
					diagnostics: diagnosticOf(error)
				});
			}
			try {
				document = await deriveOwnedPublicationDraft(built.document, submitted, now);
			} catch (error) {
				if (error instanceof PublicationDraftError)
					throw new ApiFail(422, 'publication_draft_forbidden_change', error.message, {
						diagnostics: [{ path: error.path, code: 'forbidden_change', message: error.message }]
					});
				throw error;
			}
			const validation = await validatePortableLibrary(canonicalizeLibraryValue(document));
			if (!validation.valid)
				throw new ApiFail(422, 'invalid_publication_draft', 'Publication draft needs repair', {
					diagnostics: validation.diagnostics
				});
		} else document = built.document;
		documentJson = canonicalizeLibraryValue(document);
		witnessRaw = built.witnessRaw;
		witnessFingerprint = built.witnessFingerprint;
		selection = {
			kind: 'owned_workflow',
			options: request.source.options,
			...(draft ? { draft_version: 1 } : {})
		};
		provenance = {
			kind: 'owned_workflow',
			workflow_id: request.source.workflow_id,
			options: request.source.options,
			exported_at: now,
			...(draft
				? {
						draft_version: 1,
						baseline: {
							document_digest: draft.baseline.document_digest,
							exported_at: draft.baseline.exported_at
						}
					}
				: {})
		};
		sourceWorkflowId = request.source.workflow_id;
	} else if (request.source.kind === 'file') {
		const parsed = await parsePublicWorkflowDocument(request.source.document_json);
		document = parsed.document;
		documentJson = parsed.canonical_json;
		witnessRaw = canonicalizeLibraryValue({
			kind: 'file',
			document_digest: document.digest,
			bytes_sha256: parsed.bytes_sha256
		});
		witnessFingerprint = `sha256:${await sha256Hex(witnessRaw)}`;
		selection = JSON.parse(witnessRaw);
		provenance = selection;
	} else {
		throw new ApiFail(422, 'invalid_publication_source', 'Unknown publication source');
	}
	const parsed = await parsePublicWorkflowDocument(documentJson);
	if (parsed.diagnostics.length)
		throw new ApiFail(422, 'public_content_rejected', 'Public content needs repair', {
			diagnostics: parsed.diagnostics
		});
	if (parsed.byte_length > config.maxBytes)
		throw new ApiFail(
			413,
			'publication_too_large',
			`Public workflow exceeds ${config.maxBytes} bytes`
		);
	const provenanceJson = canonicalizeLibraryValue(provenance);
	if (utf8Length(provenanceJson) > MAX_PRIVATE_VALUE_BYTES)
		throw new ApiFail(422, 'publication_too_complex', 'Publication provenance is too large');
	if (utf8Length(witnessRaw) > MAX_SOURCE_WITNESS_BYTES)
		throw new ApiFail(422, 'publication_too_complex', 'Publication source witness is too large');

	await runAtomic(env, [
		sql`DELETE FROM workflow_publication WHERE id IN (
			SELECT id FROM workflow_publication WHERE user_id = ${actor.userId}
				AND published_at IS NULL AND expires_at <= ${now} ORDER BY expires_at, id LIMIT 20
		)`.compile(db)
	]);
	const live = await db
		.selectFrom('workflow_publication')
		.select((eb) => eb.fn.countAll<number>().as('n'))
		.where('user_id', '=', actor.userId)
		.where('published_at', 'is', null)
		.where('expires_at', '>', now)
		.executeTakeFirstOrThrow();
	if (Number(live.n) >= MAX_LIVE_CANDIDATES)
		throw new ApiFail(
			429,
			'publication_candidate_limit',
			'Review or wait for an existing publication proof before preparing another'
		);

	const candidateId = newId('pub');
	const reviewDigest = await publicationReviewDigest({
		candidate_id: candidateId,
		bytes_sha256: parsed.bytes_sha256,
		metadata,
		source_witness_sha256: witnessFingerprint,
		selection
	});
	const expiresAt = now + PUBLICATION_CANDIDATE_TTL_MS;
	await runAtomic(env, [
		db
			.insertInto('workflow_publication')
			.values({
				id: candidateId,
				user_id: actor.userId,
				actor_key: packageActorKey(actor),
				prepare_request_id: request.prepare_request_id,
				prepare_request_hash: requestHash,
				source_workflow_id: sourceWorkflowId,
				source_kind: request.source.kind,
				source_provenance_json: provenanceJson,
				document_json: parsed.canonical_json,
				document_digest: document.digest,
				bytes_sha256: parsed.bytes_sha256,
				byte_length: parsed.byte_length,
				metadata_json: canonicalizeLibraryValue(metadata),
				review_digest: reviewDigest,
				policy_version: PUBLIC_WORKFLOW_POLICY_VERSION,
				created_at: now,
				expires_at: expiresAt,
				snapshot_id: null,
				published_at: null,
				owner_state: 'candidate',
				host_state: 'active',
				status_version: 1,
				confirmed_at: null,
				confirmed_actor_key: null,
				publication_receipt_json: null,
				attempt_nonce: null,
				host_decision_reason: null,
				host_decision_reference: null
			})
			.compile(),
		db
			.insertInto('workflow_publication_source')
			.values({
				publication_id: candidateId,
				source_witness_json: witnessRaw,
				source_fingerprint: witnessFingerprint
			})
			.compile()
	]);
	return {
		candidate_id: candidateId,
		expires_at: expiresAt,
		byte_length: parsed.byte_length,
		metadata,
		document,
		document_digest: document.digest,
		bytes_sha256: parsed.bytes_sha256,
		review_digest: reviewDigest
	};
}
