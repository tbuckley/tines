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
import type { IssueDetail, Project, RoutingRule, Runner } from '@tines/shared';
import { expect, test } from './fixtures';
import { ALICE, RUNROW } from './constants.mjs';
import { apiClient, body, clickUntil, gotoHydrated, resetFocus, runId, signIn } from './helpers';

const PROJECT_NAME = `queue-${runId}`;
const RUNNER_NAME = `queue-${runId}`;

let projectId: string;
let runnerId: string;
let ruleId: string;

/** Registering an existing name reconnects it: stamps `last_seen_at`, mints a token. */
async function bringOnline(api: ReturnType<typeof apiClient>): Promise<void> {
	const res = await api.post('/api/v1/runners/register', {
		name: RUNNER_NAME,
		harness: 'custom',
		command: 'true'
	});
	expect(res.status(), 'reconnect the fixture runner').toBe(201);
	expect((await res.json()).runner.id).toBe(runnerId);
}

/** Active runs currently claimed by the fixture runner. */
async function claimedRuns(api: ReturnType<typeof apiClient>): Promise<number> {
	const runs = await body<{ items: { runner_id: string }[] }>(
		await api.get('/api/v1/runs?active=true')
	);
	return runs.items.filter((r) => r.runner_id === runnerId).length;
}

test.describe.serial('the Now row', () => {
	test('seeds three eligible issues behind one offline runner', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const project = await body<Project>(await api.post('/api/v1/projects', { name: PROJECT_NAME }));
		projectId = project.id;

		// The rule is scoped to the project, not to a state: a new project's
		// issues open in its workflow's initial state, which is active, so all
		// three are eligible without naming it.

		for (let i = 0; i < 3; i++) {
			const res = await api.post(`/api/v1/projects/${projectId}/issues`, {
				title: `waiting ${i} ${runId}`
			});
			expect(res.status(), 'seeded issue').toBe(201);
		}

		// Created rather than registered: `register` stamps `last_seen_at`, so a
		// registered runner is online from birth and the offline group never
		// appears. The later phase registers this same name to reconnect it,
		// which both mints the token and puts it online.
		const runner = await body<Runner>(
			await api.post('/api/v1/runners', {
				type: 'local',
				name: RUNNER_NAME,
				max_concurrent: 1
			})
		);
		runnerId = runner.id;
		expect(runner.last_seen_at, 'a created runner has never polled').toBeNull();

		// Project-scoped: a global rule would route every other spec's issues here.
		const rule = await body<RoutingRule>(
			await api.post('/api/v1/routing-rules', {
				project_id: projectId,
				targets: [{ runner_id: runnerId }]
			})
		);
		ruleId = rule.id;

		expect((await api.put('/api/v1/supervisor/settings', { enabled: true })).status()).toBe(200);
	});

	test('reads "3 waiting · <runner> offline" at the top of /agents', async ({
		context,
		page,
		request
	}) => {
		await resetFocus(request);
		await signIn(context, ALICE.sessionToken);
		await page.goto('/agents');

		const panel = page.getByRole('region', { name: 'Waiting for an agent' });
		await expect(panel).toContainText(`${RUNNER_NAME} offline`);
		await expect(panel).toContainText('3 issues');
		// Flow 18's remedy, rendered in place rather than linked away.
		await expect(panel).toContainText('tines runner install');

		// Part 3: the annotations, on the runner card and the rule row.
		await expect(page.getByRole('link', { name: '3 waiting', exact: true })).toBeVisible();
		await expect(page.getByRole('link', { name: /3 waiting · oldest/ }).first()).toBeVisible();
	});

	test('answers a run key on the queue and the settings read, without the PAT hint', async ({
		request
	}) => {
		const api = apiClient(request, RUNROW.runKey);
		const queue = await api.get('/api/v1/supervisor/queue');
		expect(queue.status()).toBe(200);
		const groups = (await queue.json()).groups as { verdict: string; runner_name: string }[];
		expect(groups.some((g) => g.runner_name === RUNNER_NAME && g.verdict === 'offline')).toBe(true);

		const settings = await api.get('/api/v1/supervisor/settings');
		expect(settings.status()).toBe(200);
		expect((await settings.json()).github_pat_hint).toBeNull();
	});

	test('flips to "at capacity" once the runner is online and one issue is claimed', async ({
		context,
		page,
		request
	}) => {
		const api = apiClient(request, ALICE.apiKey);
		await bringOnline(api);

		// A settings write queues an opportunistic pass, which claims one issue
		// as `assigned` and saturates the 1-slot runner. (The poll route only
		// queues a pass when the runner *comes* online, and registering already
		// stamped `last_seen_at`.)
		expect((await api.put('/api/v1/supervisor/settings', { enabled: true })).status()).toBe(200);
		await expect
			.poll(() => claimedRuns(api), {
				timeout: 20_000,
				message: 'the pass claims one issue for the runner'
			})
			.toBe(1);

		await signIn(context, ALICE.sessionToken);
		await page.goto('/agents');
		const panel = page.getByRole('region', { name: 'Waiting for an agent' });
		await expect(panel).toContainText(`at capacity on ${RUNNER_NAME} (1/1)`);
		await expect(panel).toContainText('2 issues');
	});

	test('drains the group when the cap is raised from the panel, without a reload', async ({
		context,
		page,
		request
	}) => {
		// The online window is two minutes; re-register so the verdict is
		// capacity, not the runner having gone quiet while the last test ran.
		const api = apiClient(request, ALICE.apiKey);
		await bringOnline(api);

		await signIn(context, ALICE.sessionToken);
		// This test clicks, so it waits for hydration (CLAUDE.md); the read-only
		// tests above stay on a bare goto.
		await gotoHydrated(page, '/agents');
		const panel = page.getByRole('region', { name: 'Waiting for an agent' });
		await expect(panel).toContainText(`at capacity on ${RUNNER_NAME}`);

		const dialog = page.getByRole('dialog');
		const capField = dialog.locator('#edit-concurrent');
		// Retry the open until the field is there, and only while the dialog is
		// closed, so a retry cannot toggle an open one shut: on CI the first
		// click on a freshly loaded page can still land before the handler is
		// attached, and the failure reads as "no dialog" rather than as a
		// swallowed click.
		await clickUntil(panel.getByRole('button', { name: `Raise cap on ${RUNNER_NAME}` }), () =>
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
		await expect(panel).not.toContainText('at capacity', { timeout: 20_000 });
		await expect(panel).not.toContainText(`${RUNNER_NAME} offline`);
	});

	test('cleans up the fixture fleet', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		// Disabling cancels the claims this spec seeded, fleet-wide.
		await api.put('/api/v1/supervisor/settings', { enabled: false });
		await api.delete(`/api/v1/routing-rules/${ruleId}`);
		await api.delete(`/api/v1/runners/${runnerId}`, { force: true });
		const runners = await body<{ items: Runner[] }>(await api.get('/api/v1/runners'));
		expect(runners.items.some((r) => r.id === runnerId)).toBe(false);
		const issues = await body<{ items: IssueDetail[] }>(
			await api.get(`/api/v1/projects/${projectId}/issues`)
		);
		expect(issues.items.length).toBe(3);
	});
});
