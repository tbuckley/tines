import { describe, expect, it } from 'vitest';
import { createTestDb } from '$lib/server/api/test-db';
import { addIssue, addRule, runs, seedBase, USER } from '$lib/server/supervisor/test-fixtures';
import { POST } from './+server';

function eventFor(t: ReturnType<typeof createTestDb>, body: unknown, waits: Promise<unknown>[]) {
	return {
		params: {},
		locals: { user: { id: USER, name: 'alice' } },
		platform: {
			env: t.env,
			ctx: { waitUntil: (promise: Promise<unknown>) => waits.push(promise) }
		},
		request: new Request('http://test/api/v1/runners/register', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		}),
		url: new URL('http://test/api/v1/runners/register')
	};
}

describe('POST /api/v1/runners/register', () => {
	it('registers a pi runner: tiers apply, with no built-in model table', async () => {
		const t = createTestDb();
		seedBase(t);
		const waits: Promise<unknown>[] = [];
		const created = await POST(
			eventFor(t, { name: 'macbook-pi', harness: 'pi' }, waits) as unknown as Parameters<
				typeof POST
			>[0]
		);
		expect(created.status).toBe(201);
		const body = (await created.json()) as { runner: Record<string, unknown> };
		expect(body.runner).toMatchObject({
			config: { harness: 'pi' },
			tier_models: null,
			tiers_apply: true
		});
		await Promise.all(waits);

		const unknown = await POST(
			eventFor(t, { name: 'other', harness: 'aider' }, []) as unknown as Parameters<typeof POST>[0]
		);
		expect(unknown.status).toBe(422);
		expect(JSON.stringify(await unknown.json())).toContain('claude_code, codex, pi, custom');
	});

	it('queues dispatch after create and reconnect without claiming before a policy poll', async () => {
		const t = createTestDb();
		seedBase(t);
		const waits: Promise<unknown>[] = [];
		const first = await POST(
			eventFor(t, { name: 'laptop', harness: 'codex' }, waits) as unknown as Parameters<
				typeof POST
			>[0]
		);
		expect(first.status).toBe(201);
		expect(waits).toHaveLength(1);
		await Promise.all(waits.splice(0));

		const runnerId = t.all("SELECT id FROM runner WHERE name = 'laptop'")[0].id as string;
		addRule(t, { targets: [{ runner_id: runnerId }] });
		addIssue(t, { title: 'Title only', description: '' });
		const reconnect = await POST(
			eventFor(t, { name: 'laptop', harness: 'codex' }, waits) as unknown as Parameters<
				typeof POST
			>[0]
		);
		expect(reconnect.status).toBe(201);
		expect(waits).toHaveLength(1);
		await Promise.all(waits);
		// Re-registration rotates the token and deliberately leaves the runner
		// offline until that daemon reports its current local policy. The queued
		// pass is harmless and must not claim work against stale consent.
		expect(runs(t)).toHaveLength(0);

		const failedWaits: Promise<unknown>[] = [];
		const failed = await POST(
			eventFor(t, { name: '', harness: 'codex' }, failedWaits) as unknown as Parameters<
				typeof POST
			>[0]
		);
		expect(failed.status).toBe(422);
		expect(failedWaits).toHaveLength(0);
	});
});
