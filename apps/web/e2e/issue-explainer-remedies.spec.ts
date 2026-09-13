/**
 * Before its first run, an account's issue card shows the first-run checklist
 * rather than the dispatch verdict and its checks (Tines/253) — so the remedy
 * that used to hang off a failing check is now the checklist item's own
 * control. Runs as a dedicated account with nothing: no runner, no
 * routing rule, automation never enabled, and no run ever.
 *
 * The steady-state case — an account past its first run, whose card is the
 * plain explainer with its `action` links (Tines/252) — is covered by
 * `first-run-checklist.spec.ts`, which is the one file that gives an account a
 * run.
 *
 * Its fixture is not shared, so the spec remains valid in isolation and in any
 * file order even though issues cannot be deleted.
 */
import { expect, test } from '@playwright/test';
import type { IssueDetail, Project } from '@tines/shared';
import { EXPLAINER_REMEDIES as USER } from './constants.mjs';
import { apiClient, body, gotoHydrated, runId, signIn } from './helpers';

test("an unarmed account's issue card offers the first-run checklist's controls", async ({
	context,
	page,
	request
}) => {
	const api = apiClient(request, USER.apiKey);
	const projectName = `remedies-${runId}`;
	const project = await body<Project>(await api.post('/api/v1/projects', { name: projectName }));
	const issue = await body<IssueDetail>(
		await api.post(`/api/v1/projects/${project.id}/issues`, { title: 'Why is nothing running?' })
	);

	await signIn(context, USER.sessionToken);
	await gotoHydrated(page, `/issues/${encodeURIComponent(projectName)}/${issue.number}`);

	const checklist = page.getByRole('region', { name: 'First run checklist' });
	await expect(checklist).toBeVisible();
	// Being on an issue is the first item, so it is already ticked.
	await expect(checklist.locator('li[data-item="issue"]')).toHaveAttribute('data-done', 'true');

	// The runner item links out to the page that owns the wizard…
	const addRunner = checklist.getByRole('link', { name: 'Add a runner' });
	await expect(addRunner).toHaveAttribute('href', '/agents');
	// …and routing waits on it: with no runner there is nothing to route to.
	const rule = checklist.locator('li[data-item="rule"]');
	await expect(rule).toHaveAttribute('data-done', 'false');
	await expect(rule).toContainText('Add a runner first');

	// Only the current runner action is interactive; later actions are guidance
	// until the account's real state advances to them.
	await expect(checklist.locator('button, a[href]')).toHaveCount(1);
	await expect(checklist.getByRole('button', { name: 'Turn automation on' })).toHaveCount(0);
	await expect(page.getByText('Why?')).toHaveCount(0);
});
