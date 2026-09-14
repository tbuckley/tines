import { createServer, type Server } from 'node:http';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
	IssueDetail,
	Project,
	RoutingRule,
	Runner,
	RunnerTokenResponse,
	SupervisorSettings
} from '@tines/shared';
import { expect, test } from '@playwright/test';
import { ALICE, BASE_URL, BOB, RUNROW } from './constants.mjs';
import { spawnDaemon, transitionHarnessCommand, type Daemon } from './daemon';
import { apiClient, body, clickUntil, gotoHydrated, runId, signIn } from './helpers';

const name = `concurrency-${runId}`;

function files(dir: string, prefix: string): number {
	return readdirSync(dir).filter((entry) => entry.startsWith(prefix) && entry.endsWith('.started'))
		.length;
}

function barrierCommand(dir: string, prefix: string): string {
	return [
		'set -eu',
		'BASE=$(basename "$PWD")',
		`touch "${dir}/${prefix}-$BASE.started"`,
		`while [ ! -f "${dir}/${prefix}-$BASE.release" ]; do sleep 0.1; done`,
		transitionHarnessCommand('Submit for review')
	].join('\n');
}

function releaseMarkers(dir: string, prefix: string, count = Infinity): void {
	for (const entry of readdirSync(dir)
		.filter((item) => item.startsWith(`${prefix}-`) && item.endsWith('.started'))
		.slice(0, count)) {
		writeFileSync(join(dir, entry.replace(/\.started$/, '.release')), 'release\n');
	}
}

type PollGate = { arrived: Promise<void>; release: () => void };

async function startPollProxy(): Promise<{
	url: string;
	polls: () => number;
	holdNextPoll: () => PollGate;
	close: () => Promise<void>;
}> {
	let polls = 0;
	let held: { arrived: () => void; released: Promise<void>; release: () => void } | undefined;
	const server: Server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		if (req.url?.endsWith('/poll')) {
			polls++;
			if (held) {
				const gate = held;
				held = undefined;
				gate.arrived();
				await gate.released;
			}
		}
		try {
			const headers = new Headers();
			for (const [key, value] of Object.entries(req.headers)) {
				if (key === 'host' || value === undefined) continue;
				headers.set(key, Array.isArray(value) ? value.join(', ') : value);
			}
			const method = req.method ?? 'GET';
			const upstream = await fetch(`${BASE_URL}${req.url ?? '/'}`, {
				method,
				headers,
				...(method === 'GET' || method === 'HEAD' ? {} : { body: Buffer.concat(chunks) })
			});
			res.statusCode = upstream.status;
			upstream.headers.forEach((value, key) => {
				// fetch() has decoded the response body. Reusing its original body
				// framing/compression headers would make the daemon decode it twice.
				if (['connection', 'content-encoding', 'content-length', 'transfer-encoding'].includes(key))
					return;
				res.setHeader(key, value);
			});
			res.end(Buffer.from(await upstream.arrayBuffer()));
		} catch (error) {
			res.statusCode = 502;
			res.end(error instanceof Error ? error.message : String(error));
		}
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		polls: () => polls,
		holdNextPoll: () => {
			let arrive!: () => void;
			let release!: () => void;
			const arrived = new Promise<void>((resolve) => (arrive = resolve));
			const released = new Promise<void>((resolve) => (release = resolve));
			held = { arrived: arrive, released, release };
			return { arrived, release };
		},
		close: () =>
			new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
	};
}

