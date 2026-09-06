/**
 * The issue explainer's failing checks carry a remedy the reader can click
 * (Tines/252). Runs as BOB, whose account is armed with nothing: no runner, no
 * routing rule, automation never enabled — so the `automation_enabled` and
 * `routed` checks both fail and both offer their control.
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

test("an unarmed account's explainer links to the control that would fix it", async ({
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
	await page.getByText('Why?').first().click();

	const automation = page.getByRole('link', { name: 'Turn automation on' }).first();
	await expect(automation).toBeVisible();
	await expect(automation).toHaveAttribute('href', '/agents');
	const rule = page.getByRole('link', { name: 'Add a routing rule' }).first();
	await expect(rule).toBeVisible();
	await expect(rule).toHaveAttribute('href', '/agents#routing');
});
