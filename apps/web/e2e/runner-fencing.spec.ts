import type { Runner, RunnerPollResponse, RunnerTokenResponse } from '@tines/shared';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { ALICE } from './constants.mjs';
import { apiClient, body, errorBody, runId } from './helpers';

const name = `fencing-${runId}`;

async function poll(
	request: APIRequestContext,
	runnerId: string,
	token: string,
	instanceId?: string
) {
	return request.post(`/api/v1/runners/${runnerId}/poll`, {
		headers: { authorization: `Bearer ${token}` },
		data: { ...(instanceId === undefined ? {} : { instance_id: instanceId }), owned_runs: [] }
	});
}

test('native D1 polling fences the immediate predecessor and preserves legacy omission', async ({
	request
}) => {
	const api = apiClient(request, ALICE.apiKey);
	const registered = await body<RunnerTokenResponse>(
		await api.post('/api/v1/runners/register', { name, harness: 'custom', command: 'true' })
	);
	const { id } = registered.runner;
	const token = registered.runner_token;

	expect((await poll(request, id, token, 'daemon_A')).ok()).toBe(true);
	expect((await poll(request, id, token, 'daemon_B')).ok()).toBe(true);
	const beforeConflict = await body<Runner>(await api.get(`/api/v1/runners/${id}`));
	const stale = await poll(request, id, token, 'daemon_A');
	expect(stale.status()).toBe(409);
	expect(await errorBody(stale)).toMatchObject({
		error: { code: 'runner_conflict', message: expect.stringContaining('superseded') }
	});
	const afterConflict = await body<Runner>(await api.get(`/api/v1/runners/${id}`));
	expect(afterConflict).toEqual(beforeConflict);

	// Old clients remain compatible even while a modern owner exists.
	expect(await body<RunnerPollResponse>(await poll(request, id, token))).toEqual({
		assignments: [],
		cancels: []
	});
	expect((await poll(request, id, token, 'daemon_B')).ok()).toBe(true);

	// Concurrent unseen ids both serialize successfully; exactly one is then
	// current and the other is its immediate predecessor.
	const attempts = await Promise.all([
		poll(request, id, token, 'daemon_C'),
		poll(request, id, token, 'daemon_D')
	]);
	const attemptResults = await Promise.all(
		attempts.map(async (response, index) => ({
			instance: ['daemon_C', 'daemon_D'][index],
			ok: response.ok(),
			status: response.status(),
			body: await response.text()
		}))
	);
	expect(
		attemptResults.map(({ ok }) => ok),
		`concurrent unseen poll responses:\n${JSON.stringify(attemptResults, null, 2)}`
	).toEqual([true, true]);
	const followups = await Promise.all([
		poll(request, id, token, 'daemon_C'),
		poll(request, id, token, 'daemon_D')
	]);
	expect(followups.map((response) => response.status()).sort()).toEqual([200, 409]);

	// The E2E database is shared across files; leave no fleet row that can
	// alter later runner-card pagination or queue annotations.
	expect((await api.delete(`/api/v1/runners/${id}`)).ok()).toBe(true);
});
