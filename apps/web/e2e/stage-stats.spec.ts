/**
 * The This week row's route and UI wiring: project narrowing, lever links and
 * sent-back evidence. The fixture uses API writes only; no runner daemon.
 */
import type {
	ContextItem,
	IssueDetail,
	Project,
	UserPreferences,
	StageStatsReport,
	WorkflowResponse
} from '@tines/shared';
import { expect, test } from '@playwright/test';
import { WEEKLY } from './stage-stats-seed.mjs';
import { ALICE } from './constants.mjs';
import { apiClient, body, clickToOpen, gotoHydrated, runId, signIn } from './helpers';

const projectName = `stage-stats-${runId}`;
const otherProjectName = `stage-stats-other-${runId}`;
let project: Project;
let workflow: WorkflowResponse;
let reviewStateId: string;

test.beforeAll(async ({ playwright }) => {
	const request = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
	const api = apiClient(request, ALICE.apiKey);
	workflow = await body<WorkflowResponse>(
		await api.post('/api/v1/workflows', {
			name: `Stage stats ${runId}`,
			initial_state: 'Implementation',
			states: [
				{ name: 'Implementation', category: 'active' },
				{ name: 'Automated Review', category: 'active' },
				{ name: 'Done', category: 'done' }
			],
			transitions: [
				{ name: 'submit', from: 'Implementation', to: 'Automated Review' },
				{ name: 'send back', from: 'Automated Review', to: 'Implementation' },
				{ name: 'finish', from: 'Automated Review', to: 'Done' }
			]
		})
	);
	reviewStateId = workflow.states.find((state) => state.name === 'Automated Review')!.id;
	project = await body<Project>(
		await api.post('/api/v1/projects', {
			name: projectName,
			default_workflow_id: workflow.id
		})
	);
	const other = await body<Project>(
		await api.post('/api/v1/projects', {
			name: otherProjectName,
			default_workflow_id: workflow.id
		})
	);
	await body<ContextItem>(
		await api.post('/api/v1/context', {
			kind: 'prompt',
			name: 'instructions',
			workflow_state_id: reviewStateId,
			body: 'Review carefully.'
		})
	);

	const seedVisit = async (projectId: string, title: string, sendBack: boolean) => {
		let issue = await body<IssueDetail>(
			await api.post(`/api/v1/projects/${projectId}/issues`, { title })
		);
		const submit = issue.allowed_transitions.find((transition) => transition.name === 'submit')!;
		issue = await body<IssueDetail>(
			await api.post(`/api/v1/issues/${issue.id}/transition`, {
				transition_id: submit.transition_id
			})
		);
		if (sendBack) {
			await api.post(`/api/v1/issues/${issue.id}/comments`, {
				body: 'Please address the findings.'
			});
			const back = issue.allowed_transitions.find((transition) => transition.name === 'send back')!;
			await api.post(`/api/v1/issues/${issue.id}/transition`, {
				transition_id: back.transition_id
			});
		}
	};
	await seedVisit(project.id, `Sent back ${runId}`, true);
	await seedVisit(other.id, `Other visit ${runId}`, false);
	await request.dispose();
});

