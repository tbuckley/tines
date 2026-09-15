import { beforeEach, describe, expect, it } from 'vitest';
import {
	canonicalizeLibraryValue,
	publicationBytesSha256,
	publicationReviewDigest,
	withLibraryDocumentDigest
} from '@tines/shared';
import { inheritedPackage } from '../../../../../../../../../packages/shared/src/library/fixtures';
import { createTestDb, type TestDb } from '$lib/server/api/test-db';
import { seedBase, USER } from '$lib/server/supervisor/test-fixtures';
import { GET as detail } from './+server';
import { GET as download } from './download/+server';
import { GET as reuse } from './reuse.txt/+server';
import { GET as status } from './status/+server';

const SNAPSHOT = 'snapshot_12345678901234567890';
const MARKER = 'unique-private-publication-marker';
let t: TestDb;

async function seedPublication() {
	const document = inheritedPackage();
	document.workflows[0].description += ` ${MARKER}`;
	const sealed = await withLibraryDocumentDigest(document);
	const documentJson = canonicalizeLibraryValue(sealed);
	const bytesSha256 = await publicationBytesSha256(documentJson);
	const metadata = { display_name: 'Example Team', license: 'MIT' as const, license_year: 2026 };
	const reviewDigest = await publicationReviewDigest({
		candidate_id: 'pub_candidate',
		bytes_sha256: bytesSha256,
		metadata,
		source_witness_sha256: `sha256:${'0'.repeat(64)}`,
		selection: {}
	});
	await t.db
		.insertInto('workflow_publication')
		.values({
			id: 'pub_candidate',
			user_id: USER,
			actor_key: 'session:test',
			prepare_request_id: 'prepare:1',
			prepare_request_hash: `sha256:${'3'.repeat(64)}`,
			source_workflow_id: null,
			source_kind: 'file',
			source_provenance_json: '{}',
			document_json: documentJson,
			document_digest: sealed.digest,
			bytes_sha256: bytesSha256,
			byte_length: new TextEncoder().encode(documentJson).byteLength,
			metadata_json: JSON.stringify(metadata),
			review_digest: reviewDigest,
			policy_version: 1,
			created_at: 1,
			expires_at: 2,
			snapshot_id: SNAPSHOT,
			published_at: 1,
			owner_state: 'published',
			host_state: 'active',
			status_version: 1,
			confirmed_at: 1,
			confirmed_actor_key: 'session:test',
			publication_receipt_json: '{}',
			attempt_nonce: 'attempt',
			host_decision_reason: null,
			host_decision_reference: null
		})
		.execute();
	return { documentJson };
}

function event(path = '') {
	return {
		platform: { env: t.env, ctx: { waitUntil: () => {} } },
		params: { snapshotId: SNAPSHOT },
		url: new URL(`http://test/api/v1/publications/public/${SNAPSHOT}${path}`),
		request: new Request(`http://test/api/v1/publications/public/${SNAPSHOT}${path}`)
	};
}

beforeEach(() => {
	t = createTestDb();
	seedBase(t);
});

describe('anonymous publication reads', () => {
	it('returns only the selected DTO and byte-exact package with no caching', async () => {
		const { documentJson } = await seedPublication();
		const shown = await detail(event() as unknown as Parameters<typeof detail>[0]);
		expect(shown.status).toBe(200);
		expect(shown.headers.get('cache-control')).toBe('no-store, max-age=0');
		const dto = await shown.json();
		expect(dto).toMatchObject({
			snapshot_id: SNAPSHOT,
			metadata: { display_name: 'Example Team' }
		});
		expect(JSON.stringify(dto)).not.toContain(USER);
		expect(dto).not.toHaveProperty('source_workflow_id');

		const file = await download(event('/download') as unknown as Parameters<typeof download>[0]);
		expect(await file.text()).toBe(documentJson);
		expect(file.headers.get('etag')).toBeNull();
		const notice = await reuse(event('/reuse.txt') as unknown as Parameters<typeof reuse>[0]);
		expect(await notice.text()).toContain('Copyright (c) 2026 Example Team');
		const current = await status(event('/status') as unknown as Parameters<typeof status>[0]);
		expect(await current.json()).toEqual({
			available: true,
			status_version: 1,
			publisher_status_version: 0
		});
	});

	it('uses the same neutral no-store response after withdrawal or suspension', async () => {
		await seedPublication();
		await t.db
			.updateTable('workflow_publication')
			.set({ owner_state: 'withdrawn', status_version: 2 })
			.where('snapshot_id', '=', SNAPSHOT)
			.execute();
		for (const handler of [detail, download, reuse, status]) {
			const response = await handler(event() as never);
			expect(response.status).toBe(404);
			expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
			expect(await response.text()).not.toContain(MARKER);
		}
	});
});
