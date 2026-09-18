import type { CreateIssueResponse, Project, WorkflowResponse } from '@tines/shared';
import type { Page } from '@playwright/test';
import { expect, test as base } from './fixtures';
import { ALICE } from './constants.mjs';
import { body, gotoHydrated, resetFocus, signIn } from './helpers';

type ProjectPageWorld = {
	projectId: string;
	scheduleId: string;
	workflows: Record<'alpha' | 'beta' | 'gamma', WorkflowResponse>;
	workflowNames: Record<'alpha' | 'beta' | 'gamma', string>;
	contextNames: Record<string, string>;
	issuePrefix: string;
};

const test = base.extend<{}, { world: ProjectPageWorld }>({
	world: [
		async ({ apiFor, uniqueName }, use) => {
			const api = apiFor(ALICE);
			const workflowNames = {
				alpha: uniqueName('pp-alpha'),
				beta: uniqueName('pp-beta'),
				gamma: uniqueName('pp-gamma')
			};
			const workflows = {} as ProjectPageWorld['workflows'];
			for (const [key, states] of [
				['alpha', ['Research', 'Design', 'Done']],
				['beta', ['Draft', 'Published']],
				['gamma', ['Triage']]
			] as const) {
				workflows[key] = await body<WorkflowResponse>(
					await api.post('/api/v1/workflows', {
						name: workflowNames[key],
						initial_state: states[0],
						states: states.map((name, i) => ({
							name,
							category: i === states.length - 1 && states.length > 1 ? 'done' : 'active'
						})),
						transitions: states.slice(1).map((to, i) => ({ name: `to ${to}`, from: states[i], to }))
					})
				);
			}
			const project = await body<Project>(
				await api.post('/api/v1/projects', {
					name: uniqueName('pp'),
					default_workflow_id: workflows.alpha.id
				})
			);
			const stateId = (w: keyof typeof workflows, name: string) =>
				workflows[w].states.find((state) => state.name === name)!.id;
			const contextNames: Record<string, string> = {};
			for (const [stem, workflow_state_id] of [
				['pp-project-conventions', null],
				['pp-project-repo-notes', null],
				['pp-alpha-design', stateId('alpha', 'Design')],
				['pp-alpha-research-b', stateId('alpha', 'Research')],
				['pp-alpha-research-a', stateId('alpha', 'Research')],
				['pp-alpha-done', stateId('alpha', 'Done')],
				['pp-beta-draft', stateId('beta', 'Draft')],
				['pp-gamma-triage', stateId('gamma', 'Triage')]
			] as const) {
				const name = uniqueName(stem);
				contextNames[stem] = name;
				expect(
					(
						await api.post('/api/v1/context', {
							kind: 'prompt',
							name,
							body: `Body of ${stem}.`,
							project_id: project.id,
							workflow_state_id
						})
					).status()
				).toBe(201);
			}
			const issuePrefix = uniqueName('pp-issue', { maxLength: 100 });
			const scheduled = await body<CreateIssueResponse>(
				await api.post(`/api/v1/projects/${project.id}/issues`, {
					title: `${issuePrefix}-weekly`,
					description: 'Scheduled instance.',
					schedule: { preset: { kind: 'weekly', time: '09:00', weekday: 1 }, timezone: 'UTC' }
				})
			);
			for (let i = 0; i < 20; i++) {
				expect(
					(
						await api.post(`/api/v1/projects/${project.id}/issues`, {
							title: `${issuePrefix}-${i}`
						})
					).status()
				).toBe(201);
			}
			await use({
				projectId: project.id,
				scheduleId: scheduled.schedule!.id,
				workflows,
				workflowNames,
				contextNames,
				issuePrefix
			});
		},
		{ scope: 'worker' }
	]
});

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
test.describe('project page layout', () => {
	/** A signed-in page at `viewport`, so each test controls its own fold. */
	async function open(
		browser: import('@playwright/test').Browser,
		world: ProjectPageWorld,
		viewport: { width: number; height: number },
		search = ''
	): Promise<Page> {
		const context = await browser.newContext({ viewport });
		await signIn(context, ALICE.sessionToken);
		const page = await context.newPage();
		await gotoHydrated(page, `/projects/${world.projectId}${search}`);
		return page;
	}

	test('leads with Issues and ends with Context', async ({ browser, world }) => {
		const page = await open(browser, world, { width: 1440, height: 900 });
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
		test(`puts the issue list above the fold on ${label}`, async ({ browser, world }) => {
			const page = await open(browser, world, viewport);
			await expect(page.getByRole('heading', { name: 'Issues', level: 2 })).toBeInViewport();
			await expect(
				page.getByRole('link', { name: new RegExp(world.issuePrefix) }).first()
			).toBeInViewport();
			// The flat one-row-per-state groups are what used to fill this space.
			await expect(page.getByText('Only in state')).toHaveCount(0);
			await page.context().close();
		});
	}

	test('collapses state context into one closed accordion row per workflow', async ({
		browser,
		world
	}) => {
		const page = await open(browser, world, { width: 1440, height: 900 });

		// Project-only items need no click; state-scoped ones are hidden.
		await expect(page.getByText(world.contextNames['pp-project-conventions'])).toBeVisible();
		await expect(page.getByText(world.contextNames['pp-alpha-design'])).toHaveCount(0);

		// By the attribute, not the name: an open panel's item buttons carry the
		// workflow name too.
		const rows = page.locator('button[aria-controls^="project-context-"]');
		await expect(rows).toHaveText([
			`${world.workflowNames.alpha} 3 states · 4 items`,
			`${world.workflowNames.beta} 1 state · 1 item`,
			`${world.workflowNames.gamma} 1 state · 1 item`
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
		const panel = page.locator(`#project-context-${world.workflows.alpha.id}`);
		await expect(panel.locator('h4')).toHaveText(['Research', 'Design', 'Done']);
		// Item rows carry a kind badge and description, so match on the name.
		await expect(panel.getByRole('button')).toHaveText([
			new RegExp(world.contextNames['pp-alpha-research-a']),
			new RegExp(world.contextNames['pp-alpha-research-b']),
			new RegExp(world.contextNames['pp-alpha-design']),
			new RegExp(world.contextNames['pp-alpha-done'])
		]);
		await expect(alpha).toHaveAttribute(
			'aria-controls',
			`project-context-${world.workflows.alpha.id}`
		);

		// Single-select: opening beta closes alpha.
		await rows.nth(1).click();
		await expect(rows.nth(1)).toHaveAttribute('aria-expanded', 'true');
		await expect(alpha).toHaveAttribute('aria-expanded', 'false');
		await expect(panel).toHaveCount(0);

		// Clicking the open row closes it again.
		await rows.nth(1).click();
		await expect(rows.nth(1)).toHaveAttribute('aria-expanded', 'false');
		await expect(page.getByText(world.contextNames['pp-beta-draft'])).toHaveCount(0);

		await page.context().close();
	});

	test('offers the Context tab as the escape hatch', async ({ browser, world }) => {
		const page = await open(browser, world, { width: 1440, height: 900 });
		await expect(page.getByRole('link', { name: 'View all in Context' })).toHaveAttribute(
			'href',
			'/context'
		);
		await page.context().close();
	});

	test('scrolls a ?schedule= deep link into view', async ({ browser, world }) => {
		// Twenty issue rows put the schedule section well below the fold.
		const page = await open(
			browser,
			world,
			{ width: 390, height: 844 },
			`?schedule=${world.scheduleId}`
		);
		const row = page.locator(`#schedule-${world.scheduleId}`);
		await expect(row).toHaveClass(/bg-accent\/60/);
		await expect(row).toBeInViewport();
		await page.context().close();
	});
});
