import { expect, test } from './fixtures';
import {
	canonicalizeLibraryValue,
	type PrepareWorkflowPackageResponse,
	type PublicationOwnerResult,
	type PublicationProof,
	type WorkflowPackageDocument,
	type WorkflowPackageReceipt
} from '@tines/shared';
import { ALICE, BOB } from './constants.mjs';
import { apiClient, body, errorBody, gotoHydrated, signIn, PHONE, DESKTOP } from './helpers';

test.describe.serial('public workflow snapshots', () => {
	let marker: string;
	let snapshotId: string;
	let documentJson: string;
	let hostedPlan: PrepareWorkflowPackageResponse;

	test.beforeAll(async ({ uniqueName }) => {
		marker = uniqueName('public-snapshot', { maxLength: 100 });
	});

	test('publishes exact bytes and exposes a responsive anonymous text-only inspection', async ({
		page,
		request,
		browser
	}) => {
		const alice = apiClient(request, ALICE.apiKey);
		const workflow = await body<{ id: string }>(
			await alice.post('/api/v1/workflows', {
				name: marker,
				description: `Inspectable exact text ${marker}\n\n[External guide](https://example.com/public-guide)`,
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
		await ownerPage.getByRole('button', { name: 'Prepare exact publication proof' }).click();
		await expect(ownerPage.getByText('Exact proof', { exact: true })).toBeVisible();
		await displayName.fill('Alice Browser');
		await expect(ownerPage.getByText('Exact proof', { exact: true })).toHaveCount(0);
		await ownerPage.getByRole('button', { name: 'Prepare exact publication proof' }).click();
		await ownerPage.getByLabel(/I have the right to share/).check();
		await ownerPage.getByLabel(/I reviewed this exact proof/).check();
		await ownerPage.getByRole('button', { name: 'Publish immutable snapshot' }).click();
		await expect(ownerPage.getByText('Published', { exact: true })).toBeVisible();
		await ownerContext.close();

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
			await expect(page.getByRole('button', { name: /Download package/i })).toBeVisible();
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
		await expect(page.getByRole('heading', { name: 'Install workflow package' })).toBeVisible();
		await page.getByRole('button', { name: 'Prepare installation' }).click();
		await page.getByLabel(/I confirm exact plan/).check();
		await page.getByRole('button', { name: 'Install package' }).click();
		await expect(page.getByRole('heading', { name: 'Package installed' })).toBeVisible();
		await context.close();

		const bob = apiClient(request, BOB.apiKey);
		hostedPlan = await body<PrepareWorkflowPackageResponse>(
			await bob.post(`/api/v1/publications/public/${snapshotId}/prepare-install`, { choices: {} })
		);
		const observedContext = await browser.newContext();
		const observed = await observedContext.newPage();
		await gotoHydrated(observed, `/p/${snapshotId}`);
		await expect(observed.getByText(marker, { exact: false }).first()).toBeVisible();
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
