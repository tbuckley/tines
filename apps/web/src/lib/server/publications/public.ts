import {
	parsePublicWorkflowDocument,
	validatePublicationMetadata,
	type PublicWorkflowSnapshot,
	type PublicationMetadata
} from '@tines/shared';
import type { Kysely } from 'kysely';
import type { Database } from '$lib/server/db';

export const PUBLICATION_UNAVAILABLE_MESSAGE = 'This publication is not available.';

export const PUBLICATION_RESPONSE_HEADERS = {
	'cache-control': 'no-store, max-age=0',
	'content-security-policy':
		"img-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
	'referrer-policy': 'no-referrer',
	'x-content-type-options': 'nosniff'
} as const;

export async function withPublicationHeaders(
	responsePromise: Promise<Response>
): Promise<Response> {
	const response = await responsePromise;
	for (const [name, value] of Object.entries(PUBLICATION_RESPONSE_HEADERS))
		response.headers.set(name, value);
	response.headers.delete('etag');
	return response;
}

export async function resolvePublicSnapshot(
	db: Kysely<Database>,
	snapshotId: string
): Promise<PublicWorkflowSnapshot | null> {
	const row = await db
		.selectFrom('workflow_publication')
		.leftJoin(
			'workflow_publisher_status',
			'workflow_publisher_status.user_id',
			'workflow_publication.user_id'
		)
		.select([
			'workflow_publication.snapshot_id',
			'workflow_publication.metadata_json',
			'workflow_publication.document_json',
			'workflow_publication.document_digest',
			'workflow_publication.bytes_sha256',
			'workflow_publication.review_digest',
			'workflow_publication.published_at',
			'workflow_publication.status_version',
			'workflow_publisher_status.status_version as publisher_status_version'
		])
		.where('workflow_publication.snapshot_id', '=', snapshotId)
		.where('workflow_publication.owner_state', '=', 'published')
		.where('workflow_publication.host_state', '=', 'active')
		.where((eb) =>
			eb.or([
				eb('workflow_publisher_status.suspended', 'is', null),
				eb('workflow_publisher_status.suspended', '=', 0)
			])
		)
		.executeTakeFirst();
	if (!row?.snapshot_id || row.published_at === null) return null;
	try {
		const parsed = await parsePublicWorkflowDocument(row.document_json);
		if (parsed.diagnostics.length > 0) return null;
		if (
			parsed.document.digest !== row.document_digest ||
			parsed.bytes_sha256 !== row.bytes_sha256 ||
			parsed.canonical_json !== row.document_json
		)
			return null;
		const metadata = validatePublicationMetadata(
			JSON.parse(row.metadata_json) as PublicationMetadata
		);
		return {
			snapshot_id: row.snapshot_id,
			metadata,
			published_at: row.published_at,
			status_version: row.status_version,
			document_digest: row.document_digest,
			bytes_sha256: row.bytes_sha256,
			review_digest: row.review_digest,
			document: parsed.document
		};
	} catch {
		return null;
	}
}

export async function resolvePublicSnapshotStatus(db: Kysely<Database>, snapshotId: string) {
	const row = await db
		.selectFrom('workflow_publication')
		.leftJoin(
			'workflow_publisher_status',
			'workflow_publisher_status.user_id',
			'workflow_publication.user_id'
		)
		.select([
			'workflow_publication.status_version',
			'workflow_publisher_status.status_version as publisher_status_version'
		])
		.where('workflow_publication.snapshot_id', '=', snapshotId)
		.where('workflow_publication.owner_state', '=', 'published')
		.where('workflow_publication.host_state', '=', 'active')
		.where((eb) =>
			eb.or([
				eb('workflow_publisher_status.suspended', 'is', null),
				eb('workflow_publisher_status.suspended', '=', 0)
			])
		)
		.executeTakeFirst();
	return row
		? {
				available: true as const,
				status_version: row.status_version,
				publisher_status_version: row.publisher_status_version ?? 0
			}
		: null;
}

/** Internal hosted-install resolution. A mismatched pair fails closed; commit still rechecks in SQL. */
export async function resolveHostedPublicSnapshot(db: Kysely<Database>, snapshotId: string) {
	const [snapshot, status] = await Promise.all([
		resolvePublicSnapshot(db, snapshotId),
		resolvePublicSnapshotStatus(db, snapshotId)
	]);
	if (!snapshot || !status || snapshot.status_version !== status.status_version) return null;
	return {
		snapshot,
		source: {
			kind: 'hosted_publication' as const,
			snapshot_id: snapshot.snapshot_id,
			document_digest: snapshot.document_digest,
			bytes_sha256: snapshot.bytes_sha256,
			snapshot_status_version: status.status_version,
			publisher_status_version: status.publisher_status_version
		}
	};
}
