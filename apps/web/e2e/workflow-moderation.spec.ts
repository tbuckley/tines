import type { PublicationOwnerResult, PublicationProof } from '@tines/shared';
import { ALICE, BOB } from './constants.mjs';
import { d1, sqlLiteral } from './d1';
import { expect, test } from './fixtures';
import { body, gotoHydrated, PHONE, signIn } from './helpers';

test('reports, removes, restores, suspends and recovers one exact public snapshot', async ({
	apiFor,
	browser,
	page,
	request,
	uniqueName
}) => {
	test.setTimeout(300_000);
	const marker = uniqueName('moderation-journey', { maxLength: 100 });
	const alice = apiFor(ALICE);
	const workflow = await body<{ id: string }>(
		await alice.post('/api/v1/workflows', {
			name: marker,
			description: `${marker} [hostile destination](https://example.test/track)`,
			initial_state: 'Open',
			states: [
				{ name: 'Open', category: 'active' },
				{ name: 'Done', category: 'done' }
			],
			transitions: [{ name: 'Finish', from: 'Open', to: 'Done' }]
		})
	);
	const proof = await body<PublicationProof>(
		await alice.post('/api/v1/publications/prepare', {
			prepare_request_id: crypto.randomUUID(),
			source: { kind: 'owned_workflow', workflow_id: workflow.id, options: {} },
			metadata: { display_name: 'Moderation journey', license: 'MIT', license_year: 2026 }
		})
	);
	const published = await body<PublicationOwnerResult>(
		await alice.post(`/api/v1/publications/${proof.candidate_id}/publish`, {
			review_digest: proof.review_digest,
			sharing_rights: true,
			exact_content: true,
			reviewed_repo_ids: []
		})
	);
	const snapshotId = published.receipt.snapshot_id;
	const download = await request.get(`/api/v1/publications/public/${snapshotId}/download`);
	expect(download.ok()).toBe(true);
	const downloadedDocument = await download.text();
	d1('DELETE FROM workflow_report_rate_event');

	const completedCopy = await browser.newContext();
	await signIn(completedCopy, BOB.sessionToken);
	const completedCopyPage = await completedCopy.newPage();
	await gotoHydrated(completedCopyPage, `/workflows/import?publication=${snapshotId}`);
	await completedCopyPage.getByRole('button', { name: 'Prepare installation' }).click();
	await completedCopyPage.getByLabel(/I confirm exact plan/).check();
	await completedCopyPage.getByRole('button', { name: 'Install package' }).click();
	await expect(completedCopyPage.getByRole('heading', { name: 'Package installed' })).toBeVisible();
	const installedMainHref = await completedCopyPage
		.getByRole('link', { name: 'Open workflow' })
		.first()
		.getAttribute('href');
	expect(installedMainHref).toBeTruthy();

	const staleInstall = await browser.newContext();
	await signIn(staleInstall, BOB.sessionToken);
	const staleInstallPage = await staleInstall.newPage();
	await gotoHydrated(staleInstallPage, `/workflows/import?publication=${snapshotId}`);
	await staleInstallPage.getByRole('button', { name: 'Prepare installation' }).click();
	await staleInstallPage.getByLabel(/I confirm exact plan/).check();

	await page.setViewportSize(PHONE);
	await gotoHydrated(page, `/p/${snapshotId}`);
	const topReport = page.getByRole('button', { name: 'Report', exact: true });
	for (
		let index = 0;
		index < 20 && !(await topReport.evaluate((node) => node === document.activeElement));
		index++
	)
		await page.keyboard.press('Tab');
	await expect(topReport).toBeFocused();
	expect(
		await topReport.evaluate((node) => {
			const style = getComputedStyle(node);
			return style.boxShadow !== 'none' || style.outlineStyle !== 'none';
		})
	).toBe(true);
	await page.keyboard.press('Enter');
	await expect(page.getByLabel('Reason')).toHaveValue('');
	await page.getByLabel('Reason').selectOption('malicious_phishing');
	await page.getByLabel('Details (optional)').fill(`private ${marker}`);
	const reportBodies: string[] = [];
	let loseReportResponse = true;
	await page.route(`**/api/v1/publications/public/${snapshotId}/reports`, async (route) => {
		reportBodies.push(route.request().postData() ?? '');
		if (loseReportResponse) {
			loseReportResponse = false;
			await route.fetch();
			await route.abort();
		} else await route.continue();
	});
	await page.getByRole('button', { name: 'Send report' }).click();
	await expect(page.getByRole('button', { name: 'Retry report' })).toBeVisible();
	await page.getByRole('button', { name: 'Retry report' }).click();
	await expect(page.getByText(/^Reference: rpt_/)).toBeFocused();
	expect(reportBodies).toHaveLength(2);
	expect(reportBodies[1]).toBe(reportBodies[0]);
	await page.unroute(`**/api/v1/publications/public/${snapshotId}/reports`);
	await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click();

	// Fill the remaining rolling-hour slots directly, then prove the signed-out dialog
	// preserves its fields and renders the server retry hint on the next submission.
	for (let index = 0; index < 4; index++) {
		const status = await page.evaluate(
			async ({ id, index }) =>
				(
					await fetch(`/api/v1/publications/public/${id}/reports`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							request_id: crypto.randomUUID(),
							reason: 'other',
							note: `quota-${index}`
						})
					})
				).status,
			{ id: snapshotId, index }
		);
		expect(status).toBe(201);
	}
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.getByRole('button', { name: 'Report this workflow' }).click();
	await page.getByLabel('Reason').selectOption('rights');
	await page.getByLabel('Details (optional)').fill('Keep this throttled input');
	await page.getByRole('button', { name: 'Send report' }).click();
	await expect(page.getByText(/Try again after/)).toBeVisible();
	await expect(page.getByLabel('Reason')).toHaveValue('rights');
	await expect(page.getByLabel('Details (optional)')).toHaveValue('Keep this throttled input');
	await page.keyboard.press('Escape');

	const moderator = await browser.newContext();
	await signIn(moderator, ALICE.sessionToken);
	const host = await moderator.newPage();
	await host.setViewportSize(PHONE);
	await gotoHydrated(host, '/host/workflow-reports');
	expect(await host.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
		true
	);
	await host.getByText(marker, { exact: true }).click();
	await host.setViewportSize({ width: 1440, height: 900 });
	await expect(host.getByText(`private ${marker}`, { exact: true })).toBeVisible();
	await expect(host.getByText('https://example.test/track', { exact: false })).toBeVisible();
	await expect(host.getByRole('link', { name: /hostile destination/i })).toHaveCount(0);
	await host.evaluate(() => (document.documentElement.style.zoom = '2'));
	expect(await host.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
		true
	);
	await host.evaluate(() => (document.documentElement.style.zoom = ''));

	await host.getByRole('button', { name: 'Dismiss reports' }).click();
	await expect(host.getByText('Enter a reason for this decision.')).toBeVisible();
	await host.getByLabel('Reason').fill('Reports reviewed separately');
	await host.getByRole('button', { name: 'Dismiss reports' }).click();
	await expect(host.getByText('dismiss recorded.')).toBeVisible();
	await gotoHydrated(host, '/host/workflow-reports');
	const urgentBodies: string[] = [];
	let loseUrgentResponse = true;
	await host.route('**/api/v1/host/workflow-moderation/decisions', async (route) => {
		urgentBodies.push(route.request().postData() ?? '');
		if (loseUrgentResponse) {
			loseUrgentResponse = false;
			await route.fetch();
			await route.abort();
		} else await route.continue();
	});
	await host.getByLabel('Public URL or snapshot ID').fill(snapshotId);
	await host.getByLabel('Reason shown to publisher').fill('Publisher-safe removal reason');
	await host.getByRole('button', { name: 'Disable now' }).click();
	await expect(host.getByRole('button', { name: 'Disable now' })).toBeEnabled();
	await host.getByRole('button', { name: 'Disable now' }).click();
	await expect(host.getByText('Snapshot disabled.')).toBeVisible();
	expect(urgentBodies).toHaveLength(2);
	expect(urgentBodies[1]).toBe(urgentBodies[0]);
	await host.unroute('**/api/v1/host/workflow-moderation/decisions');

	for (const suffix of ['', '/download', '/reuse.txt', '/status']) {
		const unavailable = await request.get(`/api/v1/publications/public/${snapshotId}${suffix}`);
		expect(unavailable.status(), suffix).toBe(404);
		expect(await unavailable.text(), suffix).not.toContain(marker);
	}
	await page.bringToFront();
	await page.evaluate(() => dispatchEvent(new Event('focus')));
	await expect(page.getByText(/not available/i)).toBeVisible();
	await staleInstallPage.getByRole('button', { name: 'Install package' }).click();
	await expect(staleInstallPage.getByRole('alert')).toContainText('not available');
	await completedCopyPage.goto(installedMainHref!);
	await expect(completedCopyPage.getByText(marker, { exact: false }).first()).toBeVisible();

	const downloadedCopyPage = await completedCopy.newPage();
	await gotoHydrated(downloadedCopyPage, '/workflows/import');
	await downloadedCopyPage.getByLabel('Workflow package file').setInputFiles({
		name: 'moderated-copy.json',
		mimeType: 'application/json',
		buffer: Buffer.from(downloadedDocument)
	});
	await downloadedCopyPage.getByRole('button', { name: 'Prepare installation' }).click();
	await downloadedCopyPage.getByLabel(/I confirm exact plan/).check();
	await downloadedCopyPage.getByRole('button', { name: 'Install package' }).click();
	await expect(
		downloadedCopyPage.getByRole('heading', { name: 'Package installed' })
	).toBeVisible();

	await gotoHydrated(host, `/host/workflow-reports/${snapshotId}`);
	await host.getByLabel('Reason').fill('Current-policy content reviewed');
	const restoreBodies: string[] = [];
	let injectRestoreConflict = true;
	await host.route('**/api/v1/host/workflow-moderation/decisions', async (route) => {
		restoreBodies.push(route.request().postData() ?? '');
		if (injectRestoreConflict) {
			injectRestoreConflict = false;
			d1(
				`UPDATE workflow_publication SET status_version=status_version+1
				 WHERE snapshot_id=${sqlLiteral(snapshotId)}`
			);
			await route.fulfill({
				status: 409,
				contentType: 'application/json',
				body: JSON.stringify({
					error: { code: 'moderation_state_changed', message: 'Reload the snapshot status' }
				})
			});
		} else await route.continue();
	});
	await host.getByRole('button', { name: 'Restore' }).click();
	await expect(host.getByText('Reload the snapshot status')).toBeVisible();
	await expect(host.getByLabel('Reason')).toHaveValue('Current-policy content reviewed');
	await host.getByRole('button', { name: 'Restore' }).click();
	await expect(host.getByText('restore recorded.')).toBeVisible();
	await host.unroute('**/api/v1/host/workflow-moderation/decisions');
	expect(restoreBodies).toHaveLength(2);
	expect(JSON.parse(restoreBodies[1]).expected_snapshot_version).toBe(
		JSON.parse(restoreBodies[0]).expected_snapshot_version + 1
	);
	expect((await request.get(`/p/${snapshotId}`)).status()).toBe(200);

	await host.getByLabel('Reason').fill('Publisher suspension shown to owner');
	await host.getByRole('button', { name: 'Suspend publisher' }).click();
	await expect(host.getByText('suspend recorded.')).toBeVisible();
	expect((await request.get(`/p/${snapshotId}`)).status()).toBe(404);

	const owner = await browser.newContext();
	await signIn(owner, ALICE.sessionToken);
	const ownerPage = await owner.newPage();
	await ownerPage.goto('/publications');
	await expect(ownerPage.getByText('Publisher suspension shown to owner').first()).toBeVisible();
	await expect(ownerPage.getByRole('link', { name: /appeal/i }).first()).toHaveAttribute(
		'href',
		'mailto:appeals@e2e.test'
	);

	await gotoHydrated(host, '/host/workflow-reports');
	const publisher = host.locator('li').filter({ hasText: 'Moderation journey' });
	await expect(publisher).toContainText(/\d+ stored snapshots?/);
	await expect(publisher.locator('.text-xs')).toHaveText(/stored snapshots?$/);
	const recoveryBodies: string[] = [];
	let recoveryAttempt = 0;
	await host.route('**/api/v1/host/workflow-moderation/decisions', async (route) => {
		recoveryBodies.push(route.request().postData() ?? '');
		recoveryAttempt += 1;
		if (recoveryAttempt === 1) {
			d1(
				`UPDATE workflow_publisher_status SET status_version=status_version+1
				 WHERE user_id=${sqlLiteral(ALICE.id)}`
			);
			await route.fulfill({
				status: 409,
				contentType: 'application/json',
				body: JSON.stringify({
					error: { code: 'moderation_state_changed', message: 'Reload the publisher status' }
				})
			});
		} else if (recoveryAttempt === 2) {
			await route.fetch();
			await route.abort();
		} else await route.continue();
	});
	await host.getByLabel('Recovery reason').fill('Appeal reviewed; explicit recovery');
	await publisher.getByRole('button', { name: 'Unsuspend' }).click();
	await expect(host.getByText('Reload the publisher status')).toBeVisible();
	await expect(host.getByLabel('Recovery reason')).toHaveValue(
		'Appeal reviewed; explicit recovery'
	);
	await publisher.getByRole('button', { name: 'Unsuspend' }).click();
	await expect(publisher.getByRole('button', { name: 'Unsuspend' })).toBeEnabled();
	await publisher.getByRole('button', { name: 'Unsuspend' }).click();
	await expect(host.getByText('Publisher unsuspended.')).toBeVisible();
	expect(recoveryBodies).toHaveLength(3);
	expect(JSON.parse(recoveryBodies[1]).expected_publisher_version).toBe(
		JSON.parse(recoveryBodies[0]).expected_publisher_version + 1
	);
	expect(recoveryBodies[2]).toBe(recoveryBodies[1]);
	expect((await request.get(`/p/${snapshotId}`)).status()).toBe(200);
	d1(`DELETE FROM workflow_report_rate_event WHERE receipt_id IN
		(SELECT id FROM workflow_report WHERE snapshot_id=${sqlLiteral(snapshotId)})`);
	await Promise.all([
		moderator.close(),
		owner.close(),
		completedCopy.close(),
		staleInstall.close()
	]);
});

