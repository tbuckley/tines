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
		page,
		request
	}) => {
		const alice = apiClient(request, ALICE.apiKey);
		const workflow = await body<{ id: string }>(
			await alice.post('/api/v1/workflows', {
				name: marker,
				description: `Inspectable exact text ${marker}`,
				initial_state: 'Review',
				states: [
					{ name: 'Review', category: 'awaiting_human' },
					{ name: 'Done', category: 'done' }
				],
				transitions: [
					{
						name: 'Approve',
						from: 'Review',
						to: 'Done',
						requires: [{ artifact: 'approval', type: 'text', description: 'Human decision' }]
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

		const download = await request.get(`/api/v1/publications/public/${snapshotId}/download`);
		expect(download.ok()).toBe(true);
		expect(await download.text()).toBe(documentJson);
		expect(download.headers()['cache-control']).toContain('no-store');

		for (const viewport of [PHONE, DESKTOP]) {
			await page.setViewportSize(viewport);
			await gotoHydrated(page, `/p/${snapshotId}`);
			await expect(page.getByRole('heading', { name: marker })).toBeVisible();
			await expect(page.getByText(`Inspectable exact text ${marker}`)).toBeVisible();
			await expect(page.getByRole('link', { name: /Add to my library/i })).toBeVisible();
			await expect(page.getByRole('link', { name: /Download package/i })).toBeVisible();
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
		await context.close();

		const bob = apiClient(request, BOB.apiKey);
		hostedPlan = await body<PrepareWorkflowPackageResponse>(
			await bob.post(`/api/v1/publications/public/${snapshotId}/prepare-install`, { choices: {} })
		);
		const alice = apiClient(request, ALICE.apiKey);
		expect((await alice.post(`/api/v1/publications/${snapshotId}/withdraw`)).ok()).toBe(true);

		const refused = await bob.post('/api/v1/library/install', {
			document_json: documentJson,
			plan_token: hostedPlan.plan_token,
			confirmation: { plan_digest: hostedPlan.plan_digest }
		});
		expect(refused.ok()).toBe(false);
		expect((await errorBody(refused)).error.code).toBe('publication_unavailable');

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
		expect(receipt.objects.find((object) => object.relationship === 'main')?.name).toBe(marker);
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
