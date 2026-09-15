import { beforeEach, describe, expect, it } from 'vitest';
import {
	canonicalizeLibraryValue,
	publicationBytesSha256,
	publicationReviewDigest,
	withLibraryDocumentDigest
} from '@tines/shared';
import { inheritedPackage } from '../../../../../../packages/shared/src/library/fixtures';
import { createTestDb, type TestDb } from '../api/test-db';
import { USER, seedBase } from '../supervisor/test-fixtures';
import { acceptPublicationReport } from './reports';
import { decideModeration, inspectModerationSnapshot, listModerationCases } from './moderation';
import { resolvePublicSnapshot } from './public';

const SNAPSHOT = 'pubs_moderation_1234567890';
const NOW = 1_800_000_000_000;
const envFor = (t: TestDb) =>
	({
		...t.env,
		PUBLIC_WORKFLOW_MODERATOR_USER_IDS: USER,
		PUBLIC_WORKFLOW_REPORT_HMAC_SECRET: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
		PUBLIC_WORKFLOW_APPEAL_CONTACT: 'mailto:appeals@example.test'
	}) as Env;
const moderator = {
	userId: USER,
	userName: 'Alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true,
	agentRunId: null
};
let t: TestDb;

async function seedPublication(policyVersion = 1) {
	const document = await withLibraryDocumentDigest(inheritedPackage());
	const documentJson = canonicalizeLibraryValue(document);
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
			document_digest: document.digest,
			bytes_sha256: bytesSha256,
			byte_length: new TextEncoder().encode(documentJson).byteLength,
			metadata_json: JSON.stringify(metadata),
			review_digest: reviewDigest,
			policy_version: policyVersion,
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
}

beforeEach(async () => {
	t = createTestDb();
	seedBase(t);
	await seedPublication();
});

