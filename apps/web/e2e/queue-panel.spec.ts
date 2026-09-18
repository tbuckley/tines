/**
 * The Now row (Tines/256): eligible issues with no run, grouped by why they
 * are waiting, with each verdict's remedy as a control on the same screen.
 *
 * The scenario needs no daemon. `POST /api/v1/runners` leaves a runner that has
 * never been seen — offline — so the group appears; registering the same name
 * reconnects it (stamping `last_seen_at`), and a settings write queues the
 * dispatch pass that claims one issue as `assigned`, saturating the 1-slot
 * runner. Raising the cap from the panel then has to drain it without a
 * reload. Nothing ever launches: an `assigned` local run waits for a daemon
 * poll that never comes, and the cleanup step disables automation to cancel it.
 */
import type {
	Project,
	RoutingRule,
	Runner,
	RunnerTokenResponse,
	SupervisorSettings
} from '@tines/shared';
import type { APIRequestContext } from '@playwright/test';
import { expect, test as base } from './fixtures';
import { ALICE, RUNROW } from './constants.mjs';
import { apiClient, body, clickUntil, gotoHydrated, resetFocus, runCleanupSteps } from './helpers';

type QueueWorld = { projectId: string; runnerId: string; runnerName: string };
type QueueAudit = {
	projectId?: string;
	runnerId?: string;
	ruleId?: string;
	originalSettings?: SupervisorSettings;
};
const QUEUE_REFRESH_TIMEOUT = 20_000;