test('filters the weekly board, focuses capacity, and opens frozen historical evidence', async ({
	context,
	page
}) => {
	await signIn(context, ALICE.sessionToken);
	await gotoHydrated(page, `/agents?project=${project.id}`);
	await expect(page.getByLabel('Board project')).toHaveValue(project.id);
	const section = page.getByRole('region', { name: 'This week' });
	await expect(section.getByRole('columnheader')).toHaveCount(4);
	const row = section.locator('tr.stage-row').filter({ hasText: 'Automated Review' });
	await expect(row).toContainText('1 visit');
	await expect(row).toContainText('1 of 1 exits');
	const runLink = row.getByRole('link', { name: /runs per visit/ });
	await expect(runLink).toHaveAttribute(
		'href',
		`/agents?project=${project.id}&runs_state=${reviewStateId}#runs`
	);
	await row.getByRole('button', { name: /wait to start/ }).click();
	await expect(page.locator('#global-limit')).toBeFocused();
	const trigger = row.getByRole('button', { name: /sent back: view evidence/ });
	const dialog = page.getByRole('dialog', { name: 'Send-back evidence' });
	const request = page.waitForRequest((r) => r.url().includes('/stats/sent-back?'));
	await clickToOpen(trigger, dialog);
	expect(new URL((await request).url()).searchParams.get('until')).toMatch(/^\d+$/);
	await expect(dialog).toContainText('instructions · v1 at the time');
	await expect(dialog).toContainText('Please address the findings.');
	await expect(dialog.getByRole('link', { name: 'Edit current stage prompt' })).toHaveAttribute(
		'href',
		new RegExp(`/workflows/${workflow.id}\\?state=${reviewStateId}`)
	);
	await dialog.getByText('Historical prompt context ID').click();
	await expect(dialog.locator('code')).toContainText('ctx_');
	await page.keyboard.press('Escape');
	await expect(dialog).not.toBeVisible();
	await expect(trigger).toBeFocused();
	await runLink.click();
	await expect(page).toHaveURL(new RegExp(`runs_state=${reviewStateId}#runs$`));
	await expect(page.locator('#runs')).toContainText('Latest runs for this stage');
	await expect(page.getByLabel('Show ended runs')).toBeChecked();
	await page.locator('#runs').getByRole('link', { name: /clear/ }).click();
	await expect(page).toHaveURL(new RegExp(`project=${project.id}#runs$`));
});

for (const width of [1440, 768, 390, 320])
	test(`weekly overview, details and evidence fit at ${width}px`, async ({ context, page }) => {
		await page.setViewportSize({ width, height: 900 });
		await signIn(context, ALICE.sessionToken);
		await gotoHydrated(page, `/agents?project=${project.id}`);
		const section = page.getByRole('region', { name: 'This week' });
		const row = section.locator('tr.stage-row').filter({ hasText: 'Automated Review' });
		const assertFits = async () => {
			expect(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= document.documentElement.clientWidth
				)
			).toBe(true);
			expect(await section.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
		};
		await assertFits();
		await section.screenshot({ path: `/tmp/tines257-screenshots/overview-${width}.png` });
		await row.getByRole('button', { name: 'Automated Review', exact: true }).click();
		const detail = section.locator(`#stage-detail-${reviewStateId}`);
		await expect(detail.getByText('Timing and visits', { exact: true })).toBeVisible();
		await expect(detail.getByText('Timed queue visits', { exact: true })).toBeVisible();
		await assertFits();
		await section.screenshot({ path: `/tmp/tines257-screenshots/detail-${width}.png` });
		const dialog = page.getByRole('dialog', { name: 'Send-back evidence' });
		await clickToOpen(row.getByRole('button', { name: /sent back: view evidence/ }), dialog);
		await expect(dialog).toContainText('Please address the findings.');
		expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
		await dialog.screenshot({ path: `/tmp/tines257-screenshots/evidence-${width}.png` });
		await page.keyboard.press('Escape');
	});

test('evidence errors remain retryable with the same frozen query', async ({ context, page }) => {
	await signIn(context, ALICE.sessionToken);
	await gotoHydrated(page, `/agents?project=${project.id}`);
	const queries: string[] = [];
	await page.route('**/api/v1/supervisor/stats/sent-back?**', async (route) => {
		queries.push(route.request().url());
		if (queries.length === 1)
			await route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: JSON.stringify({ error: { code: 'internal_error', message: 'Try again' } })
			});
		else await route.continue();
	});
	const row = page.locator('tr.stage-row').filter({ hasText: 'Automated Review' });
	const dialog = page.getByRole('dialog', { name: 'Send-back evidence' });
	await clickToOpen(row.getByRole('button', { name: /sent back: view evidence/ }), dialog);
	await expect(dialog.getByRole('alert')).toBeVisible();
	await dialog.getByRole('button', { name: 'Retry' }).click();
	await expect(dialog).toContainText('Please address the findings.');
	expect(queries[1]).toBe(queries[0]);
});

