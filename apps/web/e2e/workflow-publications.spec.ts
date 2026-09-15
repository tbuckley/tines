import { expect, test } from '@playwright/test';
import {
	canonicalizeLibraryValue,
	type PrepareWorkflowPackageResponse,
	type PublicationOwnerResult,
	type PublicationProof,
	type WorkflowPackageDocument,
	type WorkflowPackageReceipt
} from '@tines/shared';
import { ALICE, BOB } from './constants.mjs';
import { apiClient, body, errorBody, gotoHydrated, runId, signIn, PHONE, DESKTOP } from './helpers';

test.describe.serial('public workflow snapshots', () => {
	const marker = `public-snapshot-${runId}`;
	let snapshotId: string;
	let documentJson: string;
	let hostedPlan: PrepareWorkflowPackageResponse;

	test('publishes exact bytes and exposes a responsive anonymous text-only inspection', async ({
		request,
		browser
	}) => {
		const alice = apiClient(request, ALICE.apiKey);
		const workflow = await body<{ id: string }>(
			await alice.post('/api/v1/workflows', {
				name: marker,
				description: `Inspectable exact text ${marker}\n\n[External guide](https://example.com/public-guide)\n\n${'reader-state '.repeat(120)}`,
				initial_state: 'Draft',
				states: [
					{ name: 'Draft', category: 'active' },
					{ name: 'Review', category: 'awaiting_human' },
					{ name: 'Done', category: 'done' }
				],
				transitions: [
					{ name: 'Submit', from: 'Draft', to: 'Review' },
					{
						name: `Approve ${'long-value-'.repeat(7)}`,
						from: 'Review',
						to: 'Done',
						requires: [
							{
								artifact: 'approval',
								type: 'text',
								description: `Human decision ${'with-readable-long-gate '.repeat(20)}`
							}
						]
					}
				]
			})
		);
		const proof = await body<PublicationProof>(
			await alice.post('/api/v1/publications/prepare', {
				prepare_request_id: crypto.randomUUID(),
				source: { kind: 'owned_workflow', workflow_id: workflow.id, options: {} },
				metadata: { display_name: 'Alice Example', license: 'MIT', license_year: 2026 }
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
		snapshotId = published.receipt.snapshot_id;
		documentJson = canonicalizeLibraryValue(proof.document);

		const ownerContext = await browser.newContext();
		await signIn(ownerContext, ALICE.sessionToken);
		const ownerPage = await ownerContext.newPage();
		await gotoHydrated(ownerPage, `/workflows/${workflow.id}/export#publish`);
		const displayName = ownerPage.getByLabel('Public display name');
		await displayName.fill('First proof name');
		await ownerPage.getByRole('button', { name: 'Preview', exact: true }).click();
		await expect(ownerPage.getByRole('heading', { name: 'Preview', exact: true })).toBeFocused();
		await ownerPage.getByRole('button', { name: 'Back to Customize' }).click();
		await displayName.fill('Alice Browser');
		await ownerPage.getByRole('button', { name: 'Preview', exact: true }).click();
		await ownerPage.getByRole('button', { name: 'Continue to Share', exact: true }).click();
		await ownerPage
			.getByRole('checkbox', { name: /I have the right to share all included content/ })
			.check();
		await ownerPage.getByRole('button', { name: 'Publish workflow' }).click();
		await expect(ownerPage.getByText('Shared', { exact: true })).toBeVisible();
		await ownerContext.close();
		const publicContext = await browser.newContext();
		const page = await publicContext.newPage();

		const download = await request.get(`/api/v1/publications/public/${snapshotId}/download`);
		expect(download.ok()).toBe(true);
		expect(await download.text()).toBe(documentJson);
		expect(download.headers()['cache-control']).toContain('no-store');

		for (const viewport of [PHONE, DESKTOP]) {
			await page.setViewportSize(viewport);
			const response = await gotoHydrated(page, `/p/${snapshotId}`);
			expect(response?.headers()['content-security-policy']).toContain("img-src 'none'");
			await expect(page.getByRole('heading', { name: marker, exact: true })).toBeVisible();
			await expect(
				page.getByText(`Inspectable exact text ${marker}`, { exact: true })
			).toBeVisible();
			await expect(page.getByRole('button', { name: /Sign in to install/i })).toBeVisible();
			await expect(page.getByRole('button', { name: /Download file/i })).toBeVisible();
			const external = page.getByRole('button', { name: /External guide/i });
			await external.click();
			await expect(page.getByRole('dialog', { name: 'Open external destination?' })).toBeVisible();
			await expect(
				page.getByText('https://example.com/public-guide', { exact: true })
			).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(external).toBeFocused();
			expect(
				await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
			).toBe(true);
		}

		await page.getByRole('button', { name: 'Report', exact: true }).click();
		await expect(page.getByRole('dialog', { name: 'Report this public workflow' })).toBeVisible();
		await expect(page.getByLabel('Reason')).toHaveValue('');
		await page.getByLabel('Reason').selectOption('malicious_phishing');
		await page.getByLabel('Details (optional)').fill(`Private report ${marker}`);
		await page.getByRole('button', { name: 'Send report' }).click();
		await expect(page.getByRole('heading', { name: 'Report received' })).toBeVisible();
		await expect(page.getByText(/^Reference: rpt_/)).toBeFocused();
		await publicContext.close();

		const moderatorContext = await browser.newContext();
		await signIn(moderatorContext, ALICE.sessionToken);
		const moderatorPage = await moderatorContext.newPage();
		await gotoHydrated(moderatorPage, '/host/workflow-reports');
		await expect(moderatorPage.getByText(marker, { exact: true })).toBeVisible();
		await moderatorPage.getByText(marker, { exact: true }).click();
		await expect(
			moderatorPage.getByRole('heading', { name: 'Complete inert inspection' })
		).toBeVisible();
		await expect(
			moderatorPage.getByText(`Private report ${marker}`, { exact: true })
		).toBeVisible();
		await moderatorPage.getByLabel('Reason').fill('Reviewed exact snapshot; no restriction needed');
		await moderatorPage.getByRole('button', { name: 'Dismiss reports' }).click();
		await expect(moderatorPage.getByText('dismiss recorded.')).toBeVisible();
		await moderatorContext.close();
	});

	test('returns through sign-in to the exact snapshot and fences stale hosted plans', async ({
		browser,
		request
	}) => {
		const context = await browser.newContext();
		await signIn(context, BOB.sessionToken);
		const page = await context.newPage();
		await page.goto(`/p/${snapshotId}/install`);
		await expect(page).toHaveURL(`/workflows/import?publication=${snapshotId}`);
		await expect(page.getByRole('heading', { name: 'Install workflow' })).toBeVisible();
		await page.getByRole('button', { name: 'Preview installation' }).click();
		await page.getByLabel(/I reviewed what will be installed/).check();
		await page.getByRole('button', { name: 'Install workflow' }).click();
		await expect(page.getByRole('heading', { name: 'Installed' })).toBeVisible();
		await context.close();

		const bob = apiClient(request, BOB.apiKey);
		hostedPlan = await body<PrepareWorkflowPackageResponse>(
			await bob.post(`/api/v1/publications/public/${snapshotId}/prepare-install`, { choices: {} })
		);
		const observedContext = await browser.newContext();
		const observed = await observedContext.newPage();
		await gotoHydrated(observed, `/p/${snapshotId}`);
		await expect(observed.getByText(marker, { exact: false }).first()).toBeVisible();
		const expansion = observed.getByRole('button', { name: /Show all \d+ words/ });
		await expansion.click();
		const collapse = observed.getByRole('button', { name: 'Show snippet' });
		await collapse.focus();
		let releaseAvailable!: () => void;
		const availableRelease = new Promise<void>((resolve) => (releaseAvailable = resolve));
		let availableStarted!: () => void;
		const availableRequest = new Promise<void>((resolve) => (availableStarted = resolve));
		await observed.route(`**/api/v1/publications/public/${snapshotId}/status`, async (route) => {
			availableStarted();
			await availableRelease;
			await route.continue();
		});
		await observed.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow')));
		await availableRequest;
		await expect(observed.getByText(marker, { exact: false })).toHaveCount(0);
		releaseAvailable();
		await expect(observed.getByText(marker, { exact: false }).first()).toBeVisible();
		await expect(collapse).toBeFocused();
		await observed.unroute(`**/api/v1/publications/public/${snapshotId}/status`);

		let releaseStatus!: () => void;
		const release = new Promise<void>((resolve) => (releaseStatus = resolve));
		let statusStarted!: () => void;
		const started = new Promise<void>((resolve) => (statusStarted = resolve));
		await observed.route(`**/api/v1/publications/public/${snapshotId}/status`, async (route) => {
			statusStarted();
			await release;
			await route.continue();
		});
		await observed.evaluate(() => dispatchEvent(new Event('focus')));
		await started;
		await expect(observed.getByText(marker, { exact: false })).toHaveCount(0);
		await expect(observed).toHaveTitle('Publication unavailable');
		const alice = apiClient(request, ALICE.apiKey);
		expect((await alice.post(`/api/v1/publications/${snapshotId}/withdraw`)).ok()).toBe(true);
		releaseStatus();
		await expect(observed.getByText(/not available/i)).toBeVisible();
		await observedContext.close();

		const refused = await bob.post('/api/v1/library/install', {
			document_json: documentJson,
			plan_token: hostedPlan.plan_token,
			confirmation: { plan_digest: hostedPlan.plan_digest }
		});
		expect(refused.ok()).toBe(false);
		expect((await errorBody(refused)).error.code).toBe('plan_stale');

		const filePlan = await body<PrepareWorkflowPackageResponse>(
			await bob.post('/api/v1/library/prepare', { document_json: documentJson, choices: {} })
		);
		const receipt = await body<WorkflowPackageReceipt>(
			await bob.post('/api/v1/library/install', {
				document_json: documentJson,
				plan_token: filePlan.plan_token,
				confirmation: { plan_digest: filePlan.plan_digest }
			})
		);
		expect(receipt.objects.find((object) => object.relationship === 'main')?.name).toMatch(
			new RegExp(`^${marker}`)
		);
	});

	test('withdrawal returns one neutral page without the removed marker', async ({
		page,
		request
	}) => {
		const pageResponse = await page.goto(`/p/${snapshotId}`);
		expect(pageResponse?.status()).toBe(404);
		await expect(page.getByText(marker)).toHaveCount(0);
		await expect(page.getByText(/not available/i)).toBeVisible();
		const download = await request.get(`/api/v1/publications/public/${snapshotId}/download`);
		expect(download.status()).toBe(404);
		expect(await download.text()).not.toContain(marker);
	});
});
