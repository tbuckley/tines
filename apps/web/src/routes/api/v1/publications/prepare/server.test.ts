import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalizeLibraryValue, withLibraryDocumentDigest } from '@tines/shared';
import type { WorkflowPackageDocument } from '@tines/shared';
import { createTestDb, type TestDb } from '$lib/server/api/test-db';
import { createWorkflow } from '$lib/server/api/workflows';
import { buildOwnedPublicationSourceProof } from '$lib/server/publications/source';
import { seedBase, USER } from '$lib/server/supervisor/test-fixtures';
import { POST } from './+server';

const actor = {
	userId: USER,
	userName: 'Alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

let t: TestDb;
let workflowId: string;
let baseline: Awaited<ReturnType<typeof buildOwnedPublicationSourceProof>>;

function event(raw: BodyInit) {
	const url = new URL('http://test/api/v1/publications/prepare');
	return {
		locals: { user: { id: USER, name: 'Alice' } },
		platform: { env: t.env, ctx: { waitUntil: () => {} } },
		params: {},
		url,
		request: new Request(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: raw
		})
	} as unknown as Parameters<typeof POST>[0];
}

function request(document: WorkflowPackageDocument = baseline.document) {
	return {
		prepare_request_id: crypto.randomUUID(),
		source: {
			kind: 'owned_workflow',
			workflow_id: workflowId,
			options: {},
			draft: {
				version: 1,
				baseline: {
					document_digest: baseline.document.digest,
					exported_at: baseline.document.exported_at
				},
				document_json: canonicalizeLibraryValue(document)
			}
		},
		metadata: { display_name: 'Alice', license: 'MIT', license_year: 2026 }
	};
}

async function call(value: unknown) {
	return POST(event(JSON.stringify(value)));
}

beforeEach(async () => {
	t = createTestDb();
	seedBase(t);
	Object.assign(t.env, {
		PUBLIC_WORKFLOW_PUBLISHING_ENABLED: 'true',
		PUBLIC_WORKFLOW_MODERATOR_USER_IDS: USER,
		PUBLIC_WORKFLOW_REPORT_HMAC_SECRET: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
		PUBLIC_WORKFLOW_APPEAL_CONTACT: 'mailto:appeals@example.test',
		PUBLIC_WORKFLOW_MODERATION_QUEUE_READY: 'true',
		PUBLIC_WORKFLOW_MODERATION_JOURNEY_VERIFIED: 'true'
	});
	const workflow = await createWorkflow(t.db, t.env, actor, {
		name: 'Publish route draft',
		description: 'Private description',
		initial_state: 'Open',
		states: [{ name: 'Open', category: 'active' }],
		transitions: []
	});
	workflowId = workflow.id;
	baseline = await buildOwnedPublicationSourceProof(t.db, USER, workflowId, {}, 1000);
});

describe('POST /api/v1/publications/prepare draft envelope', () => {
	it('accepts a strict Unicode draft and returns those exact authored bytes', async () => {
		const draft = structuredClone(baseline.document);
		draft.workflows[0].description = 'Résumé 🚀 — 東京';
		const response = await call(request(await withLibraryDocumentDigest(draft)));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			document: { workflows: [{ description: 'Résumé 🚀 — 東京' }] }
		});
	});

	it.each([
		[
			'mixed draft and authoring',
			(body: ReturnType<typeof request>) => {
				body.source.options = { authoring: { inputs: [], text_uses: [] } } as never;
			}
		],
		[
			'partial draft',
			(body: ReturnType<typeof request>) => {
				delete (body.source.draft as Partial<typeof body.source.draft>).document_json;
			}
		],
		[
			'unknown draft field',
			(body: ReturnType<typeof request>) => {
				(body.source.draft as unknown as Record<string, unknown>).extra = true;
			}
		],
		[
			'unknown baseline field',
			(body: ReturnType<typeof request>) => {
				(body.source.draft.baseline as unknown as Record<string, unknown>).extra = true;
			}
		],
		[
			'unsupported draft version',
			(body: ReturnType<typeof request>) => {
				(body.source.draft as { version: number }).version = 2;
			}
		],
		[
			'invalid baseline digest',
			(body: ReturnType<typeof request>) => {
				body.source.draft.baseline.document_digest = 'sha256:not-a-digest';
			}
		],
		[
			'negative baseline timestamp',
			(body: ReturnType<typeof request>) => {
				body.source.draft.baseline.exported_at = -1;
			}
		]
	])('rejects %s at the route boundary', async (_name, mutate) => {
		const body = request();
		mutate(body);
		const response = await call(body);
		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({
			error: { code: 'invalid_publication_source' }
		});
	});

	it('rejects duplicate envelope and nested document keys', async () => {
		const duplicateEnvelope = await POST(
			event(`{"prepare_request_id":"one","prepare_request_id":"two","source":{},"metadata":{}}`)
		);
		expect(duplicateEnvelope.status).toBe(400);
		expect(await duplicateEnvelope.json()).toMatchObject({ error: { code: 'invalid_json' } });

		const body = request();
		body.source.draft.document_json =
			'{"format":"tines.library","format":"tines.library","version":3}';
		const duplicateDocument = await call(body);
		expect(duplicateDocument.status).toBe(422);
		expect(await duplicateDocument.json()).toMatchObject({
			error: { code: 'invalid_publication_draft' }
		});
	});

	it('rejects invalid UTF-8 and bounds draft bytes before document parsing', async () => {
		const invalidUtf8 = await POST(event(new Uint8Array([0x7b, 0x80, 0x7d])));
		expect(invalidUtf8.status).toBe(400);
		expect(await invalidUtf8.json()).toMatchObject({ error: { code: 'invalid_utf8' } });

		const oversized = request();
		oversized.source.draft.document_json = 'x'.repeat(1_048_577);
		const tooLarge = await call(oversized);
		expect(tooLarge.status).toBe(413);
		expect(await tooLarge.json()).toMatchObject({ error: { code: 'publication_too_large' } });
	});

	it('does not reveal whether an inaccessible owned source exists', async () => {
		t.sqlite.exec(`
			INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
			VALUES ('usr_other', 'Other', 'other@example.test', 1, 1, 1);
			INSERT INTO workflow (id, user_id, name, description, initial_state_id, created_at, updated_at)
			VALUES ('wf_private', 'usr_other', 'Private', '', 'wfs_private', 1, 1);
			INSERT INTO workflow_state (id, workflow_id, name, category, position, created_at)
			VALUES ('wfs_private', 'wf_private', 'Open', 'active', 0, 1);
		`);
		const statuses = [];
		const bodies = [];
		for (const id of ['wf_private', 'wf_missing']) {
			const body = request();
			body.source.workflow_id = id;
			const response = await call(body);
			statuses.push(response.status);
			bodies.push(await response.json());
		}
		expect(statuses).toEqual([404, 404]);
		expect(bodies).toEqual([
			{ error: { code: 'not_found', message: 'Not found' } },
			{ error: { code: 'not_found', message: 'Not found' } }
		]);
	});
});
