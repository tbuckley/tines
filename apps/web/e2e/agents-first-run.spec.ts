/**
 * The first hour, as a user who has nothing: every empty state on the way to a
 * first agent run points at the next step, and the issue explainer's failing
 * checks carry a remedy link (Tines/252).
 *
 * Runs as BOB, the seeded account with no projects, runners or rules. That
 * emptiness is only true until another spec writes to BOB, so this file sorts
 * before `api.spec.ts` (which creates a project for him) — keep the name ahead
 * of it, and it asserts the precondition up front rather than failing
 * mysteriously later.
 */
import { expect, test } from '@playwright/test';
import type { IssueDetail, ListResponse, Project } from '@tines/shared';
import { BOB } from './constants.mjs';
import { apiClient, body, runId, signIn } from './helpers';

test.describe.serial('the first-run path on an empty account', () => {
	test('the Issues tab sends a projectless account to New project', async ({
		context,
		page,
		request
	}) => {
		const api = apiClient(request, BOB.apiKey);
		const { items } = await body<ListResponse<Project>>(await api.get('/api/v1/projects'));
		expect(items, 'BOB must still be projectless here — see the file comment').toHaveLength(0);

		await signIn(context, BOB.sessionToken);
		await page.goto('/issues');
		const link = page.getByRole('link', { name: 'New project' });
		await expect(link).toBeVisible();
		await link.click();

		// The dialog opens from `?new=1`, which is consumed with replaceState so
		// nav memory never reopens it.
		await expect(page.getByRole('dialog', { name: /New project/i })).toBeVisible();
		await expect(page).toHaveURL(/\/projects$/);
	});

	test('the Agents tab offers a runner and a rule instead of a sentence', async ({
		context,
		page
	}) => {
		await signIn(context, BOB.sessionToken);
		await page.goto('/agents');

		// The routing empty state knows there is no runner to route to yet.
		const addRunner = page.getByRole('button', { name: 'Add runner' }).last();
		await expect(page.getByRole('button', { name: 'Add a runner first' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Add rule' })).toBeDisabled();

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
		const api = apiClient(request, BOB.apiKey);
		const projectName = `first-run-${runId}`;
		const project = await body<Project>(await api.post('/api/v1/projects', { name: projectName }));
		const projectId = project.id;

		await signIn(context, BOB.sessionToken);
		await page.goto(`/projects/${projectId}`);

		// The routing card's empty state is a link to where routing lives.
		const routing = page.getByRole('link', { name: 'Set up routing' });
		await expect(routing).toBeVisible();
		await expect(routing).toHaveAttribute('href', '/agents#routing');

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

		// The explainer's failing checks render their remedies as real links:
		// nothing on this account is armed, so both of them fail.
		const issue = await body<IssueDetail>(
			await api.post(`/api/v1/projects/${projectId}/issues`, { title: 'Why is nothing running?' })
		);
		await page.goto(`/issues/${encodeURIComponent(projectName)}/${issue.number}`);
		await page.getByText('Why?').first().click();
		const automation = page.getByRole('link', { name: 'Turn automation on' }).first();
		await expect(automation).toBeVisible();
		await expect(automation).toHaveAttribute('href', '/agents');
		const rule = page.getByRole('link', { name: 'Add a routing rule' }).first();
		await expect(rule).toHaveAttribute('href', '/agents#routing');

		// Leave the account as empty as it was found.
		await api.delete(`/api/v1/projects/${projectId}`);
	});
});
