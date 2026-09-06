import type { CreateIssueResponse, Project, WorkflowResponse } from '@tines/shared';
import { expect, test, type Page } from '@playwright/test';
import { ALICE } from './constants.mjs';
import { apiClient, body, resetFocus, runId, signIn } from './helpers';

// Specs share one user: a project page sets the focus (Tines/259), so clear it
// before each test rather than letting it scope a later spec's lists.
test.beforeEach(async ({ request }) => {
	await resetFocus(request);
});

/**
 * The project page's reading order (Tines/146): issues lead, and the
 * state-scoped context that used to push them ~1,300px down is collapsed into
 * one accordion row per workflow.
 */
test.describe.serial('project page layout', () => {
	// Named so the three workflows sort alphabetically in that order.
	const names = {
		alpha: `pp-alpha-${runId}`,
		beta: `pp-beta-${runId}`,
		gamma: `pp-gamma-${runId}`
	};
	let projectId: string;
	let scheduleId: string;
	const workflows: Record<keyof typeof names, WorkflowResponse> = {} as never;

	const stateId = (w: keyof typeof names, name: string) =>
		workflows[w].states.find((s) => s.name === name)!.id;

	/** A signed-in page at `viewport`, so each test controls its own fold. */
	async function open(
		browser: import('@playwright/test').Browser,
		viewport: { width: number; height: number },
		search = ''
	): Promise<Page> {
		const context = await browser.newContext({ viewport });
		await signIn(context, ALICE.sessionToken);
		const page = await context.newPage();
		await page.goto(`/projects/${projectId}${search}`);
		return page;
	}

	test('seeds three workflows, a project, context, a schedule and 20 issues', async ({
		request
	}) => {
		const api = apiClient(request, ALICE.apiKey);

		// alpha's states are declared out of alphabetical order, so a position
		// sort and a name sort are distinguishable in the panel.
		const specs: [keyof typeof names, string[]][] = [
			['alpha', ['Research', 'Design', 'Done']],
			['beta', ['Draft', 'Published']],
			['gamma', ['Triage']]
		];
		for (const [key, states] of specs) {
			workflows[key] = await body<WorkflowResponse>(
				await api.post('/api/v1/workflows', {
					name: names[key],
					initial_state: states[0],
					states: states.map((name, i) => ({
						name,
						category: i === states.length - 1 && states.length > 1 ? 'done' : 'active'
					})),
					transitions: states.slice(1).map((to, i) => ({ name: `to ${to}`, from: states[i], to }))
				})
			);
		}

		projectId = (
			await body<Project>(
				await api.post('/api/v1/projects', {
					name: `pp-${runId}`,
					default_workflow_id: workflows.alpha.id
				})
			)
		).id;

		// Two project-only items (stay expanded) and six state-scoped ones.
		const context: [string, string | null][] = [
			['pp-project-conventions', null],
			['pp-project-repo-notes', null],
			['pp-alpha-design', stateId('alpha', 'Design')],
			['pp-alpha-research-b', stateId('alpha', 'Research')],
			['pp-alpha-research-a', stateId('alpha', 'Research')],
			['pp-alpha-done', stateId('alpha', 'Done')],
			['pp-beta-draft', stateId('beta', 'Draft')],
			['pp-gamma-triage', stateId('gamma', 'Triage')]
		];
		for (const [name, workflow_state_id] of context) {
			const res = await api.post('/api/v1/context', {
				kind: 'prompt',
				name: `${name}-${runId}`,
				body: `Body of ${name}.`,
				project_id: projectId,
				workflow_state_id
			});
			expect(res.status()).toBe(201);
		}

		// A schedule (created with its first issue) plus enough issues that the
		// sections below the list are far off-screen.
		const scheduled = await body<CreateIssueResponse>(
			await api.post(`/api/v1/projects/${projectId}/issues`, {
				title: `pp-weekly-${runId}`,
				description: 'Scheduled instance.',
				schedule: { preset: { kind: 'weekly', time: '09:00', weekday: 1 }, timezone: 'UTC' }
			})
		);
		scheduleId = scheduled.schedule!.id;

		for (let i = 0; i < 20; i++) {
			const res = await api.post(`/api/v1/projects/${projectId}/issues`, {
				title: `pp-issue-${i}-${runId}`
			});
			expect(res.status()).toBe(201);
		}
	});

	test('leads with Issues and ends with Context', async ({ browser }) => {
		const page = await open(browser, { width: 1440, height: 900 });
		await expect(page.getByRole('heading', { level: 2 })).toHaveText([
			'Issues',
			'Scheduled tasks',
			'Agent routing',
			'Context'
		]);
		await page.context().close();
	});

	for (const [label, viewport] of [
		['desktop', { width: 1440, height: 900 }],
		['mobile', { width: 390, height: 844 }]
	] as const) {
		test(`puts the issue list above the fold on ${label}`, async ({ browser }) => {
			const page = await open(browser, viewport);
			await expect(page.getByRole('heading', { name: 'Issues', level: 2 })).toBeInViewport();
			await expect(
				page.getByRole('link', { name: new RegExp(`pp-(issue|weekly)-.*${runId}`) }).first()
			).toBeInViewport();
			// The flat one-row-per-state groups are what used to fill this space.
			await expect(page.getByText('Only in state')).toHaveCount(0);
			await page.context().close();
		});
	}

	test('collapses state context into one closed accordion row per workflow', async ({
		browser
	}) => {
		const page = await open(browser, { width: 1440, height: 900 });

		// Project-only items need no click; state-scoped ones are hidden.
		await expect(page.getByText(`pp-project-conventions-${runId}`)).toBeVisible();
		await expect(page.getByText(`pp-alpha-design-${runId}`)).toHaveCount(0);

		// By the attribute, not the name: an open panel's item buttons carry the
		// workflow name too.
		const rows = page.locator('button[aria-controls^="project-context-"]');
		await expect(rows).toHaveText([
			`${names.alpha} 3 states · 4 items`,
			`${names.beta} 1 state · 1 item`,
			`${names.gamma} 1 state · 1 item`
		]);
		for (const row of await rows.all()) {
			await expect(row).toHaveAttribute('aria-expanded', 'false');
		}

		// Clicks landing before hydration are swallowed, so retry the first one.
		const alpha = rows.first();
		await expect(async () => {
			await alpha.click();
			await expect(alpha).toHaveAttribute('aria-expanded', 'true', { timeout: 2_000 });
		}).toPass({ timeout: 15_000 });

		// States in the workflow's position order, items within a state by name.
		const panel = page.locator(`#project-context-${workflows.alpha.id}`);
		await expect(panel.locator('h4')).toHaveText(['Research', 'Design', 'Done']);
		// Item rows carry a kind badge and description, so match on the name.
		await expect(panel.getByRole('button')).toHaveText([
			new RegExp(`pp-alpha-research-a-${runId}`),
			new RegExp(`pp-alpha-research-b-${runId}`),
			new RegExp(`pp-alpha-design-${runId}`),
			new RegExp(`pp-alpha-done-${runId}`)
		]);
		await expect(alpha).toHaveAttribute('aria-controls', `project-context-${workflows.alpha.id}`);

		// Single-select: opening beta closes alpha.
		await rows.nth(1).click();
		await expect(rows.nth(1)).toHaveAttribute('aria-expanded', 'true');
		await expect(alpha).toHaveAttribute('aria-expanded', 'false');
		await expect(panel).toHaveCount(0);

		// Clicking the open row closes it again.
		await rows.nth(1).click();
		await expect(rows.nth(1)).toHaveAttribute('aria-expanded', 'false');
		await expect(page.getByText(`pp-beta-draft-${runId}`)).toHaveCount(0);

		await page.context().close();
	});

	test('offers the Context tab as the escape hatch', async ({ browser }) => {
		const page = await open(browser, { width: 1440, height: 900 });
		await expect(page.getByRole('link', { name: 'View all in Context' })).toHaveAttribute(
			'href',
			`/context?project=${projectId}`
		);
		await page.context().close();
	});

	test('scrolls a ?schedule= deep link into view', async ({ browser }) => {
		// Twenty issue rows put the schedule section well below the fold.
		const page = await open(browser, { width: 390, height: 844 }, `?schedule=${scheduleId}`);
		const row = page.locator(`#schedule-${scheduleId}`);
		await expect(row).toHaveClass(/bg-accent\/60/);
		await expect(row).toBeInViewport();
		await page.context().close();
	});
});
