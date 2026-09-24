import type { ContextItem, EffectiveContext, LaunchPromptResponse, Project } from '@tines/shared';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { ALICE, RUNROW, RUNROW_FAILED } from './constants.mjs';
import { gotoHydrated, runId, signIn } from './helpers';

/**
 * The API keys page folds run keys — one is minted per agent run and never
 * deleted — out of the list the user manages. The seed gives Alice one key of
 * her own (`alice-key`), one *active* run key (RUNROW's, still authenticating
 * for api.spec.ts's fence cases) and one *revoked* run key (RUNROW_FAILED's).
 *
 * Never confirm Revoke on RUNROW's run key: api.spec.ts authenticates with it
 * and the suite shares one D1.
 */

const PHONE = { width: 390, height: 844 };

/** The list of the user's own keys — the first `<ul>` on the page. */
const userKeyList = (page: Page) => page.locator('ul').first();
const disclosure = (page: Page) => page.getByTestId('run-keys');
/**
 * Rows are located by *runner* name: both seeded runs are on the same issue,
 * so the issue ref alone matches two rows — which is the point of naming a run
 * key after its run rather than after a key name.
 */
const runKeyRow = (page: Page, runnerName: string) =>
	disclosure(page).locator('li').filter({ hasText: runnerName });

const activeRunRef = `run on ${RUNROW.projectName}/${RUNROW.runKeyIssueNumber}`;

/**
 * Open the disclosure. `bind:open` re-asserts its initial value when hydration
 * lands, so a click in the SSR-to-hydration window is undone — the same race
 * `clickUntil` in `helpers.ts` exists for. Not `clickUntil` itself: it clicks
 * unconditionally, which on an already-open `<details>` closes it again, and
 * it checks `done` once rather than holding it across a beat, which is what
 * catches the snap-back.
 */
async function openDisclosure(page: Page): Promise<void> {
	const details = disclosure(page);
	await expect(async () => {
		if (!(await details.evaluate((el: HTMLDetailsElement) => el.open))) {
			await details.locator('summary').click();
		}
		expect(await details.evaluate((el: HTMLDetailsElement) => el.open)).toBe(true);
		// Held across a beat, so a hydration snap-back fails the attempt.
		await page.waitForTimeout(250);
		expect(await details.evaluate((el: HTMLDetailsElement) => el.open)).toBe(true);
	}).toPass({ timeout: 15_000 });
}

test.use({ signedIn: ALICE });

