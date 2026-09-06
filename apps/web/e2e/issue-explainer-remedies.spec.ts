/**
 * Before its first run, an account's issue card shows the first-run checklist
 * rather than the dispatch verdict and its checks (Tines/253) — so the remedy
 * that used to hang off a failing check is now the checklist item's own
 * control. Runs as BOB, whose account is armed with nothing: no runner, no
 * routing rule, automation never enabled, and no run ever.
 *
 * The steady-state case — an account past its first run, whose card is the
 * plain explainer with its `action` links (Tines/252) — is covered by
 * `first-run-checklist.spec.ts`, which is the one file that gives an account a
 * run.
 *
 * This file must sort AFTER `api.spec.ts`: it creates an issue for BOB, and
 * there is no DELETE for issues, so it cannot leave the account as empty as it
 * found it — `api.spec.ts`'s cross-user isolation case asserts BOB's standard
 * workflow still has `issue_count === 0`. The empty-state cases that need BOB
 * projectless live in `agents-first-run.spec.ts`, which sorts before it.
 */
import { expect, test } from '@playwright/test';
import type { IssueDetail, Project } from '@tines/shared';
import { BOB } from './constants.mjs';
import { apiClient, body, gotoHydrated, runId, signIn } from './helpers';

test("an unarmed account's issue card offers the first-run checklist's controls", async ({
	context,
	page,
	request
}) => {
	const api = apiClient(request, BOB.apiKey);
	const projectName = `remedies-${runId}`;
	const project = await body<Project>(await api.post('/api/v1/projects', { name: projectName }));
	const issue = await body<IssueDetail>(
		await api.post(`/api/v1/projects/${project.id}/issues`, { title: 'Why is nothing running?' })
	);

	await signIn(context, BOB.sessionToken);
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

	// The kill switch is actionable from here (no confirmation on enable), but
	// this spec does not click it: BOB's off state is what it asserts.
	await expect(checklist.getByRole('button', { name: 'Turn automation on' })).toBeVisible();
	await expect(page.getByText('Why?')).toHaveCount(0);
});
