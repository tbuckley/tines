import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IssueDetail, Project, RoutingRule, Runner, RunnerTokenResponse } from '@tines/shared';
import { expect, test } from '@playwright/test';
import { ALICE, BOB, RUNROW } from './constants.mjs';
import { spawnDaemon, transitionHarnessCommand, type Daemon } from './daemon';
import { apiClient, body, clickUntil, gotoHydrated, runId, signIn } from './helpers';

const name = `concurrency-${runId}`;

function files(dir: string, prefix: string): number {
	return readdirSync(dir).filter((entry) => entry.startsWith(prefix)).length;
}

test('the Now remedy drains 1→3 through a real daemon and a lower cap admits no fourth run', async ({
	context,
	page,
	request
}) => {
	test.setTimeout(90_000);
	const api = apiClient(request, ALICE.apiKey);
	const markerDir = mkdtempSync(join(tmpdir(), 'tines-concurrency-markers-'));
	const firstCommand = [
		`touch "${markerDir}/first-$TINES_RUN_ID"`,
		'sleep 3',
		transitionHarnessCommand('Submit for review')
	].join('\n');
	let daemon: Daemon | null = spawnDaemon({
		apiKey: ALICE.apiKey,
		name,
		command: firstCommand,
		maxConcurrent: 3,
		allowRemoteConcurrency: true
	});
	let runner: Runner | undefined;
	let project: Project | undefined;
	let rule: RoutingRule | undefined;
	try {
		await expect
			.poll(
				async () => {
					const listed = await body<{ items: Runner[] }>(await api.get('/api/v1/runners'));
					runner = listed.items.find((item) => item.name === name);
					return [runner?.max_concurrent, runner?.concurrency_control?.status];
				},
				{ timeout: 20_000, message: daemon.output() }
			)
			.toEqual([1, 'applied']);

		project = await body<Project>(
			await api.post('/api/v1/projects', { name: `concurrency-${runId}` })
		);
		for (let i = 1; i <= 3; i++) {
			expect(
				(
					await api.post(`/api/v1/projects/${project.id}/issues`, {
						title: `parallel ${i} ${runId}`
					})
				).status()
			).toBe(201);
		}
		rule = await body<RoutingRule>(
			await api.post('/api/v1/routing-rules', {
				project_id: project.id,
				targets: [{ runner_id: runner!.id }]
			})
		);
		expect((await api.put('/api/v1/supervisor/settings', { enabled: true })).status()).toBe(200);
		await expect.poll(() => files(markerDir, 'first-'), { timeout: 20_000 }).toBe(1);

		await signIn(context, ALICE.sessionToken);
		await gotoHydrated(page, '/agents');
		const panel = page.getByRole('region', { name: 'Waiting for an agent' });
		await expect(panel).toContainText(`at capacity on ${name} (1/1)`);
		const dialog = page.getByRole('dialog');
		const capField = dialog.locator('#edit-concurrent');
		await clickUntil(panel.getByRole('button', { name: `Raise cap on ${name}` }), () =>
			expect(capField).toBeVisible({ timeout: 1000 })
		);
		await capField.fill('3');
		await dialog.getByRole('button', { name: /^Save/ }).click();
		await expect.poll(() => files(markerDir, 'first-'), { timeout: 20_000 }).toBe(3);

		await new Promise((resolve) => setTimeout(resolve, 3_500));
		runner = await body<Runner>(await api.get(`/api/v1/runners/${runner.id}`));
		expect([runner.max_concurrent, runner.concurrency_control?.applied_cap]).toEqual([3, 3]);
		await expect
			.poll(async () => {
				const active = await body<{ items: { runner_id: string }[] }>(
					await api.get('/api/v1/runs?active=true')
				);
				return active.items.filter((run) => run.runner_id === runner!.id).length;
			})
			.toBe(0);

		const configDir = daemon.configDir;
		daemon.stop();
		await new Promise((resolve) => daemon!.proc.once('exit', resolve));
		daemon = spawnDaemon({
			apiKey: ALICE.apiKey,
			name,
			command: `touch "${markerDir}/lower-$TINES_RUN_ID"; sleep 30`,
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

		for (let i = 1; i <= 4; i++) {
			expect(
				(
					await api.post(`/api/v1/projects/${project.id}/issues`, { title: `lower ${i} ${runId}` })
				).status()
			).toBe(201);
		}
		await expect.poll(() => files(markerDir, 'lower-'), { timeout: 20_000 }).toBe(3);
		await gotoHydrated(page, '/agents');
		const card = page.locator('li').filter({ hasText: name }).last();
		await card.getByRole('button', { name: 'Edit', exact: true }).click();
		await dialog.locator('#edit-concurrent').fill('1');
		await dialog.getByRole('button', { name: /^Save/ }).click();
		await expect
			.poll(async () => {
				runner = await body<Runner>(await api.get(`/api/v1/runners/${runner!.id}`));
				return [runner.max_concurrent, runner.concurrency_control?.status];
			})
			.toEqual([1, 'applied']);
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		expect(files(markerDir, 'lower-')).toBe(3);
		const active = await body<{ items: { runner_id: string }[] }>(
			await api.get('/api/v1/runs?active=true')
		);
		expect(active.items.filter((run) => run.runner_id === runner.id)).toHaveLength(3);
	} finally {
		await api.put('/api/v1/supervisor/settings', { enabled: false });
		if (runner) {
			const active = await body<{ items: { id: string; runner_id: string }[] }>(
				await api.get('/api/v1/runs?active=true')
			);
			for (const run of active.items.filter((item) => item.runner_id === runner!.id))
				await api.post(`/api/v1/runs/${run.id}/cancel`);
		}
		daemon?.kill();
		if (rule) await api.delete(`/api/v1/routing-rules/${rule.id}`);
		if (runner) await api.delete(`/api/v1/runners/${runner.id}`, { force: true });
		if (project) {
			const issues = await body<{ items: IssueDetail[] }>(
				await api.get(`/api/v1/projects/${project.id}/issues`)
			);
			for (const issue of issues.items) await api.delete(`/api/v1/issues/${issue.id}`);
			await api.delete(`/api/v1/projects/${project.id}`);
		}
		rmSync(markerDir, { recursive: true, force: true });
	}
});

test('the HTTP boundary rejects stale, excessive, opted-out, legacy, cross-account and run-key writes', async ({
	request
}) => {
	const alice = apiClient(request, ALICE.apiKey);
	const registered = await body<RunnerTokenResponse>(
		await alice.post('/api/v1/runners/register', {
			name: `${name}-boundary`,
			harness: 'custom',
			command: 'true'
		})
	);
	const runnerId = registered.runner.id;
	const poll = (data: object) =>
		request.post(`/api/v1/runners/${runnerId}/poll`, {
			headers: { authorization: `Bearer ${registered.runner_token}` },
			data
		});
	try {
		expect(
			(
				await poll({
					instance_id: 'boundary',
					owned_runs: [],
					max_concurrent: 1,
					concurrency_control: { version: 1, allow_remote: true, ceiling: 3 }
				})
			).status()
		).toBe(200);
		let runner = await body<Runner>(await alice.get(`/api/v1/runners/${runnerId}`));
		const revision = runner.concurrency_control!.revision;
		expect(
			(
				await alice.patch(`/api/v1/runners/${runnerId}`, {
					max_concurrent: 0,
					expected_concurrency_revision: revision
				})
			).status()
		).toBe(422);
		expect(
			(
				await alice.patch(`/api/v1/runners/${runnerId}`, {
					max_concurrent: 4,
					expected_concurrency_revision: revision
				})
			).status()
		).toBe(422);
		expect(
			(
				await alice.patch(`/api/v1/runners/${runnerId}`, {
					max_concurrent: 2,
					expected_concurrency_revision: revision + 1
				})
			).status()
		).toBe(409);
		expect(
			(
				await apiClient(request, BOB.apiKey).patch(`/api/v1/runners/${runnerId}`, {
					max_concurrent: 2,
					expected_concurrency_revision: revision
				})
			).status()
		).toBe(404);
		expect(
			(
				await apiClient(request, RUNROW.runKey).patch(`/api/v1/runners/${runnerId}`, {
					max_concurrent: 2,
					expected_concurrency_revision: revision
				})
			).status()
		).toBe(403);
		expect(
			(
				await apiClient(request, registered.runner_token).patch(`/api/v1/runners/${runnerId}`, {
					max_concurrent: 2,
					expected_concurrency_revision: revision
				})
			).status()
		).toBe(401);
		expect(
			(
				await poll({
					instance_id: 'boundary',
					owned_runs: [],
					max_concurrent: 1,
					concurrency_control: { version: 1, allow_remote: false, ceiling: 3 }
				})
			).status()
		).toBe(200);
		runner = await body<Runner>(await alice.get(`/api/v1/runners/${runnerId}`));
		expect(
			(
				await alice.patch(`/api/v1/runners/${runnerId}`, {
					max_concurrent: 2,
					expected_concurrency_revision: runner.concurrency_control!.revision
				})
			).status()
		).toBe(409);
		expect(
			(await poll({ instance_id: 'boundary', owned_runs: [], max_concurrent: 1 })).status()
		).toBe(200);
		runner = await body<Runner>(await alice.get(`/api/v1/runners/${runnerId}`));
		expect(runner.concurrency_control?.status).toBe('unavailable');
	} finally {
		await alice.delete(`/api/v1/runners/${runnerId}`, { force: true });
	}
});
