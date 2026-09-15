import { describe, expect, it } from 'vitest';
import { canonicalizeLibraryValue, inputToken, withLibraryDocumentDigest } from '@tines/shared';
import { inheritedPackage } from '../../../../../../packages/shared/src/library/fixtures';
import { createTestDb } from '../api/test-db';
import { USER, seedBase } from '../supervisor/test-fixtures';
import { createContextItem } from '../api/context';
import { createWorkflow } from '../api/workflows';
import { preparePublication } from './prepare';
import { publishPublication } from './publish';
import { buildOwnedPublicationSourceProof } from './source';

const actor = {
	userId: USER,
	userName: 'Alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

async function request(displayName = 'Example Team') {
	return {
		prepare_request_id: 'prepare-once',
		source: {
			kind: 'file' as const,
			document_json: canonicalizeLibraryValue(await withLibraryDocumentDigest(inheritedPackage()))
		},
		metadata: { display_name: displayName, license: 'MIT' as const, license_year: 2026 }
	};
}

describe('publication preparation', () => {
	it('freezes an authored owned-workflow draft without changing its private source', async () => {
		const t = createTestDb();
		seedBase(t);
		const env = {
			...t.env,
			PUBLIC_WORKFLOW_PUBLISHING_ENABLED: 'true',
			PUBLIC_WORKFLOW_MODERATOR_USER_IDS: USER,
			PUBLIC_WORKFLOW_REPORT_HMAC_SECRET: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
			PUBLIC_WORKFLOW_APPEAL_CONTACT: 'mailto:appeals@example.test',
			PUBLIC_WORKFLOW_MODERATION_QUEUE_READY: 'true',
			PUBLIC_WORKFLOW_MODERATION_JOURNEY_VERIFIED: 'true',
			TINES_PUBLIC_URL: 'https://tines.example'
		} as Env;
		const workflow = await createWorkflow(t.db, t.env, actor, {
			name: 'Publish draft',
			initial_state: 'Open',
			states: [{ name: 'Open', category: 'active' }],
			transitions: []
		});
		const prompt = await createContextItem(t.db, t.env, actor, {
			kind: 'prompt',
			name: 'instructions',
			body: 'customer-portal and customer-portal',
			workflow_state_id: workflow.states[0].id
		});
		const clean = await buildOwnedPublicationSourceProof(t.db, USER, workflow.id, {}, 1000);
		const draft = structuredClone(clean.document);
		const input = {
			id: 'input:author:1',
			key: 'project_name',
			type: 'text' as const,
			label: 'Project name',
			description: '',
			required: true,
			default: 'billing-service'
		};
		const token = inputToken(input.key, input.default);
		draft.inputs.push(input);
		const draftPrompt = draft.context.find((item) => item.kind === 'prompt');
		if (!draftPrompt || draftPrompt.kind !== 'prompt') throw new Error('missing prompt');
		draftPrompt.body = `${token} and customer-portal`;
		draft.text_uses.push({
			id: 'use:author:1',
			target: { record_id: draftPrompt.id, field: 'body' },
			input_id: input.id,
			token
		});
		const sealed = await withLibraryDocumentDigest(draft);
		const proof = await preparePublication(
			t.db,
			env,
			actor,
			{
				prepare_request_id: 'draft-once',
				source: {
					kind: 'owned_workflow',
					workflow_id: workflow.id,
					options: {},
					draft: {
						version: 1,
						baseline: {
							document_digest: clean.document.digest,
							exported_at: clean.document.exported_at
						},
						document_json: canonicalizeLibraryValue(sealed)
					}
				},
				metadata: { display_name: 'Alice', license: 'MIT', license_year: 2026 }
			},
			2000
		);
		const frozenPrompt = proof.document.context.find((item) => item.kind === 'prompt');
		expect(frozenPrompt).toMatchObject({ body: `${token} and customer-portal` });
		expect(proof.document.exported_at).toBe(2000);
		expect(
			await t.db
				.selectFrom('context_item')
				.select('body')
				.where('id', '=', prompt.id)
				.executeTakeFirst()
		).toEqual({ body: 'customer-portal and customer-portal' });
		expect(
			JSON.parse(
				(
					await t.db
						.selectFrom('workflow_publication')
						.select('source_provenance_json')
						.executeTakeFirstOrThrow()
				).source_provenance_json
			)
		).toMatchObject({ draft_version: 1, baseline: { exported_at: 1000 } });
		await t.db
			.updateTable('context_item')
			.set({ body: 'source changed during review' })
			.where('id', '=', prompt.id)
			.execute();
		await expect(
			publishPublication(
				t.db,
				env,
				actor,
				proof.candidate_id,
				{
					review_digest: proof.review_digest,
					sharing_rights: true,
					exact_content: true,
					reviewed_repo_ids: []
				},
				3000
			)
		).rejects.toMatchObject({ code: 'publication_source_changed' });
		expect(await t.db.selectFrom('workflow_publication_event').selectAll().execute()).toEqual([]);
		await t.db
			.updateTable('context_item')
			.set({ body: 'customer-portal and customer-portal' })
			.where('id', '=', prompt.id)
			.execute();
		const published = await publishPublication(
			t.db,
			env,
			actor,
			proof.candidate_id,
			{
				review_digest: proof.review_digest,
				sharing_rights: true,
				exact_content: true,
				reviewed_repo_ids: []
			},
			4000
		);
		expect(published.receipt.document_digest).toBe(proof.document_digest);
	});

	it('stores an actor-bound candidate and reconciles an identical request', async () => {
		const t = createTestDb();
		seedBase(t);
		const env = {
			...t.env,
			PUBLIC_WORKFLOW_PUBLISHING_ENABLED: 'true',
			PUBLIC_WORKFLOW_MODERATOR_USER_IDS: USER,
			PUBLIC_WORKFLOW_REPORT_HMAC_SECRET: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
			PUBLIC_WORKFLOW_APPEAL_CONTACT: 'mailto:appeals@example.test',
			PUBLIC_WORKFLOW_MODERATION_QUEUE_READY: 'true',
			PUBLIC_WORKFLOW_MODERATION_JOURNEY_VERIFIED: 'true'
		} as Env;
		const first = await preparePublication(t.db, env, actor, await request(), 1000);
		const replay = await preparePublication(t.db, env, actor, await request(), 2000);
		expect(replay).toEqual(first);
		expect(first.candidate_id).toMatch(/^pub_/);
		expect(first.expires_at).toBe(901000);
		expect(await t.db.selectFrom('workflow_publication').selectAll().execute()).toHaveLength(1);
		const source = await t.db
			.selectFrom('workflow_publication_source')
			.selectAll()
			.executeTakeFirst();
		expect(source?.source_witness_json).not.toContain('Review the change');
		expect(source?.source_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);

		await expect(
			preparePublication(t.db, env, actor, await request('Different'), 2000)
		).rejects.toMatchObject({
			status: 409,
			code: 'prepare_request_conflict'
		});
	});

	it('fails closed when host publication creation is disabled', async () => {
		const t = createTestDb();
		seedBase(t);
		await expect(preparePublication(t.db, t.env, actor, await request())).rejects.toMatchObject({
			status: 503,
			code: 'publication_disabled'
		});
		expect(await t.db.selectFrom('workflow_publication').selectAll().execute()).toEqual([]);
	});
});
