import type { Runner } from '@tines/shared';
import { expect, test } from '@playwright/test';
import { ALICE } from './constants.mjs';
import { spawnDaemon, type Daemon } from './daemon';
import { apiClient, body, runId } from './helpers';

const name = `concurrency-${runId}`;

test('an opted-in real daemon keeps a web cap across polls and restart', async ({ request }) => {
	test.setTimeout(60_000);
	const api = apiClient(request, ALICE.apiKey);
	let daemon: Daemon | null = spawnDaemon({
		apiKey: ALICE.apiKey,
		name,
		maxConcurrent: 3,
		allowRemoteConcurrency: true
	});
	let runner: Runner | undefined;
	try {
		await expect
			.poll(
				async () => {
					const listed = await body<{ items: Runner[] }>(await api.get('/api/v1/runners'));
					runner = listed.items.find((item) => item.name === name);
					return runner?.concurrency_control?.status;
				},
				{ timeout: 20_000, message: daemon.output() }
			)
			.toBe('applied');
		expect(runner?.max_concurrent).toBe(1);

		runner = await body<Runner>(
			await api.patch(`/api/v1/runners/${runner!.id}`, {
				max_concurrent: 3,
				expected_concurrency_revision: runner!.concurrency_control!.revision
			})
		);
		expect(runner.concurrency_control?.status).toBe('pending');
		await expect
			.poll(async () => {
				runner = await body<Runner>(await api.get(`/api/v1/runners/${runner!.id}`));
				return [runner.max_concurrent, runner.concurrency_control?.status];
			})
			.toEqual([3, 'applied']);

		// Three ordinary poll intervals must not reset the request.
		await new Promise((resolve) => setTimeout(resolve, 3_500));
		runner = await body<Runner>(await api.get(`/api/v1/runners/${runner.id}`));
		expect([runner.max_concurrent, runner.concurrency_control?.applied_cap]).toEqual([3, 3]);

		const configDir = daemon.configDir;
		daemon.stop();
		await new Promise((resolve) => daemon!.proc.once('exit', resolve));
		daemon = spawnDaemon({
			apiKey: ALICE.apiKey,
			name,
			maxConcurrent: 3,
			allowRemoteConcurrency: true,
			configDir
		});
		await expect
			.poll(
				async () => {
					runner = await body<Runner>(await api.get(`/api/v1/runners/${runner!.id}`));
					return [runner.max_concurrent, runner.concurrency_control?.status];
				},
				{ timeout: 20_000, message: daemon.output() }
			)
			.toEqual([3, 'applied']);
	} finally {
		daemon?.kill();
		if (runner) await api.delete(`/api/v1/runners/${runner.id}`, { force: true });
	}
});