test('the Now remedy persists 1→3 through real daemon polls, restart, re-registration, and lowering', async ({
	context,
	page,
	request
}) => {
	test.setTimeout(120_000);
	const api = apiClient(request, ALICE.apiKey);
	const markerDir = mkdtempSync(join(tmpdir(), 'tines-concurrency-markers-'));
	const proxy = await startPollProxy();
	let daemon: Daemon | null = null;
	let runner: Runner | undefined;
	let project: Project | undefined;
	let rule: RoutingRule | undefined;
	let originalSettings: SupervisorSettings | undefined;
	try {
		daemon = spawnDaemon({
			apiKey: ALICE.apiKey,
			name,
			command: barrierCommand(markerDir, 'first'),
			maxConcurrent: 3,
			allowRemoteConcurrency: true,
			url: proxy.url
		});
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
		originalSettings = await body<SupervisorSettings>(await api.get('/api/v1/supervisor/settings'));
		expect(
			(
				await api.put('/api/v1/supervisor/settings', {
					enabled: true,
					quota: { type: 'global_cap', limit: 3 }
				})
			).status()
		).toBe(200);
		await expect.poll(() => files(markerDir, 'first-'), { timeout: 30_000 }).toBe(1);

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
		await expect.poll(() => files(markerDir, 'first-'), { timeout: 30_000 }).toBe(3);
		await expect
			.poll(async () => {
				runner = await body<Runner>(await api.get(`/api/v1/runners/${runner!.id}`));
				return [runner.max_concurrent, runner.concurrency_control?.applied_cap];
			})
			.toEqual([3, 3]);
		const sustainedFrom = proxy.polls();
		await expect.poll(proxy.polls, { timeout: 20_000 }).toBeGreaterThanOrEqual(sustainedFrom + 3);
		releaseMarkers(markerDir, 'first');
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
		const restartFrom = proxy.polls();
		daemon = spawnDaemon({
			apiKey: ALICE.apiKey,
			name,
			command: barrierCommand(markerDir, 'lower'),
			maxConcurrent: 3,
			allowRemoteConcurrency: true,
			configDir,
			url: proxy.url
		});
		await expect.poll(daemon.output, { timeout: 20_000 }).toContain('reconnecting as runner');
		await expect.poll(proxy.polls, { timeout: 20_000 }).toBeGreaterThanOrEqual(restartFrom + 2);
		await expect
			.poll(
				async () => {
					runner = await body<Runner>(await api.get(`/api/v1/runners/${runner!.id}`));
					return [runner.max_concurrent, runner.concurrency_control?.status];
				},
				{ timeout: 20_000, message: daemon.output() }
			)
			.toEqual([3, 'applied']);

		// Delete the stored runner credential, then hold the new daemon's first
		// policy poll. Registration must preserve the identity and web request,
		// while truthfully making the control unavailable until that poll lands.
		daemon.stop();
		await new Promise((resolve) => daemon!.proc.once('exit', resolve));
		rmSync(join(configDir, 'runners.json'), { force: true });
		const firstPolicyPoll = proxy.holdNextPoll();
		daemon = spawnDaemon({
			apiKey: ALICE.apiKey,
			name,
			command: barrierCommand(markerDir, 'lower'),
			maxConcurrent: 3,
			allowRemoteConcurrency: true,
			configDir,
			url: proxy.url
		});
		await firstPolicyPoll.arrived;
		const awaitingPolicy = await body<Runner>(await api.get(`/api/v1/runners/${runner.id}`));
		expect(awaitingPolicy).toMatchObject({ id: runner.id, max_concurrent: 3 });
		expect(awaitingPolicy.concurrency_control).toMatchObject({
			status: 'unavailable',
			reason: 'awaiting_policy',
			requested_cap: 3
		});
		expect(daemon.output()).toContain(`registered runner "${name}" (${runner.id})`);
		firstPolicyPoll.release();
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
		await expect.poll(() => files(markerDir, 'lower-'), { timeout: 30_000 }).toBe(3);
		await gotoHydrated(page, '/agents');
		const card = page.locator(`#runner-${runner.id}`);
		await card.getByRole('button', { name: 'Edit', exact: true }).click();
		await dialog.locator('#edit-concurrent').fill('1');
		await dialog.getByRole('button', { name: /^Save/ }).click();
		await expect
			.poll(async () => {
				runner = await body<Runner>(await api.get(`/api/v1/runners/${runner!.id}`));
				return [runner.max_concurrent, runner.concurrency_control?.status];
			})
			.toEqual([1, 'applied']);
		// Release exactly one active harness. The global quota now permits a
		// replacement (2/3), but the lowered cap (2 active over cap 1) must not.
		releaseMarkers(markerDir, 'lower', 1);
		await expect
			.poll(async () => {
				const active = await body<{ items: { runner_id: string }[] }>(
					await api.get('/api/v1/runs?active=true')
				);
				return active.items.filter((run) => run.runner_id === runner!.id).length;
			})
			.toBe(2);
		const loweredFrom = proxy.polls();
		await expect.poll(proxy.polls, { timeout: 20_000 }).toBeGreaterThanOrEqual(loweredFrom + 2);
		expect(files(markerDir, 'lower-')).toBe(3);
		const active = await body<{ items: { runner_id: string }[] }>(
			await api.get('/api/v1/runs?active=true')
		);
		expect(active.items.filter((run) => run.runner_id === runner.id)).toHaveLength(2);
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
		if (originalSettings) {
			await api.put('/api/v1/supervisor/settings', {
				enabled: originalSettings.enabled,
				quota: originalSettings.quota
			});
		}
		await proxy.close();
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
