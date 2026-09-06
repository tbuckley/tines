/**
 * The first hour, as a user who has nothing: every empty state on the way to a
 * first agent run points at the next step (Tines/252).
 *
 * Runs as BOB, the seeded account with no projects, runners or rules. That
 * emptiness is only true until another spec writes to BOB, so this file sorts
 * before `api.spec.ts` (which creates a project for him) — keep the name ahead
 * of it, and it asserts the precondition up front rather than failing
 * mysteriously later. Every project this file creates is deleted again; the
 * explainer's remedy links need an *issue*, which cannot be deleted at all, so
 * that case lives in `issue-explainer-remedies.spec.ts` after `api.spec.ts`.
 */
import { expect, test } from '@playwright/test';
import type { ListResponse, Project } from '@tines/shared';
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
		expect(
			items,
			"BOB must still be projectless here: this file has to sort before every spec that writes to him, and a re-run against a warm .wrangler-e2e sees the last run's leftovers — restart e2e/server.sh"
		).toHaveLength(0);

		await signIn(context, BOB.sessionToken);
		await page.goto('/issues');
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
		await signIn(context, BOB.sessionToken);
		await page.goto('/projects?new=1');

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

		// Leave the account as empty as it was found — `deleteProject` refuses a
		// project that still has issues, so assert it actually went.
		const deleted = await api.delete(`/api/v1/projects/${projectId}`);
		expect(deleted.ok(), await deleted.text()).toBe(true);
	});
});