for (const width of [1440, 390])
	test(`populated board highlights and changes at ${width}px`, async ({ context, page }) => {
		await page.setViewportSize({ width, height: 1000 });
		await signIn(context, WEEKLY.sessionToken);
		await gotoHydrated(page, `/agents?project=${WEEKLY.projectId}`);
		const section = page.getByRole('region', { name: 'This week' });
		const highlights = section.getByRole('button', { name: /Most/ });
		await expect(highlights).toHaveCount(3);
		await expect(highlights.nth(0)).toContainText('Research');
		await expect(highlights.nth(1)).toContainText('Automated Review');
		await expect(highlights.nth(2)).toContainText('11 of 20 runs failed to start');
		const review = section.locator('tr.stage-row').filter({ hasText: 'Automated Review' });
		await expect(review).toContainText('20%');
		await expect(review).toContainText('Up 11 pp');
		await expect(review).toContainText('was 9%');
		await section.scrollIntoViewIfNeeded();
		await section.screenshot({
			path: `/tmp/tines257-screenshots/populated-${width}.png`,
			style: 'header.sticky,nav.fixed { visibility: hidden !important; }'
		});
		await highlights.nth(0).click();
		await expect(page.locator('#stats-ws_research-timing')).toBeFocused();
		await expect(section.getByText('Timed queue visits', { exact: true })).toBeVisible();
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= document.documentElement.clientWidth
			)
		).toBe(true);
		await highlights.nth(2).click();
		await expect(page.locator('#stats-ws_discovering-runs')).toBeFocused();
		await expect(section.getByText('Failed to start', { exact: true })).toBeVisible();
		await section.screenshot({
			path: `/tmp/tines257-screenshots/populated-detail-${width}.png`,
			style: 'header.sticky,nav.fixed { visibility: hidden !important; }'
		});
		await section.getByRole('button', { name: /^\d+ changes this week$/ }).click();
		const dialog = page.getByRole('dialog', { name: 'Latest changes in this window' });
		await expect(dialog).toContainText('Runner cap');
		await expect(dialog).toContainText('Routing rule');
		await expect(dialog).toContainText('Quota');
		await expect(dialog).toContainText('Prompt');
		await dialog.locator('summary').filter({ hasText: 'Prompt' }).click();
		await expect(
			dialog.locator('details[open]').getByText('Before', { exact: true })
		).toBeVisible();
		await expect(dialog.locator('details[open]').getByText('Since', { exact: true })).toBeVisible();
		expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
		await page.keyboard.press('Escape');
		await page.emulateMedia({ colorScheme: 'dark' });
		await section.screenshot({
			path: `/tmp/tines257-screenshots/dark-${width}.png`,
			style: 'header.sticky,nav.fixed { visibility: hidden !important; }'
		});
	});

test('late evidence cannot replace another stage and keyboard focus stays in the viewer', async ({
	context,
	page
}) => {
	await signIn(context, ALICE.sessionToken);
	await gotoHydrated(page, `/agents?project=${project.id}`);
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => (release = resolve));
	let ready: () => void = () => {};
	const captured = new Promise<void>((resolve) => (ready = resolve));
	await page.route('**/api/v1/supervisor/stats/sent-back?**', async (route) => {
		if (new URL(route.request().url()).searchParams.get('state') !== reviewStateId) {
			await route.continue();
			return;
		}
		const response = await route.fetch();
		ready();
		await held;
		await route.fulfill({ response });
	});
	const section = page.getByRole('region', { name: 'This week' });
	const dialog = page.getByRole('dialog', { name: 'Send-back evidence' });
	await section
		.locator('tr.stage-row')
		.filter({ hasText: 'Automated Review' })
		.getByRole('button', { name: /sent back: view evidence/ })
		.click();
	await captured;
	await page.keyboard.press('Escape');
	await section
		.locator('tr.stage-row')
		.filter({ hasText: 'Implementation' })
		.getByRole('button', { name: /sent back: view evidence/ })
		.click();
	await expect(dialog.getByRole('heading', { name: 'Implementation', exact: true })).toBeVisible();
	release();
	await expect(dialog).toContainText('No send-back events in this window.');
	await expect(dialog).not.toContainText('Please address the findings.');
	for (let i = 0; i < 8; i++) {
		await page.keyboard.press('Tab');
		expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
	}
	await page.keyboard.press('Escape');
});

