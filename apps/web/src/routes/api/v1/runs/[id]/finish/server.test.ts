import { describe, expect, it } from 'vitest';
import { createTestDb } from '$lib/server/api/test-db';
import { sha256Hex } from '$lib/server/crypto';
import {
	addIssue,
	addRun,
	addRunner,
	NOW,
	seedBase,
	USER
} from '$lib/server/supervisor/test-fixtures';
import { POST as POLL } from '../../../runners/[id]/poll/+server';
import { POST as FINISH } from './+server';

async function authenticatedRunner() {
	const t = createTestDb();
	seedBase(t);
	const token = 'tines_rt_route_dispatch';
	const runner = addRunner(t, { lastSeen: null });
	t.sqlite
		.prepare('UPDATE runner SET runner_token_hash = ? WHERE id = ?')
		.run(await sha256Hex(token), runner);
	return { t, token, runner };
}

function eventFor(
	t: ReturnType<typeof createTestDb>,
	token: string,
	path: string,
	body: unknown,
	waits: Promise<unknown>[]
) {
	const url = new URL(`http://test${path}`);
	return {
		platform: {
			env: t.env,
			ctx: { waitUntil: (promise: Promise<unknown>) => waits.push(promise) }
		},
		request: new Request(url, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify(body)
		}),
		url
	};
}

describe('runner-token dispatch wiring', () => {
	it('does not bind or schedule effects for an invalid runner token', async () => {
		const { t, runner } = await authenticatedRunner();
		const waits: Promise<unknown>[] = [];
		const response = await POLL({
			...eventFor(t, 'invalid', `/api/v1/runners/${runner}/poll`, { owned_runs: [] }, waits),
			params: { id: runner }
		} as unknown as Parameters<typeof POLL>[0]);
		expect(response.status).toBe(401);
		expect(waits).toHaveLength(0);
	});

	it('drains a coming-online poll signal through the request wrapper', async () => {
		const { t, token, runner } = await authenticatedRunner();
		const waits: Promise<unknown>[] = [];
		const response = await POLL({
			...eventFor(t, token, `/api/v1/runners/${runner}/poll`, { owned_runs: [] }, waits),
			params: { id: runner }
		} as unknown as Parameters<typeof POLL>[0]);
		expect(response.status).toBe(200);
		expect(waits).toHaveLength(1);
		await Promise.all(waits);
	});

	it('drains a winning finish signal through the request wrapper', async () => {
		const { t, token, runner } = await authenticatedRunner();
		t.sqlite.prepare('UPDATE runner SET last_seen_at = ? WHERE id = ?').run(NOW, runner);
		const issue = addIssue(t);
		const run = addRun(t, { issueId: issue, runnerId: runner, status: 'running', startedAt: NOW });
		const waits: Promise<unknown>[] = [];
		const response = await FINISH({
			...eventFor(t, token, `/api/v1/runs/${run}/finish`, { status: 'completed' }, waits),
			params: { id: run }
		} as unknown as Parameters<typeof FINISH>[0]);
		expect(response.status).toBe(200);
		expect(waits).toHaveLength(1);
		await Promise.all(waits);
	});
});
