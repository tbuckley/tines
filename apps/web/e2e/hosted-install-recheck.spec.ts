import { expect, test } from './fixtures';
import type { PublicationOwnerResult, PublicationProof } from '@tines/shared';
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';
import { BOB, WORKFLOW_PUBLICATIONS_PUBLISHER } from './constants.mjs';
import { apiClient, body, gotoHydrated, signIn } from './helpers';

// Tines/607: an availability check on the hosted installer is status-only. A successful one must
// leave the destination choices and the prepared review alone; only a failed one clears them.

async function openHostedInstall(
	request: APIRequestContext,
	context: BrowserContext,
	page: Page,
	uniqueName: (prefix: string) => string
) {
	const publisher = apiClient(request, WORKFLOW_PUBLICATIONS_PUBLISHER.apiKey);
	const workflow = await body<{ id: string }>(
		await publisher.post('/api/v1/workflows', {
			name: uniqueName('hosted-recheck'),
			description: 'Hosted install recheck fixture',
			initial_state: 'Draft',
			states: [
				{ name: 'Draft', category: 'backlog' },
				{ name: 'Done', category: 'done' }
			],
			transitions: [{ name: 'Finish', from: 'Draft', to: 'Done' }]
		})
	);
	const proof = await body<PublicationProof>(
		await publisher.post('/api/v1/publications/prepare', {
			prepare_request_id: crypto.randomUUID(),
			source: { kind: 'owned_workflow', workflow_id: workflow.id, options: {} },
			metadata: { display_name: 'Hosted recheck fixture', license: 'MIT', license_year: 2026 }
		})
	);
	const published = await body<PublicationOwnerResult>(
		await publisher.post(`/api/v1/publications/${proof.candidate_id}/publish`, {
			review_digest: proof.review_digest,
			sharing_rights: true,
			exact_content: true,
			reviewed_repo_ids: []
		})
	);
	const snapshotId = published.receipt.snapshot_id;
	await signIn(context, BOB.sessionToken);
	await gotoHydrated(page, `/workflows/import?publication=${snapshotId}`);
	const name = page.getByRole('textbox', { name: /Main ·/ });
	await expect(name).toBeVisible();
	return { name, snapshotId, publisher };
}

function statusResponse(page: Page, snapshotId: string, status: number, timeout = 10_000) {
	return page.waitForResponse(
		(response) =>
			response.url().endsWith(`/api/v1/publications/public/${snapshotId}/status`) &&
			response.status() === status,
		{ timeout }
	);
}

test('a successful focus recheck keeps the entered destination name', async ({
	request,
	context,
	page,
	uniqueName
}) => {
	const { name, snapshotId } = await openHostedInstall(request, context, page, uniqueName);
	const documentReads: string[] = [];
	page.on('request', (sent) => {
		if (sent.url().endsWith(`/api/v1/publications/public/${snapshotId}`))
			documentReads.push(sent.url());
	});
	await name.fill('My retained destination');
	await expect(name).toHaveValue('My retained destination');

	const checked = statusResponse(page, snapshotId, 200);
	await page.evaluate(() => dispatchEvent(new Event('focus')));
	await checked;
	// Let the page apply the response before reading the field.
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
	await expect(name).toHaveValue('My retained destination');
	// A recheck asks for the status only; it does not read the document again.
	expect(documentReads).toEqual([]);
});

test('the periodic recheck keeps the prepared plan, review and confirmation', async ({
	request,
	context,
	page,
	uniqueName
}) => {
	test.setTimeout(60_000);
	const { name, snapshotId } = await openHostedInstall(request, context, page, uniqueName);
	const prepares: string[] = [];
	page.on('request', (sent) => {
		if (sent.url().endsWith(`/api/v1/publications/public/${snapshotId}/prepare-install`))
			prepares.push(sent.url());
	});
	await name.fill('My reviewed destination');
	await page.getByRole('button', { name: 'Preview installation', exact: true }).click();
	const confirmed = page.getByLabel('I reviewed what will be installed');
	await confirmed.check();
	const install = page.getByRole('button', { name: 'Install workflow', exact: true });
	await expect(install).toBeEnabled();
	const actions = page.getByTestId('install-actions');
	await actions.getByText('Technical details').click();
	const planId = actions.locator('dd').first();
	const preparedPlanId = await planId.innerText();
	expect(preparedPlanId).toMatch(/\S/);

	// No event is dispatched: this is the page's own 15-second timer.
	await statusResponse(page, snapshotId, 200, 25_000);
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
	await expect(confirmed).toBeChecked();
	await expect(install).toBeEnabled();
	await expect(name).toHaveValue('My reviewed destination');
	// The same signed plan, not a quietly re-prepared one.
	await expect(planId).toHaveText(preparedPlanId);
	expect(prepares).toHaveLength(1);
});

