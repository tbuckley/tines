import { describe, expect, it } from 'vitest';
import type { ActorContext } from '$lib/server/api/core';
import { createTestDb } from '$lib/server/api/test-db';
import { createWorkflow } from '$lib/server/api/workflows';
import { preparePublication } from '$lib/server/publications/prepare';
import { publishPublication } from '$lib/server/publications/publish';
import { resolvePublicSnapshot } from '$lib/server/publications/public';
import {
	addIssue,
	addRule,
	addRunner,
	runs,
	seedBase,
	setSettings,
	USER
} from '$lib/server/supervisor/test-fixtures';
import { DELETE, PATCH } from './+server';

const actor: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

describe('PATCH /api/v1/workflows/:id', () => {
	it('requires authorized context force, then detaches a published source without changing it', async () => {
		const t = createTestDb();
		seedBase(t);
		const workflow = await createWorkflow(t.db, t.env, actor, {
			name: 'Published source',
			initial_state: 'Open',
			states: [{ name: 'Open', category: 'active' }],
			transitions: []
		});
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
		const proof = await preparePublication(t.db, env, actor, {
			prepare_request_id: 'route-delete-source',
			source: { kind: 'owned_workflow', workflow_id: workflow.id, options: {} },
			metadata: { display_name: 'Example Team', license: 'MIT', license_year: 2026 }
		});
		const published = await publishPublication(t.db, env, actor, proof.candidate_id, {
			review_digest: proof.review_digest,
			sharing_rights: true,
			exact_content: true,
			reviewed_repo_ids: []
		});
		const before = await resolvePublicSnapshot(t.db, published.receipt.snapshot_id);
		t.sqlite
			.prepare(
				`INSERT INTO context_item(id,user_id,kind,name,description,workflow_state_id,position,version,created_at,updated_at)
				 VALUES('ctx_attached',?,'prompt','Attached','',?,0,1,1,1)`
			)
			.run(USER, workflow.states[0].id);
		const url = new URL(`http://test/api/v1/workflows/${workflow.id}`);
		const routeEvent = (body?: object) => ({
			params: { id: workflow.id },
			locals: { user: { id: USER, name: 'alice' } },
			platform: { env, ctx: { waitUntil: () => {} } },
			request: new Request(url, {
				method: 'DELETE',
				...(body
					? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
					: {})
			}),
			url
		});
		const refused = await DELETE(routeEvent() as unknown as Parameters<typeof DELETE>[0]);
		expect(refused.status).toBe(422);
		expect(await refused.json()).toMatchObject({ error: { code: 'context_attached' } });
		expect(await resolvePublicSnapshot(t.db, published.receipt.snapshot_id)).toEqual(before);

		const response = await DELETE(
			routeEvent({ force_delete_context: true }) as unknown as Parameters<typeof DELETE>[0]
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ deleted_context: [{ id: 'ctx_attached' }] });
		expect(
			t.sqlite
				.prepare('SELECT source_workflow_id FROM workflow_publication WHERE id=?')
				.get(proof.candidate_id)
		).toEqual({ source_workflow_id: null });
		expect(await resolvePublicSnapshot(t.db, published.receipt.snapshot_id)).toEqual(before);
	});

	it('dispatches work made eligible by a category change', async () => {
		const t = createTestDb();
		seedBase(t);
		setSettings(t);
		const runner = addRunner(t, { lastSeen: Date.now() });
		addRule(t, { targets: [{ runner_id: runner }] });
		const workflow = await createWorkflow(t.db, t.env, actor, {
			name: 'Activation',
			initial_state: 'Waiting',
			states: [{ name: 'Waiting', category: 'backlog' }],
			transitions: []
		});
		const waiting = workflow.states[0];
		const issue = addIssue(t, { workflow: workflow.id, state: waiting.id });

		const waits: Promise<unknown>[] = [];
		const url = new URL(`http://test/api/v1/workflows/${workflow.id}`);
		const response = await PATCH({
			params: { id: workflow.id },
			locals: { user: { id: USER, name: 'alice' } },
			platform: { env: t.env, ctx: { waitUntil: (p: Promise<unknown>) => waits.push(p) } },
			request: new Request(url, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					states: [{ id: waiting.id, name: waiting.name, category: 'active' }]
				})
			}),
			url
		} as unknown as Parameters<typeof PATCH>[0]);

		expect(response.status).toBe(200);
		expect(waits).toHaveLength(1);
		await Promise.all(waits);
		expect(runs(t).map((run) => run.issue_id)).toEqual([issue]);
	});

	it('does not bind or schedule effects before authentication succeeds', async () => {
		const t = createTestDb();
		seedBase(t);
		const waits: Promise<unknown>[] = [];
		const url = new URL('http://test/api/v1/workflows/wf_standard');
		const response = await PATCH({
			params: { id: 'wf_standard' },
			locals: {},
			platform: { env: t.env, ctx: { waitUntil: (p: Promise<unknown>) => waits.push(p) } },
			request: new Request(url, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: 'Nope' })
			}),
			url
		} as unknown as Parameters<typeof PATCH>[0]);
		expect(response.status).toBe(401);
		expect(waits).toHaveLength(0);
	});
});

describe('DELETE /api/v1/workflows/:id', () => {
	it.each(['true', '1', 'yes'])(
		'rejects affirmative force_clear_inheritance alias %s',
		async (value) => {
			const t = createTestDb();
			seedBase(t);
			const workflow = await createWorkflow(t.db, t.env, actor, {
				name: `Retirement alias ${value}`,
				initial_state: 'Open',
				states: [{ name: 'Open', category: 'active' }],
				transitions: []
			});
			const url = new URL(`http://test/api/v1/workflows/${workflow.id}`);
			const response = await DELETE({
				params: { id: workflow.id },
				locals: { user: { id: USER, name: 'alice' } },
				platform: { env: t.env, ctx: { waitUntil: () => {} } },
				request: new Request(url, {
					method: 'DELETE',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ force_clear_inheritance: value })
				}),
				url
			} as unknown as Parameters<typeof DELETE>[0]);

			expect(response.status).toBe(422);
			expect(await response.json()).toMatchObject({
				error: { code: 'state_inheritance_removed' }
			});
		}
	);

	it.each(['true', '1', 'yes'])(
		'rejects affirmative force_clear_inheritance query alias %s without a body',
		async (value) => {
			const t = createTestDb();
			seedBase(t);
			const workflow = await createWorkflow(t.db, t.env, actor, {
				name: `Retirement query alias ${value}`,
				initial_state: 'Open',
				states: [{ name: 'Open', category: 'active' }],
				transitions: []
			});
			const url = new URL(`http://test/api/v1/workflows/${workflow.id}`);
			url.searchParams.set('force_clear_inheritance', value);
			const response = await DELETE({
				params: { id: workflow.id },
				locals: { user: { id: USER, name: 'alice' } },
				platform: { env: t.env, ctx: { waitUntil: () => {} } },
				request: new Request(url, { method: 'DELETE' }),
				url
			} as unknown as Parameters<typeof DELETE>[0]);

			expect(response.status).toBe(422);
			expect(await response.json()).toMatchObject({
				error: { code: 'state_inheritance_removed' }
			});
			expect(
				await t.db
					.selectFrom('workflow')
					.select('id')
					.where('id', '=', workflow.id)
					.executeTakeFirst()
			).toEqual({ id: workflow.id });
		}
	);
});