const test = base.extend<{}, { queueAudit: QueueAudit; world: QueueWorld }>({
	queueAudit: [
		async ({ apiFor }, use) => {
			const api = apiFor(ALICE);
			const audit: QueueAudit = {};
			await use(audit);

			const settings = await body<SupervisorSettings>(await api.get('/api/v1/supervisor/settings'));
			expect(settings, 'queue teardown restores Alice supervisor settings').toMatchObject({
				enabled: audit.originalSettings?.enabled,
				quota: audit.originalSettings?.quota,
				attempt_limit: audit.originalSettings?.attempt_limit
			});
			if (audit.projectId) {
				const project = await body<Project>(await api.get(`/api/v1/projects/${audit.projectId}`));
				expect(project.archived_at, 'queue teardown archives the project').not.toBeNull();
			}
			if (audit.runnerId) {
				const active = await body<{ items: { runner_id: string }[] }>(
					await api.get('/api/v1/runs?active=true')
				);
				expect(
					active.items.some((run) => run.runner_id === audit.runnerId),
					'queue teardown settles runner-owned runs'
				).toBe(false);
				const runners = await body<{ items: Runner[] }>(await api.get('/api/v1/runners'));
				expect(
					runners.items.some((runner) => runner.id === audit.runnerId),
					'queue teardown deletes the runner'
				).toBe(false);
			}
			if (audit.ruleId) {
				const rules = await body<{ items: RoutingRule[] }>(await api.get('/api/v1/routing-rules'));
				expect(
					rules.items.some((rule) => rule.id === audit.ruleId),
					'queue teardown deletes the routing rule'
				).toBe(false);
			}
		},
		{ scope: 'worker' }
	],
	world: [
		async ({ apiFor, queueAudit, uniqueName }, use) => {
			const api = apiFor(ALICE);
			let projectId: string | undefined;
			let runnerId: string | undefined;
			let ruleId: string | undefined;
			let settingsMutated = false;
			const originalSettings = await body<SupervisorSettings>(
				await api.get('/api/v1/supervisor/settings')
			);
			queueAudit.originalSettings = originalSettings;
			try {
				const project = await body<Project>(
					await api.post('/api/v1/projects', { name: uniqueName('queue-project') })
				);
				projectId = project.id;
				queueAudit.projectId = project.id;
				for (let i = 0; i < 3; i++) {
					expect(
						(
							await api.post(`/api/v1/projects/${project.id}/issues`, {
								title: `waiting ${i} ${project.id}`
							})
						).status()
					).toBe(201);
				}
				// The API accepts 100 characters. Exercise that boundary because a short
				// name cannot expose a non-shrinking action row on a phone.
				const runnerName = uniqueName('queue-worst-case-runner-name-'.repeat(8), {
					maxLength: 100
				});
				const runner = await body<Runner>(
					await api.post('/api/v1/runners', {
						type: 'local',
						name: runnerName,
						max_concurrent: 1
					})
				);
				runnerId = runner.id;
				queueAudit.runnerId = runner.id;
				expect(runner.last_seen_at).toBeNull();
				const rule = await body<RoutingRule>(
					await api.post('/api/v1/routing-rules', {
						project_id: project.id,
						targets: [{ runner_id: runner.id }]
					})
				);
				ruleId = rule.id;
				queueAudit.ruleId = rule.id;
				expect((await api.put('/api/v1/supervisor/settings', { enabled: true })).status()).toBe(
					200
				);
				settingsMutated = true;
				await use({ projectId: project.id, runnerId: runner.id, runnerName });
			} finally {
				await runCleanupSteps([
					...(settingsMutated
						? [
								{
									name: 'disable queue-world automation',
									run: async () => {
										expect(
											(await api.put('/api/v1/supervisor/settings', { enabled: false })).status()
										).toBe(200);
									}
								}
							]
						: []),
					...(runnerId
						? [
								{
									name: `cancel queue-world runs for ${runnerId}`,
									run: async () => {
										const active = await body<{ items: { id: string; runner_id: string }[] }>(
											await api.get('/api/v1/runs?active=true')
										);
										for (const run of active.items.filter((item) => item.runner_id === runnerId)) {
											expect((await api.post(`/api/v1/runs/${run.id}/cancel`)).ok()).toBe(true);
										}
									}
								}
							]
						: []),
					...(ruleId
						? [
								{
									name: `delete queue routing rule ${ruleId}`,
									run: async () => {
										expect((await api.delete(`/api/v1/routing-rules/${ruleId}`)).status()).toBe(
											204
										);
									}
								}
							]
						: []),
					...(runnerId
						? [
								{
									name: `delete queue runner ${runnerId}`,
									run: async () => {
										expect(
											(await api.delete(`/api/v1/runners/${runnerId}`, { force: true })).status()
										).toBe(204);
									}
								}
							]
						: []),
					...(projectId
						? [
								{
									name: `archive queue project ${projectId}`,
									run: async () => {
										expect((await api.post(`/api/v1/projects/${projectId}/archive`)).status()).toBe(
											200
										);
									}
								}
							]
						: []),
					...(settingsMutated
						? [
								{
									name: 'restore Alice supervisor settings',
									run: async () => {
										expect(
											(
												await api.put('/api/v1/supervisor/settings', {
													enabled: originalSettings.enabled,
													quota: originalSettings.quota,
													attempt_limit: originalSettings.attempt_limit
												})
											).status()
										).toBe(200);
									}
								}
							]
						: [])
				]);
			}
		},
		{ scope: 'worker' }
	]
});
test.use({ signedIn: ALICE });

/** Re-register, then confirm the modern local policy before dispatch can use it. */
async function bringOnline(
	api: ReturnType<typeof apiClient>,
	request: APIRequestContext,
	world: QueueWorld
): Promise<void> {
	const res = await api.post('/api/v1/runners/register', {
		name: world.runnerName,
		harness: 'custom',
		command: 'true'
	});
	expect(res.status(), 'reconnect the fixture runner').toBe(201);
	const registered = (await res.json()) as RunnerTokenResponse;
	expect(registered.runner.id).toBe(world.runnerId);
	const poll = await request.post(`/api/v1/runners/${world.runnerId}/poll`, {
		headers: { authorization: `Bearer ${registered.runner_token}` },
		data: {
			instance_id: `queue_${world.runnerId}`,
			owned_runs: [],
			max_concurrent: 1,
			concurrency_control: { version: 1, allow_remote: true, ceiling: 3 }
		}
	});
	expect(poll.status(), 'confirm local concurrency policy').toBe(200);
}