test('shows bounded host queue loading, empty, and retryable error states', async ({ browser }) => {
	const moderator = await browser.newContext();
	await signIn(moderator, ALICE.sessionToken);
	const host = await moderator.newPage();
	await gotoHydrated(host, '/host/workflow-reports');
	let releaseData!: () => void;
	const held = new Promise<void>((resolve) => (releaseData = resolve));
	await host.route('**/host/workflow-reports/__data.json*', async (route) => {
		await held;
		await route.continue();
	});
	await host.getByRole('link', { name: 'all', exact: true }).click();
	await expect(host.getByRole('status').filter({ hasText: 'Loading report queue' })).toBeVisible();
	releaseData();
	await expect(host).toHaveURL(/filter=all/);
	await host.unroute('**/host/workflow-reports/__data.json*');

	await gotoHydrated(host, '/host/workflow-reports?filter=all&cursor=0:zzzzzzzzzzzzzzzzzzzz');
	await expect(host.getByText('No reports in this view.')).toBeVisible();
	const failed = await host.goto('/host/workflow-reports?e2e_error=1');
	expect(failed?.status()).toBe(500);
	await expect(host.getByRole('heading', { name: 'Report queue unavailable' })).toBeVisible();
	await host.getByRole('button', { name: 'Retry queue' }).click();
	await expect(host.getByRole('heading', { name: 'Workflow report queue' })).toBeVisible();
	await moderator.close();
});