test('a withdrawn snapshot clears the hosted install review', async ({
	request,
	context,
	page,
	uniqueName
}) => {
	const { name, snapshotId, publisher } = await openHostedInstall(
		request,
		context,
		page,
		uniqueName
	);
	await name.fill('Must not retain withdrawn document');
	await page.getByRole('button', { name: 'Preview installation', exact: true }).click();
	await page.getByLabel('I reviewed what will be installed').check();
	await expect(page.getByRole('button', { name: 'Install workflow', exact: true })).toBeEnabled();

	const withdrawal = await publisher.post(`/api/v1/publications/${snapshotId}/withdraw`, {});
	expect(withdrawal.ok(), await withdrawal.text()).toBe(true);
	const refused = statusResponse(page, snapshotId, 404);
	await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow')));
	await refused;
	await expect(page.getByRole('alert')).toContainText('This publication is not available.');
	await expect(name).toHaveCount(0);
	await expect(page.getByTestId('install-actions')).toHaveCount(0);
});

// A rejected install hands the page back to the session: reads resume and the next attempt is
// allowed. Without that, Install stays enabled and does nothing.
async function rejectInstallOnce(page: Page, status: number, code: string) {
	const attempts: string[] = [];
	await page.route('**/api/v1/library/install', async (route) => {
		attempts.push(route.request().url());
		if (attempts.length > 1) return route.continue();
		await route.fulfill({
			status,
			contentType: 'application/json',
			body: JSON.stringify({ error: { code, message: 'Injected rejection', details: null } })
		});
	});
	return attempts;
}

test('a hosted install that did not finish can be retried with the same review', async ({
	request,
	context,
	page,
	uniqueName
}) => {
	const { name } = await openHostedInstall(request, context, page, uniqueName);
	await name.fill(uniqueName('retried-install'));
	await page.getByRole('button', { name: 'Preview installation', exact: true }).click();
	const confirmed = page.getByLabel('I reviewed what will be installed');
	await confirmed.check();
	const install = page.getByRole('button', { name: 'Install workflow', exact: true });
	await expect(install).toBeEnabled();

	const attempts = await rejectInstallOnce(page, 500, 'internal_error');
	await install.click();
	await expect(page.getByRole('alert')).toContainText(
		'Installation did not finish. Your reviewed choices are still available. Choose Install workflow to retry.'
	);
	await expect(confirmed).toBeChecked();
	await expect(install).toBeEnabled();
	expect(attempts).toHaveLength(1);

	await install.click();
	await expect(page.getByRole('heading', { name: 'Installed', exact: true })).toBeVisible();
	expect(attempts).toHaveLength(2);
});

test('a hosted install rejected as stale can be previewed and installed again', async ({
	request,
	context,
	page,
	uniqueName
}) => {
	const { name } = await openHostedInstall(request, context, page, uniqueName);
	const destination = uniqueName('re-previewed-install');
	await name.fill(destination);
	const preview = page.getByRole('button', { name: 'Preview installation', exact: true });
	await preview.click();
	const confirmed = page.getByLabel('I reviewed what will be installed');
	await confirmed.check();
	const install = page.getByRole('button', { name: 'Install workflow', exact: true });
	await expect(install).toBeEnabled();

	const attempts = await rejectInstallOnce(page, 409, 'plan_stale');
	await install.click();
	await expect(page.getByRole('alert')).toContainText(
		'The preview expired or the destination changed. Nothing was created by this rejected attempt. Choose Preview installation and review it again.'
	);
	// The rejected plan is gone; the destination the person typed is not.
	await expect(confirmed).toHaveCount(0);
	await expect(name).toHaveValue(destination);
	expect(attempts).toHaveLength(1);

	await preview.click();
	// A new preview is prepared; a session still held by the rejected install would ignore the click.
	await expect(confirmed).toBeVisible();
	await confirmed.check();
	await install.click();
	await expect(page.getByRole('heading', { name: 'Installed', exact: true })).toBeVisible();
	expect(attempts).toHaveLength(2);
});