test.describe.serial('API keys page', () => {
	test("the user's own keys are the whole visible list", async ({ page }) => {
		await page.goto('/settings/api-keys');
		await expect(page.getByRole('heading', { name: 'API keys' })).toBeVisible();

		const own = userKeyList(page);
		await expect(own.getByText(ALICE.apiKeyName, { exact: true })).toBeVisible();
		// No run key has leaked into the list the user manages.
		await expect(own.getByText(/^run/)).toHaveCount(0);
		await expect(own.getByText(RUNROW.runnerName)).toHaveCount(0);
	});

	test('run keys sit in a disclosure that is closed by default and counts both populations', async ({
		page
	}) => {
		await page.goto('/settings/api-keys');

		const details = disclosure(page);
		await expect(details).toBeVisible();
		await expect(details.locator('summary')).toContainText('Run keys');
		// One active (RUNROW), one revoked (RUNROW_FAILED) — the whole point of
		// the split: the counts are of run keys only, not of the user's keys.
		await expect(details.locator('summary')).toContainText('1 active, 1 revoked');
		expect(await details.evaluate((el: HTMLDetailsElement) => el.open)).toBe(false);
		// Closed means its contents are not rendered to the user.
		await expect(details.getByText(activeRunRef)).toBeHidden();
	});

	test('opening it names each run key by the issue its run worked, and links there', async ({
		page
	}) => {
		await page.goto('/settings/api-keys');
		await openDisclosure(page);

		const row = runKeyRow(page, RUNROW.runKeyRunnerName);
		await expect(row).toHaveCount(1);
		await expect(row.getByRole('link', { name: activeRunRef })).toHaveAttribute(
			'href',
			`/issues/${RUNROW.projectName}/${RUNROW.runKeyIssueNumber}`
		);
		// The runner is what a human recognises; the prefix still identifies the key.
		await expect(row).toContainText(RUNROW.runKeyRunnerName);
		await expect(row).toContainText(RUNROW.runKey.slice(0, 14));
		// The run id is available on hover without spending a line on it.
		await expect(row.locator('p').first()).toHaveAttribute('title', new RegExp(RUNROW.runKeyRunId));

		// The revoked run key is hidden until asked for.
		await expect(disclosure(page).getByText(RUNROW_FAILED.runnerName)).toHaveCount(0);
	});

	test('"Show revoked" reveals the revoked run key and survives a reload', async ({ page }) => {
		await gotoHydrated(page, '/settings/api-keys');
		await openDisclosure(page);

		await disclosure(page).getByLabel('Show revoked').check();
		await expect(page).toHaveURL(/revoked=1/);

		// The disclosure stays open across the navigation that flips the param.
		const details = disclosure(page);
		expect(await details.evaluate((el: HTMLDetailsElement) => el.open)).toBe(true);

		const revokedRow = runKeyRow(page, RUNROW_FAILED.runnerName);
		await expect(revokedRow).toHaveCount(1);
		await expect(revokedRow).toContainText('revoked');
		// A revoked key can never act again, so it carries no action.
		await expect(revokedRow.getByRole('button', { name: 'Revoke' })).toHaveCount(0);
		await expect(revokedRow).toContainText(`run on ${RUNROW.projectName}/${RUNROW.issueNumber}`);
		await expect(runKeyRow(page, RUNROW.runKeyRunnerName)).toHaveCount(1);

		// Arriving at the URL directly opens the disclosure with the box ticked.
		await gotoHydrated(page, '/settings/api-keys?revoked=1');
		expect(await disclosure(page).evaluate((el: HTMLDetailsElement) => el.open)).toBe(true);
		await expect(disclosure(page).getByLabel('Show revoked')).toBeChecked();
		await expect(runKeyRow(page, RUNROW_FAILED.runnerName)).toHaveCount(1);

		// Unticking drops the param and hides it again.
		await disclosure(page).getByLabel('Show revoked').uncheck();
		await expect(page).not.toHaveURL(/revoked=1/);
		await expect(runKeyRow(page, RUNROW_FAILED.runnerName)).toHaveCount(0);
	});

	test('revoking a live run key warns that it cuts the agent off mid-run', async ({ page }) => {
		await gotoHydrated(page, '/settings/api-keys');
		await openDisclosure(page);

		await runKeyRow(page, RUNROW.runKeyRunnerName).getByRole('button', { name: 'Revoke' }).click();

		// The shared confirm is bits-ui's alert-dialog variant: role="alertdialog".
		const dialog = page.getByRole('alertdialog');
		await expect(dialog).toContainText(`${RUNROW.projectName}/${RUNROW.runKeyIssueNumber}`);
		await expect(dialog).toContainText(RUNROW.runKeyRunnerName);
		await expect(dialog).toContainText(/cuts the agent off mid-run/i);

		// Cancel — api.spec.ts's fence cases authenticate with this key.
		await dialog.getByRole('button', { name: 'Cancel' }).click();
		await expect(dialog).toBeHidden();
		await expect(
			runKeyRow(page, RUNROW.runKeyRunnerName).getByRole('button', { name: 'Revoke' })
		).toHaveCount(1);
	});

	test('on a phone the user reaches their own key and the fold without scrolling', async ({
		page
	}) => {
		await page.setViewportSize(PHONE);
		await page.goto('/settings/api-keys');

		await expect(userKeyList(page).getByText(ALICE.apiKeyName, { exact: true })).toBeInViewport({
			ratio: 1
		});
		await expect(disclosure(page).locator('summary')).toBeInViewport({ ratio: 1 });
	});

	test('creates, enforces, edits, and revokes a selected-project key', async ({ page }) => {
		await gotoHydrated(page, '/settings/api-keys');
		await page.getByRole('button', { name: 'New key' }).click();
		const dialog = page.getByRole('dialog');
		await dialog.getByLabel('Name').fill('scoped browser key');
		await dialog.getByLabel('Permissions').selectOption('project-automation');
		await dialog.getByLabel(RUNROW.projectName).check();
		await dialog.getByRole('button', { name: 'Create key' }).click();
		await expect(dialog.getByText('API key created')).toBeVisible();
		const secret = (await dialog.locator('code').first().innerText()).trim();

		const headers = { authorization: `Bearer ${secret}` };
		const projects = await page.request.get('/api/v1/projects', { headers });
		expect(projects.status()).toBe(200);
		expect((await projects.json()).items.map((project: { id: string }) => project.id)).toEqual([
			RUNROW.projectId
		]);
		const control = await page.request.get('/api/v1/api-keys', { headers });
		expect(control.status()).toBe(403);

		await dialog.getByRole('button', { name: 'Done' }).click();
		const row = userKeyList(page).locator('li').filter({ hasText: 'scoped browser key' });
		await expect(row).toContainText('Projects write (1 selected project)');
		await row.getByRole('button', { name: 'Edit' }).click();
		const edit = page.getByRole('dialog');
		await edit.getByLabel('Permissions JSON').fill(
			JSON.stringify({
				version: 1,
				projects: { access: 'read', scope: [RUNROW.projectId] },
				workspace: 'none',
				control_plane: 'none'
			})
		);
		await edit.getByRole('button', { name: 'Save' }).click();
		await expect(edit).toBeHidden();
		await expect(row).toContainText('Projects read (1 selected project)');

		const denied = await page.request.post(`/api/v1/projects/${RUNROW.projectId}/issues`, {
			headers,
			data: { title: 'must not be created' }
		});
		expect(denied.status()).toBe(403);

		await row.getByRole('button', { name: 'Revoke' }).click();
		await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke key' }).click();
		await expect(row).toContainText('revoked');
	});

	test('an over-granted run key stays bound for context, journals, and links', async ({ page }) => {
		const sessionHeaders = { authorization: `Bearer ${ALICE.apiKey}` };
		const runHeaders = { authorization: `Bearer ${RUNROW.runKey}` };
		const createIssue = async (title: string) => {
			const response = await page.request.post(`/api/v1/projects/${RUNROW.projectId}/issues`, {
				headers: sessionHeaders,
				data: { title }
			});
			expect(response.status()).toBe(201);
			return (await response.json()) as { id: string };
		};
		const unrelated = await createIssue('run-bound unrelated one');
		const other = await createIssue('run-bound unrelated two');

		const boundContext = await page.request.post('/api/v1/context', {
			headers: runHeaders,
			data: { kind: 'prompt', name: 'run-bound-note', body: 'ok', issue_id: RUNROW.runKeyIssueId }
		});
		expect(boundContext.status()).toBe(201);
		for (const data of [
			{ kind: 'prompt', name: 'unrelated-note', body: 'no', issue_id: unrelated.id },
			{ kind: 'prompt', name: 'shared-state-note', body: 'no', workflow_state_id: 'wfs_std_open' }
		]) {
			const denied = await page.request.post('/api/v1/context', { headers: runHeaders, data });
			expect(denied.status()).toBe(403);
			expect((await denied.json()).error.code).toBe('run_key_forbidden');
		}
		const journal = await page.request.post('/api/v1/context', {
			headers: runHeaders,
			data: {
				kind: 'prompt',
				name: 'journal',
				body: 'bound lesson',
				project_id: RUNROW.projectId,
				workflow_state_id: 'wfs_std_open'
			}
		});
		expect(journal.status()).toBe(201);

		const allowedLink = await page.request.post(`/api/v1/issues/${RUNROW.runKeyIssueId}/links`, {
			headers: runHeaders,
			data: { kind: 'blocks', issue_id: unrelated.id }
		});
		expect(allowedLink.status()).toBe(201);
		const deniedLink = await page.request.post(`/api/v1/issues/${unrelated.id}/links`, {
			headers: runHeaders,
			data: { kind: 'blocks', issue_id: other.id }
		});
		expect(deniedLink.status()).toBe(403);
		expect((await deniedLink.json()).error.code).toBe('run_key_forbidden');
	});

	test('a run key reads its issue context and prompts but not another project', async ({
		page
	}) => {
		const ownerHeaders = { authorization: `Bearer ${ALICE.apiKey}` };
		const runHeaders = { authorization: `Bearer ${RUNROW.runKey}` };
		const body = `Run context read marker ${runId}`;
		const created = await page.request.post('/api/v1/context', {
			headers: ownerHeaders,
			data: { kind: 'prompt', name: `run-read-${runId}`, body, issue_id: RUNROW.runKeyIssueId }
		});
		expect(created.status()).toBe(201);

		const context = await page.request.get(`/api/v1/issues/${RUNROW.runKeyIssueId}/context`, {
			headers: runHeaders
		});
		expect(context.status()).toBe(200);
		expect(((await context.json()) as EffectiveContext).prompt.text).toContain(body);
		for (const suffix of ['', '?resume=1']) {
			const prompt = await page.request.get(
				`/api/v1/issues/${RUNROW.runKeyIssueId}/prompt${suffix}`,
				{
					headers: runHeaders
				}
			);
			expect(prompt.status()).toBe(200);
			const text = ((await prompt.json()) as LaunchPromptResponse).text;
			expect(text).toContain(`${RUNROW.projectName}/${RUNROW.runKeyIssueNumber}`);
			expect(text.length).toBeGreaterThan(100);
			if (!suffix) expect(text).toContain(body);
		}

		const projectResponse = await page.request.post('/api/v1/projects', {
			headers: ownerHeaders,
			data: { name: `run-read-outside-${runId}` }
		});
		expect(projectResponse.status()).toBe(201);
		const project = (await projectResponse.json()) as Project;
		const issueResponse = await page.request.post(`/api/v1/projects/${project.id}/issues`, {
			headers: ownerHeaders,
			data: { title: `Run read outside project ${runId}` }
		});
		expect(issueResponse.status()).toBe(201);
		const issue = (await issueResponse.json()) as { id: string };
		for (const endpoint of ['context', 'prompt']) {
			const denied = await page.request.get(`/api/v1/issues/${issue.id}/${endpoint}`, {
				headers: runHeaders
			});
			expect(denied.status()).toBe(403);
			expect((await denied.json()).error).toMatchObject({
				code: 'run_key_forbidden',
				details: { reason: 'outside_run_project' }
			});
		}
	});

	test('a run key cannot re-scope shared context to its issue', async ({ page }) => {
		const ownerHeaders = { authorization: `Bearer ${ALICE.apiKey}` };
		const runHeaders = { authorization: `Bearer ${RUNROW.runKey}` };
		const originalBody = `Shared prompt ${runId}`;
		const created = await page.request.post('/api/v1/context', {
			headers: ownerHeaders,
			data: {
				kind: 'prompt',
				name: `run-rescope-${runId}`,
				body: originalBody,
				project_id: RUNROW.projectId
			}
		});
		expect(created.status()).toBe(201);
		const original = (await created.json()) as ContextItem;
		const denied = await page.request.patch(`/api/v1/context/${original.id}`, {
			headers: runHeaders,
			data: { issue_id: RUNROW.runKeyIssueId, body: 'should never land' }
		});
		expect(denied.status()).toBe(403);
		expect((await denied.json()).error).toMatchObject({
			code: 'run_key_forbidden',
			details: { reason: 'context_not_issue_scoped' }
		});
		const unchanged = await page.request.get(`/api/v1/context/${original.id}`, {
			headers: ownerHeaders
		});
		expect(unchanged.status()).toBe(200);
		const item = (await unchanged.json()) as ContextItem;
		expect(item.scope).toEqual(original.scope);
		expect(item.body).toBe(originalBody);
		expect(item.version).toBe(original.version);
	});
});
