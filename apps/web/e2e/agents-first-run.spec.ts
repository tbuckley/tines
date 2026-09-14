/**
 * The first hour, as a user who has nothing: every empty state on the way to a
 * first agent run points at the next step (Tines/252).
 *
 * Runs as a dedicated seeded account with no projects, runners or rules, so
 * the spec is independent of file ordering and every other browser fixture.
 */
import { expect, test } from './fixtures';
import type { ListResponse, Project, RoutingRuleWithWarnings } from '@tines/shared';
import { AGENTS_FIRST_RUN as USER } from './constants.mjs';
import { apiClient, body, gotoHydrated, runId, signIn } from './helpers';

test.describe.serial('the first-run path on an empty account', () => {
	test('the Issues tab sends a projectless account to New project', async ({
		context,
		page,
		request
	}) => {
		const api = apiClient(request, USER.apiKey);
		const { items } = await body<ListResponse<Project>>(await api.get('/api/v1/projects'));
		expect(
			items,
			'The dedicated first-run fixture must start projectless; restart e2e/server.sh after a warm run'
		).toHaveLength(0);

		await signIn(context, USER.sessionToken);
		await gotoHydrated(page, '/issues');
		await page.getByRole('link', { name: 'New project' }).click();

		// The dialog opens from `?new=1`, which is consumed with replaceState so
		// nav memory never reopens it.
		await expect(page.getByRole('dialog', { name: /New project/i })).toBeVisible();
		await expect(page).toHaveURL(/\/projects$/);
	});

	// The link above is the first thing on a fresh account's Issues tab, so it
	// is routinely clicked before that page has hydrated — a full page load of
	// `/projects?new=1` rather than a client-side navigation. Pasting the URL
	// does the same. The dialog has to open on that path too, and it only does
	// if the flag is consumed after the router has started (CI caught this as a
	// dialog that never appeared; see the page's own comment).
	test('a cold load of /projects?new=1 opens the dialog just the same', async ({
		context,
		page
	}) => {
		await signIn(context, USER.sessionToken);
		await gotoHydrated(page, '/projects?new=1');

		await expect(page.getByRole('dialog', { name: /New project/i })).toBeVisible();
		await expect(page).toHaveURL(/\/projects$/);
	});

	test('the Agents tab permits a scoped tier-only rule before any runner exists', async ({
		context,
		page,
		request
	}) => {
		const api = apiClient(request, USER.apiKey);
		const project = await body<Project>(
			await api.post('/api/v1/projects', { name: `runnerless-routing-${runId}` })
		);
		await signIn(context, USER.sessionToken);
		await gotoHydrated(page, '/agents');

		// The routing empty state knows there is no runner to route to yet.
		const addRunner = page.getByRole('button', { name: 'Add runner' }).last();
		await expect(page.getByRole('button', { name: 'Add a runner first' })).toBeVisible();
		await page.getByRole('button', { name: 'Add rule' }).click();
		const ruleDialog = page.getByRole('dialog', { name: 'New routing rule' });
		await ruleDialog.getByLabel('Project').selectOption(project.id);
		await ruleDialog.getByLabel('Routing mode').selectOption('tier');
		await ruleDialog.getByLabel('Tier').selectOption('smartest');
		await ruleDialog.getByRole('button', { name: 'Create rule' }).click();
		await expect(page.getByText('*:smartest')).toBeVisible();
		const { items: rules } = await body<ListResponse<RoutingRuleWithWarnings>>(
			await api.get('/api/v1/routing-rules')
		);
		expect(rules.find((rule) => rule.scope.project_id === project.id)?.targets).toEqual([
			{ runner_id: '*', runner_name: '*', runner_status: null, tier: 'smartest' }
		]);
		await api.delete(`/api/v1/routing-rules/${rules[0].id}`);
		await api.delete(`/api/v1/projects/${project.id}`);

		// Both empty-state buttons open the same dialog; hydration can swallow
		// the first click (clickUntil in helpers.ts).
		const dialog = page.getByRole('dialog', { name: 'Add runner' });
		await expect(async () => {
			if (!(await dialog.isVisible())) await addRunner.click();
			await expect(dialog.getByLabel('Name')).toBeVisible({ timeout: 2000 });
		}).toPass({ timeout: 15_000 });
	});

	test('a fresh project page points at routing and at its first repo', async ({
		context,
		page,
		request
	}) => {
		const api = apiClient(request, USER.apiKey);
		const projectName = `first-run-${runId}`;
		const project = await body<Project>(await api.post('/api/v1/projects', { name: projectName }));
		const projectId = project.id;

		await signIn(context, USER.sessionToken);
		await gotoHydrated(page, `/projects/${projectId}`);

		// The routing card's empty state is a link to where routing lives.
		const routing = page.getByRole('link', { name: 'Edit routing' }).first();
		await expect(routing).toBeVisible();
		await expect(routing).toHaveAttribute('href', `/agents?new=rule&project=${projectId}#routing`);

		// The context card's empty state opens the editor already on `repo`.
		const addRepo = page.getByRole('button', { name: 'Add a repo' });
		const editor = page.getByRole('dialog');
		await expect(async () => {
			if (!(await editor.isVisible())) await addRepo.click();
			await expect(editor.getByRole('radio', { name: /repo/i }).first()).toBeChecked({
				timeout: 2000
			});
		}).toPass({ timeout: 15_000 });
		await page.keyboard.press('Escape');

		// Leave the account as empty as it was found — `deleteProject` refuses a
		// project that still has issues, so assert it actually went.
		const deleted = await api.delete(`/api/v1/projects/${projectId}`);
		expect(deleted.ok(), await deleted.text()).toBe(true);
	});
});
