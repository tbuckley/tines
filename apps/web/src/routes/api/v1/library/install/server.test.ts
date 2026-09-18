import { expect, it } from 'vitest';
import { createTestDb } from '$lib/server/api/test-db';
import { USER, seedBase } from '$lib/server/supervisor/test-fixtures';
import { exportWorkflowPackage } from '$lib/server/library/export';
import { prepareWorkflowPackage } from '$lib/server/library/plan';
import { GET } from '../installs/[planId]/+server';
import { POST } from './+server';

it('commits and recovers through the authenticated bounded handlers', async () => {
	const t = createTestDb();
	seedBase(t);
	const actor = {
		userId: USER,
		userName: 'Alice',
		apiKeyId: null,
		apiKeyName: null,
		viaSession: true
	};
	const env = { ...t.env, BETTER_AUTH_SECRET: 'test-key' };
	const document = await exportWorkflowPackage(t.db, USER, 'wf_standard');
	const document_json = JSON.stringify(document);
	const plan = await prepareWorkflowPackage(t.db, env, actor, document_json);
	const requestBody = {
		document_json,
		plan_token: plan.plan_token,
		confirmation: { plan_digest: plan.plan_digest }
	};
	const event = (body: unknown) =>
		({
			locals: { user: { id: USER, name: 'Alice' } },
			platform: { env, ctx: { waitUntil: () => {} } },
			url: new URL('http://test/api/v1/library/install'),
			params: {},
			request: new Request('http://test/api/v1/library/install', {
				method: 'POST',
				body: JSON.stringify(body)
			})
		}) as unknown as Parameters<typeof POST>[0];
	const response = await POST(event(requestBody));
	expect(response.status).toBe(200);
	const receipt = await response.json();
	expect(receipt.id).toBe(plan.plan_id);

	const recovered = await GET({
		locals: { user: { id: USER, name: 'Alice' } },
		platform: { env, ctx: { waitUntil: () => {} } },
		url: new URL(`http://test/api/v1/library/installs/${plan.plan_id}`),
		params: { planId: plan.plan_id },
		request: new Request(`http://test/api/v1/library/installs/${plan.plan_id}`)
	} as unknown as Parameters<typeof GET>[0]);
	expect(recovered.status).toBe(200);
	expect(await recovered.json()).toEqual(receipt);

	for (const bad of [
		{ ...requestBody, extra: true },
		{ ...requestBody, confirmation: {} },
		{ ...requestBody, confirmation: { plan_digest: plan.plan_digest, extra: true } }
	])
		expect((await POST(event(bad))).status).toBe(422);
});