test('rule creation project is one-shot and does not become Board project', async ({
	context,
	page
}) => {
	await signIn(context, ALICE.sessionToken);
	await gotoHydrated(page, `/agents?new=rule&project=${project.id}`);
	await expect(page.getByRole('dialog', { name: 'New routing rule' })).toBeVisible();
	await expect(page.locator('#rule-project')).toHaveValue(project.id);
	await expect(page.getByLabel('Board project')).toHaveValue('');
	await expect(page).not.toHaveURL(/new=rule/);
});

test('capacity follows the saved roster and run selection remains reactive', async ({
	context,
	page,
	request
}) => {
	const api = apiClient(request, WEEKLY.apiKey);
	await api.put('/api/v1/supervisor/settings', {
		quota: { type: 'state_roster', default_limit: 2, overrides: {} }
	});
	try {
		await signIn(context, WEEKLY.sessionToken);
		await gotoHydrated(page, `/agents?project=${WEEKLY.projectId}&runs_state=ws_review`);
		await page.getByLabel('Show ended runs').uncheck();
		const section = page.getByRole('region', { name: 'This week' });
		await section
			.locator('tr.stage-row')
			.filter({ hasText: 'Research' })
			.getByRole('link', { name: /runs per visit/ })
			.click();
		await expect(page.getByLabel('Show ended runs')).toBeChecked();
		await section
			.locator('tr.stage-row')
			.filter({ hasText: 'Research' })
			.getByRole('button', { name: /wait to start/ })
			.click();
		await expect(page.locator('#roster-limit-ws_research')).toBeFocused();
	} finally {
		await api.put('/api/v1/supervisor/settings', { quota: { type: 'global_cap', limit: 3 } });
	}
});

test('overview remains usable at 200 percent zoom', async ({ context, page }) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await signIn(context, WEEKLY.sessionToken);
	await gotoHydrated(page, `/agents?project=${WEEKLY.projectId}`);
	await page.evaluate(() => (document.body.style.zoom = '2'));
	const section = page.getByRole('region', { name: 'This week' });
	expect(await section.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
	await section.getByRole('button', { name: /Most measured wait/ }).click();
	await expect(page.locator('#stats-ws_research-timing')).toBeFocused();
});

test('Now and Spend retain separate project scopes through history and weekly levers', async ({
	context,
	page
}, testInfo) => {
	await signIn(context, WEEKLY.sessionToken);
	await gotoHydrated(
		page,
		`/agents?project=${WEEKLY.projectId}&spend_project=all&spend_window=30d`
	);
	const week = page.getByRole('region', { name: 'This week' });
	await expect(week).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('weekly-desktop.png'), fullPage: true });
	await page.getByRole('button', { name: 'Spend', exact: true }).click();
	await expect(page.getByLabel('Spend project')).toHaveValue('all');
	await expect(page.getByLabel('Board project')).toBeHidden();
	await expect(page).toHaveURL(/agents_view=spend/);
	await page.getByRole('button', { name: 'Now', exact: true }).click();
	await expect(page.getByLabel('Board project')).toHaveValue(WEEKLY.projectId);
	const review = week.locator('tr.stage-row').filter({ hasText: 'Automated Review' });
	await review.getByRole('link', { name: /runs per visit/ }).click();
	await expect(page.locator('#runs')).toContainText('Latest runs for this stage: Automated Review');
	await expect(page.getByLabel('Show ended runs')).toBeChecked();
	await expect(page).toHaveURL(/spend_window=30d/);
	await page.getByRole('button', { name: 'Spend', exact: true }).click();
	await expect(page.getByLabel('Spend project')).toHaveValue('all');
	await page.goBack();
	await expect(page.locator('#runs')).toBeVisible();
	await expect(page.getByLabel('Board project')).toHaveValue(WEEKLY.projectId);
	await review.getByRole('button', { name: /wait to start/ }).click();
	await expect(page.locator('#global-limit')).toBeFocused();
	await page.setViewportSize({ width: 390, height: 844 });
	await week.scrollIntoViewIfNeeded();
	await expect(page.locator('body')).toHaveJSProperty(
		'scrollWidth',
		await page.locator('body').evaluate((el) => el.clientWidth)
	);
	await week.screenshot({ path: testInfo.outputPath('weekly-phone.png') });
});