/** Active runs currently claimed by the fixture runner. */
async function claimedRuns(api: ReturnType<typeof apiClient>, world: QueueWorld): Promise<number> {
	const runs = await body<{ items: { runner_id: string }[] }>(
		await api.get('/api/v1/runs?active=true')
	);
	return runs.items.filter((r) => r.runner_id === world.runnerId).length;
}

test.describe.serial('the Now row', () => {
	test('reads "3 waiting · <runner> offline" at the top of /agents', async ({
		page,
		request,
		world
	}) => {
		await resetFocus(request);
		await page.goto('/agents');

		const panel = page.getByRole('region', { name: 'Waiting for an agent' });
		await expect(panel).toContainText(`${world.runnerName} offline`, {
			timeout: QUEUE_REFRESH_TIMEOUT
		});
		await expect(panel).toContainText('3 issues', { timeout: QUEUE_REFRESH_TIMEOUT });
		// Flow 18's remedy, rendered in place rather than linked away.
		await expect(panel).toContainText('tines runner install', { timeout: QUEUE_REFRESH_TIMEOUT });

		// Part 3: the annotations, on the runner card and the rule row.
		await expect(
			page
				.locator(`#runner-${world.runnerId}`)
				.getByRole('link', { name: '3 waiting', exact: true })
		).toBeVisible({ timeout: QUEUE_REFRESH_TIMEOUT });
		await expect(
			page
				.locator('li')
				.filter({ hasText: world.runnerName })
				.getByRole('link', { name: /3 waiting · oldest/ })
				.first()
		).toBeVisible({ timeout: QUEUE_REFRESH_TIMEOUT });
	});

	test('answers a run key on the queue and the settings read, without the PAT hint', async ({
		request,
		world
	}) => {
		const api = apiClient(request, RUNROW.runKey);
		const queue = await api.get('/api/v1/supervisor/queue');
		expect(queue.status()).toBe(200);
		const groups = (await queue.json()).groups as { verdict: string; runner_name: string }[];
		expect(groups.some((g) => g.runner_name === world.runnerName && g.verdict === 'offline')).toBe(
			true
		);

		const settings = await api.get('/api/v1/supervisor/settings');
		expect(settings.status()).toBe(200);
		expect((await settings.json()).github_pat_hint).toBeNull();
	});

	test('flips to "at capacity" once the runner is online and one issue is claimed', async ({
		page,
		request,
		workerRequest,
		world
	}) => {
		const api = apiClient(request, ALICE.apiKey);
		// Reconnect and the first poll both signal dispatch. Hold automation off
		// until both have established liveness and policy, then queue one pass.
		expect((await api.put('/api/v1/supervisor/settings', { enabled: false })).status()).toBe(200);
		await bringOnline(api, workerRequest, world);

		// Enabling queues one opportunistic pass, which claims one issue
		// as `assigned` and saturates the 1-slot runner. The reconnect and
		// came-online signals above observed automation disabled.
		expect((await api.put('/api/v1/supervisor/settings', { enabled: true })).status()).toBe(200);
		await expect
			.poll(() => claimedRuns(api, world), {
				timeout: QUEUE_REFRESH_TIMEOUT,
				message: 'the pass claims one issue for the runner'
			})
			.toBe(1);

		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/agents');
		const panel = page.getByRole('region', { name: 'Waiting for an agent' });
		await expect(panel).toContainText(`at capacity on ${world.runnerName} (1/1)`, {
			timeout: QUEUE_REFRESH_TIMEOUT
		});
		await expect(panel).toContainText('2 issues', { timeout: QUEUE_REFRESH_TIMEOUT });
		const actions = panel.locator(`#queue-runner-${world.runnerId}`).getByTestId('queue-actions');
		await expect(actions).toBeVisible({ timeout: QUEUE_REFRESH_TIMEOUT });
		// Queue and runner data refresh independently. The verdict can render before
		// the runner-backed controls, so give each the page's invalidation budget.
		await expect(
			actions.getByRole('button', { name: `Raise cap on ${world.runnerName}` })
		).toBeVisible({ timeout: QUEUE_REFRESH_TIMEOUT });
		await expect(actions.getByRole('button', { name: 'Quota policy' })).toBeVisible({
			timeout: QUEUE_REFRESH_TIMEOUT
		});
		const geometry = await actions.evaluate((element) => {
			const panelElement = element.closest('section');
			if (!panelElement) throw new Error('queue actions are outside the queue panel');
			const box = (target: Element) => {
				const { x, width } = target.getBoundingClientRect();
				return { x, width };
			};
			return {
				panel: box(panelElement),
				actions: box(element),
				buttons: [...element.querySelectorAll('button')]
					.filter((button) => button.checkVisibility())
					.map(box)
			};
		});
		expect(geometry.panel.x + geometry.panel.width).toBeLessThanOrEqual(390);
		expect(geometry.actions.x).toBeGreaterThanOrEqual(geometry.panel.x);
		expect(geometry.actions.x + geometry.actions.width).toBeLessThanOrEqual(
			geometry.panel.x + geometry.panel.width
		);
		expect(geometry.buttons).toHaveLength(2);
		for (const box of geometry.buttons) {
			expect(box.x).toBeGreaterThanOrEqual(geometry.panel.x);
			expect(box.x + box.width).toBeLessThanOrEqual(geometry.panel.x + geometry.panel.width);
			expect(box.x + box.width).toBeLessThanOrEqual(390);
		}
	});

	test('drains the group when the cap is raised from the panel, without a reload', async ({
		page,
		request,
		world
	}) => {
		// The preceding test just heartbeated the runner, well inside its
		// two-minute online window. Re-registering here would reset its liveness
		// and queue two redundant dispatch passes that can consume this group.
		const api = apiClient(request, ALICE.apiKey);

		// This test clicks, so it waits for hydration (CLAUDE.md); the read-only
		// tests above stay on a bare goto.
		await gotoHydrated(page, '/agents');
		const panel = page.getByRole('region', { name: 'Waiting for an agent' });
		await expect(panel).toContainText(`at capacity on ${world.runnerName}`, {
			timeout: QUEUE_REFRESH_TIMEOUT
		});

		const dialog = page.getByRole('dialog');
		const capField = dialog.locator('#edit-concurrent');
		// Retry the open until the field is there, and only while the dialog is
		// closed, so a retry cannot toggle an open one shut: on CI the first
		// click on a freshly loaded page can still land before the handler is
		// attached, and the failure reads as "no dialog" rather than as a
		// swallowed click.
		await clickUntil(panel.getByRole('button', { name: `Raise cap on ${world.runnerName}` }), () =>
			expect(capField).toBeVisible({ timeout: 1000 })
		);
		// The remedy lands the caret on the field it is about — the operator
		// types a number, never hunts for it in the dialog.
		await expect(capField).toBeFocused();
		await capField.fill('3');
		// Scoped to the dialog: the settings form behind it has a Save too, and
		// the modal overlay swallows the click aimed at it.
		await dialog.getByRole('button', { name: /^Save/ }).click();

		// No `page.reload()`: the shrink has to arrive through the invalidation
		// the write schedules, which is the point of the acceptance criterion.
		await expect(panel).not.toContainText('at capacity', { timeout: QUEUE_REFRESH_TIMEOUT });
		await expect(panel).not.toContainText(`${world.runnerName} offline`, {
			timeout: QUEUE_REFRESH_TIMEOUT
		});
	});
});
