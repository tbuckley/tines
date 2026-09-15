import { describe, expect, it } from 'vitest';
import {
	canonicalizeLibraryValue,
	parsePublicWorkflowDocument,
	withLibraryDocumentDigest
} from '@tines/shared';
import { inheritedPackage } from '../../../../../../packages/shared/src/library/fixtures';
import { createTestDb } from '../api/test-db';
import { deleteWorkflow } from '../api/workflows';
import { createContextItem } from '../api/context';
import { createWorkflow } from '../api/workflows';
import { decodeCursor } from '../api/core';
import { USER, addTwoStageWorkflow, seedBase } from '../supervisor/test-fixtures';
import { preparePublication } from './prepare';
import { buildOwnedPublicationSourceProof } from './source';
import { resolvePublicSnapshot } from './public';
import {
	getPublicationResult,
	listPublications,
	publishPublication,
	restorePublication,
	withdrawPublication
} from './publish';

const actor = {
	userId: USER,
	userName: 'Alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};
const envFor = (t: ReturnType<typeof createTestDb>, quota = 10) =>
	({
		...t.env,
		PUBLIC_WORKFLOW_PUBLISHING_ENABLED: 'true',
		PUBLIC_WORKFLOW_MODERATOR_USER_IDS: USER,
		PUBLIC_WORKFLOW_REPORT_HMAC_SECRET: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
		PUBLIC_WORKFLOW_APPEAL_CONTACT: 'mailto:appeals@example.test',
		PUBLIC_WORKFLOW_MODERATION_QUEUE_READY: 'true',
		PUBLIC_WORKFLOW_MODERATION_JOURNEY_VERIFIED: 'true',
		PUBLIC_WORKFLOW_DAILY_QUOTA: String(quota),
		TINES_PUBLIC_URL: 'https://tines.example'
	}) as Env;

async function prepare(t: ReturnType<typeof createTestDb>, requestId = 'prepare-once') {
	return preparePublication(
		t.db,
		envFor(t),
		actor,
		{
			prepare_request_id: requestId,
			source: {
				kind: 'file',
				document_json: canonicalizeLibraryValue(await withLibraryDocumentDigest(inheritedPackage()))
			},
			metadata: { display_name: 'Example Team', license: 'MIT', license_year: 2026 }
		},
		1_000
	);
}

async function prepareDraft(t: ReturnType<typeof createTestDb>, requestId: string) {
	const workflow = await createWorkflow(t.db, t.env, actor, {
		name: `Draft ${requestId}`,
		description: 'reviewed source',
		initial_state: 'Open',
		states: [{ name: 'Open', category: 'active' }],
		transitions: []
	});
	const prompt = await createContextItem(t.db, t.env, actor, {
		kind: 'prompt',
		name: 'instructions',
		body: 'reviewed instructions',
		workflow_state_id: workflow.states[0].id
	});
	const baseline = await buildOwnedPublicationSourceProof(t.db, USER, workflow.id, {}, 1_000);
	const proof = await preparePublication(
		t.db,
		envFor(t),
		actor,
		{
			prepare_request_id: requestId,
			source: {
				kind: 'owned_workflow',
				workflow_id: workflow.id,
				options: {},
				draft: {
					version: 1,
					baseline: {
						document_digest: baseline.document.digest,
						exported_at: baseline.document.exported_at
					},
					document_json: canonicalizeLibraryValue(baseline.document)
				}
			},
			metadata: { display_name: 'Example Team', license: 'MIT', license_year: 2026 }
		},
		2_000
	);
	return { workflow, prompt, proof };
}

const confirmation = (proof: Awaited<ReturnType<typeof prepare>>) => ({
	review_digest: proof.review_digest,
	sharing_rights: true as const,
	exact_content: true as const,
	reviewed_repo_ids: proof.document.context
		.filter((item) => item.kind === 'repo')
		.map((item) => item.id)
});

describe('publication commit', () => {
	it('rejects a hash-consistent stored draft containing a forbidden delta', async () => {
		const t = createTestDb();
		seedBase(t);
		const { proof } = await prepareDraft(t, 'forbidden-stored-draft');
		const tampered = structuredClone(proof.document);
		tampered.workflows[0].name = 'Forbidden stored name';
		const sealed = await withLibraryDocumentDigest(tampered);
		const parsed = await parsePublicWorkflowDocument(canonicalizeLibraryValue(sealed));
		await t.db
			.updateTable('workflow_publication')
			.set({
				document_json: parsed.canonical_json,
				document_digest: parsed.document.digest,
				bytes_sha256: parsed.bytes_sha256,
				byte_length: parsed.byte_length
			})
			.where('id', '=', proof.candidate_id)
			.execute();

		await expect(
			publishPublication(t.db, envFor(t), actor, proof.candidate_id, confirmation(proof), 3_000)
		).rejects.toMatchObject({ status: 409, code: 'publication_proof_stale' });
		expect(await t.db.selectFrom('workflow_publication_event').selectAll().execute()).toEqual([]);
		expect(
			await t.db
				.selectFrom('workflow_publication')
				.select(['published_at', 'snapshot_id', 'publication_receipt_json'])
				.where('id', '=', proof.candidate_id)
				.executeTakeFirstOrThrow()
		).toEqual({ published_at: null, snapshot_id: null, publication_receipt_json: null });
	});

	it('rechecks a draft source inside the atomic publication commit', async () => {
		const t = createTestDb();
		seedBase(t);
		const { prompt, proof } = await prepareDraft(t, 'draft-atomic-source-guard');
		const realBatch = t.env.DB.batch.bind(t.env.DB);
		let intercepted = false;
		const env = {
			...envFor(t),
			DB: {
				...t.env.DB,
				batch: async (statements: Parameters<typeof realBatch>[0]) => {
					if (!intercepted) {
						intercepted = true;
						t.sqlite
							.prepare('UPDATE context_item SET body = ? WHERE id = ?')
							.run('changed inside commit', prompt.id);
					}
					return realBatch(statements);
				}
			}
		} as Env;

		await expect(
			publishPublication(t.db, env, actor, proof.candidate_id, confirmation(proof), 3_000)
		).rejects.toMatchObject({ status: 409, code: 'publication_proof_stale' });
		expect(intercepted).toBe(true);
		expect(await t.db.selectFrom('workflow_publication_event').selectAll().execute()).toEqual([]);
		expect(
			await t.db
				.selectFrom('workflow_publication')
				.select(['published_at', 'snapshot_id', 'publication_receipt_json'])
				.where('id', '=', proof.candidate_id)
				.executeTakeFirstOrThrow()
		).toEqual({ published_at: null, snapshot_id: null, publication_receipt_json: null });
	});

	it('pages owner snapshots without gaps across equal publication times', async () => {
		const t = createTestDb();
		seedBase(t);
		for (const [index, publishedAt] of [3_000, 3_000, 2_000, 1_000].entries()) {
			const proof = await prepare(t, `page-${index}`);
			await publishPublication(
				t.db,
				envFor(t),
				actor,
				proof.candidate_id,
				confirmation(proof),
				publishedAt
			);
		}
		const first = await listPublications(t.db, envFor(t), actor, {
			page: { cursor: null, limit: 2 }
		});
		expect(first.items).toHaveLength(2);
		expect(first.next_cursor).not.toBeNull();
		const second = await listPublications(t.db, envFor(t), actor, {
			page: { cursor: decodeCursor(first.next_cursor!), limit: 2 }
		});
		expect(second.items).toHaveLength(2);
		expect(second.next_cursor).toBeNull();
		const combined = [...first.items, ...second.items];
		expect(new Set(combined.map((item) => item.candidate_id)).size).toBe(4);
		expect(combined.map((item) => item.published_at)).toEqual([3_000, 3_000, 2_000, 1_000]);
	});

	it('detaches a deleted private source without changing the published snapshot', async () => {
		const t = createTestDb();
		seedBase(t);
		addTwoStageWorkflow(t);
		const proof = await prepare(t);
		t.sqlite
			.prepare('UPDATE workflow_publication SET source_workflow_id = ? WHERE id = ?')
			.run('wf_two', proof.candidate_id);
		const published = await publishPublication(
			t.db,
			envFor(t),
			actor,
			proof.candidate_id,
			confirmation(proof),
			2_000
		);
		const before = await resolvePublicSnapshot(t.db, published.receipt.snapshot_id);

		await deleteWorkflow(t.db, envFor(t), actor, 'wf_two');

		expect(
			t.sqlite
				.prepare('SELECT source_workflow_id FROM workflow_publication WHERE id = ?')
				.get(proof.candidate_id)
		).toEqual({ source_workflow_id: null });
		expect(await resolvePublicSnapshot(t.db, published.receipt.snapshot_id)).toEqual(before);
		expect(() =>
			t.sqlite
				.prepare('UPDATE workflow_publication SET source_workflow_id = ? WHERE id = ?')
				.run('wf_two', proof.candidate_id)
		).toThrow(/source is immutable/);
		expect(() =>
			t.sqlite
				.prepare('UPDATE workflow_publication SET metadata_json = ? WHERE id = ?')
				.run('{}', proof.candidate_id)
		).toThrow(/content is immutable/);
	});

	it('publishes exactly once and reconciles without returning source bytes', async () => {
		const t = createTestDb();
		seedBase(t);
		const proof = await prepare(t);
		const first = await publishPublication(
			t.db,
			envFor(t),
			actor,
			proof.candidate_id,
			confirmation(proof),
			2_000
		);
		const replay = await publishPublication(
			t.db,
			envFor(t),
			actor,
			proof.candidate_id,
			confirmation(proof),
			999_999
		);
		expect(replay).toEqual(first);
		expect(first.receipt.public_url).toBe(`https://tines.example/p/${first.receipt.snapshot_id}`);
		expect(first.receipt.snapshot_id).toMatch(/^pubs_/);
		expect(first.status_version).toBe(2);
		expect(await getPublicationResult(t.db, actor, proof.candidate_id)).toEqual(first);
		expect(await t.db.selectFrom('workflow_publication_event').selectAll().execute()).toHaveLength(
			1
		);
		expect(JSON.stringify(first)).not.toContain('Review the change');
	});

	it('requires exact repository and human confirmations', async () => {
		const t = createTestDb();
		seedBase(t);
		const proof = await prepare(t);
		await expect(
			publishPublication(t.db, envFor(t), actor, proof.candidate_id, {
				...confirmation(proof),
				reviewed_repo_ids: []
			})
		).rejects.toMatchObject({ status: 409, code: 'confirmation_mismatch' });
		await expect(
			publishPublication(
				t.db,
				envFor(t),
				{ ...actor, apiKeyId: 'run', viaSession: false, agentRunId: 'arun_1' },
				proof.candidate_id,
				confirmation(proof)
			)
		).rejects.toMatchObject({ status: 403, code: 'run_key_forbidden' });
	});

	it('guards the rolling quota in the publication batch with retry hints', async () => {
		const t = createTestDb();
		seedBase(t);
		const first = await prepare(t, 'first');
		await publishPublication(
			t.db,
			envFor(t, 1),
			actor,
			first.candidate_id,
			confirmation(first),
			2_000
		);
		const second = await prepare(t, 'second');
		await expect(
			publishPublication(
				t.db,
				envFor(t, 1),
				actor,
				second.candidate_id,
				confirmation(second),
				3_000
			)
		).rejects.toMatchObject({
			status: 429,
			code: 'publication_quota_exceeded',
			details: { retry_at: 86_402_000, retry_after_seconds: 86_399 }
		});
		expect(await t.db.selectFrom('workflow_publication_event').selectAll().execute()).toHaveLength(
			1
		);
	});

	it('withdraws immediately and restores only active, unsuspended snapshots', async () => {
		const t = createTestDb();
		seedBase(t);
		const proof = await prepare(t);
		const published = await publishPublication(
			t.db,
			envFor(t),
			actor,
			proof.candidate_id,
			confirmation(proof),
			2_000
		);
		const withdrawn = await withdrawPublication(
			t.db,
			envFor(t),
			actor,
			published.receipt.snapshot_id,
			3_000
		);
		expect(withdrawn).toMatchObject({ owner_state: 'withdrawn', status_version: 3 });
		expect(
			await withdrawPublication(t.db, envFor(t), actor, published.receipt.snapshot_id, 4_000)
		).toEqual(withdrawn);
		t.sqlite.exec(
			`INSERT INTO workflow_publisher_status (user_id, suspended, status_version) VALUES ('${USER}', 1, 2)`
		);
		await expect(
			restorePublication(t.db, envFor(t), actor, published.receipt.snapshot_id, 5_000)
		).rejects.toMatchObject({ status: 403, code: 'publication_unavailable' });
		t.sqlite.exec(`UPDATE workflow_publisher_status SET suspended = 0 WHERE user_id = '${USER}'`);
		const restored = await restorePublication(
			t.db,
			envFor(t),
			actor,
			published.receipt.snapshot_id,
			6_000
		);
		expect(restored).toMatchObject({ owner_state: 'published', status_version: 4 });
		expect((await listPublications(t.db, envFor(t), actor)).items[0]).toMatchObject({
			candidate_id: proof.candidate_id,
			snapshot_id: published.receipt.snapshot_id,
			owner_state: 'published'
		});
		expect(JSON.stringify(await listPublications(t.db, envFor(t), actor))).not.toContain(
			'Review the change'
		);
		expect(
			(await t.db.selectFrom('workflow_publication_event').select('action').execute()).map(
				(event) => event.action
			)
		).toEqual(['published', 'withdrawn', 'restored']);
	});
});