test('rapid board project changes commit only the latest scope without altering Spend', async ({
	context,
	page
}) => {
	await signIn(context, ALICE.sessionToken);
	await gotoHydrated(page, `/agents?project=${project.id}&spend_project=all&spend_window=30d`);
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let settled!: () => void;
	const completed = new Promise<void>((resolve) => {
		settled = resolve;
	});
	let didHold = false;
	await page.route('**/agents/__data.json*', async (route) => {
		const url = new URL(route.request().url());
		if (!url.searchParams.has('project') && !didHold) {
			didHold = true;
			const response = await route.fetch();
			entered();
			await held;
			await route.fulfill({ response });
			settled();
		} else await route.continue();
	});
	const board = page.getByLabel('Board project');
	await board.selectOption('');
	await started;
	await board.selectOption(project.id);
	await expect(page).toHaveURL(new RegExp(`project=${project.id}`));
	release();
	await completed;
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
	await expect
		.poll(() =>
			page
				.getByRole('region', { name: 'This week' })
				.locator('tr.stage-row')
				.filter({ hasText: 'Automated Review' })
				.textContent()
		)
		.toMatch(/1\s+visit/);
	await expect(board).toHaveValue(project.id);
	await page.getByRole('button', { name: 'Spend', exact: true }).click();
	await expect(page.getByLabel('Spend project')).toHaveValue('all');
	await expect(page).toHaveURL(/spend_window=30d/);
});

for (const width of [1440, 390])
	test(`change evidence overrides sticky focus without changing it at ${width}px`, async ({
		context,
		page,
		request
	}, testInfo) => {
		const api = apiClient(request, WEEKLY.apiKey);
		const original = await body<UserPreferences>(await api.get('/api/v1/preferences'));
		await body(await api.patch('/api/v1/preferences', { focused_project_id: WEEKLY.projectId }));
		try {
			await page.setViewportSize({ width, height: 900 });
			await signIn(context, WEEKLY.sessionToken);
			const report = await body<StageStatsReport>(await api.get('/api/v1/supervisor/stats'));
			const global = report.markers.find(
				(m) => m.kind === 'quota' && m.at < Date.now() - 86400000
			)!;
			const other = report.markers.find((m) => m.event_ids.includes('evt_weekly_other_rule'))!;
			expect(global).toBeTruthy();
			expect(other).toBeTruthy();
			for (const [marker, text] of [
				[global, 'updated supervisor settings (quota)'],
				[other, 'updated the Weekly other project routing rule']
			] as const) {
				await gotoHydrated(
					page,
					`/agents?project=${marker === global ? WEEKLY.projectId : WEEKLY.otherProjectId}`
				);
				await expect(
					page.getByRole('button', { name: 'Project focus: Weekly analytics', exact: true })
				).toBeVisible();
				await page
					.getByRole('region', { name: 'This week' })
					.getByRole('button', { name: /^\d+ changes this week$/ })
					.click();
				const dialog = page.getByRole('dialog', { name: 'Latest changes in this window' });
				const details = dialog
					.locator('details')
					.filter({ has: page.locator('summary').filter({ hasText: marker.label }) })
					.filter({
						hasText: await page.evaluate((at) => new Date(at).toLocaleString(), marker.at)
					});
				await details.locator('summary').click();
				await details.getByRole('link', { name: 'View recorded events' }).click();
				await expect(
					page.getByRole('heading', { name: 'Recorded events', exact: true })
				).toBeVisible();
				await expect(page.getByText(text, { exact: true })).toBeVisible();
				expect(new URL(page.url()).searchParams.getAll('event')).toEqual(marker.event_ids);
				await expect(
					page.getByRole('button', { name: 'Project focus: Weekly analytics', exact: true })
				).toBeVisible();
				expect(
					(await body<UserPreferences>(await api.get('/api/v1/preferences'))).focused_project_id
				).toBe(WEEKLY.projectId);
				await page.screenshot({
					path: testInfo.outputPath(`recorded-${marker.kind}-${width}.png`),
					fullPage: true
				});
				await page.getByRole('link', { name: 'Back to Activity' }).click();
				await expect(page.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible();
				await expect(page.getByText(text, { exact: true })).toHaveCount(0);
			}
		} finally {
			await api.patch('/api/v1/preferences', {
				focused_project_id: original.focused_project_id,
				last_project_id: original.last_project_id
			});
		}
	});