describe('private workflow moderation', () => {
	it('accepts idempotently, groups exact-snapshot reports, and enforces the rolling quota', async () => {
		const env = envFor(t);
		const first = await acceptPublicationReport(
			t.db,
			env,
			SNAPSHOT,
			{
				request_id: '123e4567-e89b-42d3-a456-426614174000',
				reason: 'rights',
				note: 'Same details'
			},
			{ network: '192.0.2.1' },
			NOW
		);
		const retry = await acceptPublicationReport(
			t.db,
			env,
			SNAPSHOT,
			{
				request_id: '123e4567-e89b-42d3-a456-426614174000',
				reason: 'rights',
				note: 'Same details'
			},
			{ network: '192.0.2.1' },
			NOW + 1
		);
		expect(first.status).toBe(201);
		expect(retry).toMatchObject({ status: 200, body: first.body });
		for (let index = 1; index < 5; index++) {
			await acceptPublicationReport(
				t.db,
				env,
				SNAPSHOT,
				{
					request_id: `123e4567-e89b-42d3-a456-42661417400${index}`,
					reason: 'rights',
					note: 'Same details'
				},
				{ network: '192.0.2.1' },
				NOW + index
			);
		}
		await expect(
			acceptPublicationReport(
				t.db,
				env,
				SNAPSHOT,
				{
					request_id: '123e4567-e89b-42d3-a456-426614174009',
					reason: 'other'
				},
				{ network: '192.0.2.1' },
				NOW + 9
			)
		).rejects.toMatchObject({ status: 429, code: 'report_rate_limited' });
		expect(await t.db.selectFrom('workflow_report').selectAll().execute()).toHaveLength(5);
		const queue = await listModerationCases(t.db, env, moderator);
		expect(queue.items[0]).toMatchObject({
			snapshot_id: SNAPSHOT,
			total: 5,
			reason_counts: { rights: 5 }
		});
		const detail = await inspectModerationSnapshot(t.db, env, moderator, SNAPSHOT);
		expect(detail.reports).toMatchObject([{ reason: 'rights', note: 'Same details', count: 5 }]);
	});

	it('audits disable, restore, suspension and recovery while preserving independent states', async () => {
		const env = envFor(t);
		const request = (
			request_id: string,
			action: 'disable' | 'restore' | 'suspend' | 'unsuspend',
			target: { snapshot_id?: string; publisher_id?: string },
			version: number
		) => ({
			request_id,
			action,
			target,
			reason: `${action} reason`,
			...(action === 'suspend' || action === 'unsuspend'
				? { expected_publisher_version: version }
				: { expected_snapshot_version: version })
		});
		await decideModeration(
			t.db,
			env,
			moderator,
			request('123e4567-e89b-42d3-a456-426614174001', 'disable', { snapshot_id: SNAPSHOT }, 1),
			NOW
		);
		expect(await resolvePublicSnapshot(t.db, SNAPSHOT)).toBeNull();
		await decideModeration(
			t.db,
			env,
			moderator,
			request('123e4567-e89b-42d3-a456-426614174002', 'restore', { snapshot_id: SNAPSHOT }, 2),
			NOW + 1
		);
		expect(await resolvePublicSnapshot(t.db, SNAPSHOT)).not.toBeNull();
		await decideModeration(
			t.db,
			env,
			moderator,
			request(
				'123e4567-e89b-42d3-a456-426614174003',
				'suspend',
				{ publisher_id: USER, snapshot_id: SNAPSHOT },
				0
			),
			NOW + 2
		);
		expect(await resolvePublicSnapshot(t.db, SNAPSHOT)).toBeNull();
		await decideModeration(
			t.db,
			env,
			moderator,
			request(
				'123e4567-e89b-42d3-a456-426614174004',
				'unsuspend',
				{ publisher_id: USER, snapshot_id: SNAPSHOT },
				1
			),
			NOW + 3
		);
		expect(await resolvePublicSnapshot(t.db, SNAPSHOT)).not.toBeNull();
		expect(await t.db.selectFrom('workflow_moderation_audit').selectAll().execute()).toHaveLength(
			4
		);
	});

	it('denies keys and unconfigured sessions before host data access', async () => {
		await expect(
			listModerationCases(t.db, envFor(t), { ...moderator, viaSession: false, apiKeyId: 'key_1' })
		).rejects.toMatchObject({ status: 403 });
		await expect(
			listModerationCases(
				t.db,
				{ ...envFor(t), PUBLIC_WORKFLOW_MODERATOR_USER_IDS: 'someone_else' },
				moderator
			)
		).rejects.toMatchObject({ status: 403 });
	});

	it('resolves only an observed case cutoff and rejects a second decision', async () => {
		const env = envFor(t);
		await acceptPublicationReport(
			t.db,
			env,
			SNAPSHOT,
			{
				request_id: '123e4567-e89b-42d3-a456-426614174010',
				reason: 'other'
			},
			{ network: '192.0.2.8' },
			NOW
		);
		await decideModeration(
			t.db,
			env,
			moderator,
			{
				request_id: '123e4567-e89b-42d3-a456-426614174011',
				action: 'dismiss',
				target: { snapshot_id: SNAPSHOT },
				reason: 'Reviewed',
				case_through_version: 1
			},
			NOW + 1
		);
		await expect(
			decideModeration(
				t.db,
				env,
				moderator,
				{
					request_id: '123e4567-e89b-42d3-a456-426614174012',
					action: 'dismiss',
					target: { snapshot_id: SNAPSHOT },
					reason: 'Duplicate',
					case_through_version: 1
				},
				NOW + 2
			)
		).rejects.toMatchObject({ status: 409, code: 'moderation_state_changed' });
	});

	it('reconciles concurrent identical decisions to one durable receipt', async () => {
		const input = {
			request_id: '123e4567-e89b-42d3-a456-426614174020',
			action: 'disable' as const,
			target: { snapshot_id: SNAPSHOT },
			reason: 'Urgent removal',
			expected_snapshot_version: 1
		};
		const [first, second] = await Promise.all([
			decideModeration(t.db, envFor(t), moderator, input, NOW),
			decideModeration(t.db, envFor(t), moderator, input, NOW)
		]);
		expect(second).toEqual(first);
		expect(await t.db.selectFrom('workflow_moderation_audit').selectAll().execute()).toHaveLength(
			1
		);
	});

	it('keeps a deleted-snapshot report case inspectable and dismissible', async () => {
		await acceptPublicationReport(
			t.db,
			envFor(t),
			SNAPSHOT,
			{
				request_id: '123e4567-e89b-42d3-a456-426614174021',
				reason: 'private_information',
				note: 'Retained evidence'
			},
			{ network: '192.0.2.21' },
			NOW
		);
		await t.db.deleteFrom('workflow_publication').where('snapshot_id', '=', SNAPSHOT).execute();
		const detail = await inspectModerationSnapshot(t.db, envFor(t), moderator, SNAPSHOT);
		expect(detail).toMatchObject({ stored: false, publisher_id: null });
		expect(detail.reports).toMatchObject([{ note: 'Retained evidence' }]);
		await expect(
			decideModeration(
				t.db,
				envFor(t),
				moderator,
				{
					request_id: '123e4567-e89b-42d3-a456-426614174022',
					action: 'dismiss',
					target: { snapshot_id: SNAPSHOT },
					reason: 'Reviewed retained evidence',
					case_through_version: 1
				},
				NOW + 1
			)
		).resolves.toMatchObject({ action: 'dismiss' });
	});

	it('refuses host restore when immutable content is no longer current-policy content', async () => {
		await t.db.deleteFrom('workflow_publication').where('snapshot_id', '=', SNAPSHOT).execute();
		await seedPublication(0);
		const disabled = await decideModeration(
			t.db,
			envFor(t),
			moderator,
			{
				request_id: '123e4567-e89b-42d3-a456-426614174023',
				action: 'disable',
				target: { snapshot_id: SNAPSHOT },
				reason: 'Remove first',
				expected_snapshot_version: 1
			},
			NOW
		);
		expect(disabled.action).toBe('disable');
		await expect(
			decideModeration(
				t.db,
				envFor(t),
				moderator,
				{
					request_id: '123e4567-e89b-42d3-a456-426614174024',
					action: 'restore',
					target: { snapshot_id: SNAPSHOT },
					reason: 'Restore stale policy',
					expected_snapshot_version: 2
				},
				NOW + 1
			)
		).rejects.toMatchObject({ status: 409, code: 'publication_policy_changed' });
		expect(await resolvePublicSnapshot(t.db, SNAPSHOT)).toBeNull();
	});
});
