import { describe, expect, it } from 'vitest';
import type { ActorContext } from '$lib/server/api/core';
import { createTestDb } from '$lib/server/api/test-db';
import { createWorkflow } from '$lib/server/api/workflows';
import {
	addIssue,
	addRule,
	addRunner,
	runs,
	seedBase,
	setSettings,
	USER
} from '$lib/server/supervisor/test-fixtures';
import { PATCH } from './+server';

const actor: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

describe('PATCH /api/v1/workflows/:id', () => {
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
