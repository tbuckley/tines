import { expect, test } from '@playwright/test';
import {
	canonicalizeLibraryValue,
	inputToken,
	withLibraryDocumentDigest,
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
		const workflow = await body<{ id: string; states: { id: string; name: string }[] }>(
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
		const draftState = workflow.states.find((state) => state.name === 'Draft')!;
		await body(
			await alice.post('/api/v1/context', {
				kind: 'skill',
				name: `required-publishing-${runId}`,
				workflow_state_id: draftState.id,
				files: [
					{
						path: 'SKILL.md',
						content: `# Publishing review\n\n${'Read every included instruction. '.repeat(130)}\n\nComplete skill tail ${marker}`
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
		let prepareRequests = 0;
		const prepareRequestIds: string[] = [];
		ownerPage.on('request', (request) => {
			if (request.method() === 'POST' && request.url().endsWith('/api/v1/publications/prepare')) {
				prepareRequests++;
				prepareRequestIds.push(request.postDataJSON().prepare_request_id);
			}
		});
		let releasePreparation!: () => void;
		const heldPreparation = new Promise<void>((resolve) => (releasePreparation = resolve));
		let preparationStarted!: () => void;
		const startedPreparation = new Promise<void>((resolve) => (preparationStarted = resolve));
		await ownerPage.route('**/api/v1/publications/prepare', async (route) => {
			const response = await route.fetch();
			preparationStarted();
			await heldPreparation;
			await route.fulfill({ response });
		});
		await ownerPage.getByRole('button', { name: 'Preview', exact: true }).click();
		await startedPreparation;
		await displayName.fill('Alice Browser');
		const rejectedResponse = ownerPage.waitForResponse('**/api/v1/publications/prepare');
		releasePreparation();
		await rejectedResponse;
		await expect(ownerPage.getByRole('heading', { name: 'Customize', exact: true })).toBeVisible();
		await expect(ownerPage.getByText('Published by First proof name')).toHaveCount(0);
		await ownerPage.unroute('**/api/v1/publications/prepare');
		await ownerPage.getByRole('button', { name: 'Preview', exact: true }).click();
		await expect(ownerPage.getByRole('heading', { name: 'Preview', exact: true })).toBeFocused();
		const skillReview = ownerPage.getByRole('link', { name: 'Review 1 included skill' });
		await skillReview.click();
		const skill = ownerPage.locator('section[id^="review-"]').filter({ hasText: marker });
		await expect(skill).toBeFocused();
		await expect(skill.getByText(`Complete skill tail ${marker}`, { exact: true })).toBeVisible();
		await expect(skill.getByRole('button', { name: /Show all/ })).toHaveCount(0);
		await ownerPage.setViewportSize(PHONE);
		const continueAction = ownerPage.getByRole('button', {
			name: 'I reviewed the included skill — Continue to Share'
		});
		await expect(continueAction).toBeVisible();
		const actionBox = await continueAction.boundingBox();
		expect(actionBox!.x).toBeGreaterThanOrEqual(0);
		expect(actionBox!.x + actionBox!.width).toBeLessThanOrEqual(PHONE.width);
		await ownerPage.getByRole('button', { name: 'Back to Customize' }).click();
		await ownerPage.getByRole('button', { name: 'Preview', exact: true }).click();
		expect(prepareRequests).toBe(2);
		expect(new Set(prepareRequestIds).size).toBe(2);
		await continueAction.click();
		await ownerPage
			.getByRole('checkbox', { name: /I have the right to share all included content/ })
			.check();
		const publishAttempts: unknown[] = [];
		await ownerPage.route('**/api/v1/publications/*/publish', async (route) => {
			publishAttempts.push(route.request().postDataJSON());
			if (publishAttempts.length === 1) {
				const response = await route.fetch();
				expect(response.ok()).toBe(true);
				await route.abort('connectionreset');
				return;
			}
			await route.continue();
		});
		await ownerPage.getByRole('button', { name: 'Publish workflow' }).click();
		await expect(ownerPage.getByText(/could not confirm whether sharing finished/)).toBeVisible();
		await ownerPage.getByRole('button', { name: 'Publish workflow' }).click();
		await expect(ownerPage.getByText('Shared', { exact: true })).toBeVisible();
		expect(publishAttempts).toHaveLength(2);
		expect(publishAttempts[1]).toEqual(publishAttempts[0]);
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
		const includedReviews = page.getByRole('checkbox', { name: /I reviewed every file/ });
		await expect(includedReviews).toHaveCount(1);
		await includedReviews.check();
		await page.getByLabel(/I reviewed what will be installed/).check();
		const install = page.getByRole('button', { name: 'Install workflow' });
		await expect(install).toBeEnabled();
		await install.click();
		await expect(page.getByRole('heading', { name: 'Installed', exact: true })).toBeVisible();
		await context.close();

		const bob = apiClient(request, BOB.apiKey);
		hostedPlan = await body<PrepareWorkflowPackageResponse>(
			await bob.post(`/api/v1/publications/public/${snapshotId}/prepare-install`, { choices: {} })
		);
		const observedContext = await browser.newContext();
		const observed = await observedContext.newPage();
		await gotoHydrated(observed, `/p/${snapshotId}`);
		await expect(observed.getByText(marker, { exact: false }).first()).toBeVisible();
		const expansion = observed.getByRole('button', { name: /Show all \d+ words/ }).first();
		await expansion.click();
		const collapse = observed.getByRole('button', { name: 'Show snippet' }).first();
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

	test('publishes one authored occurrence and installs another value without changing the source', async ({
		browser,
		request
	}) => {
		const alice = apiClient(request, ALICE.apiKey);
		const draftMarker = `publication-draft-${runId}`;
		const workflow = await body<{ id: string; states: { id: string; name: string }[] }>(
			await alice.post('/api/v1/workflows', {
				name: draftMarker,
				initial_state: 'Draft',
				states: [{ name: 'Draft', category: 'active' }],
				transitions: []
			})
		);
		await body(
			await alice.post('/api/v1/context', {
				kind: 'prompt',
				name: 'instructions',
				workflow_state_id: workflow.states[0].id,
				body: 'customer-portal and customer-portal'
			})
		);

		const ownerContext = await browser.newContext();
		await signIn(ownerContext, ALICE.sessionToken);
		const ownerPage = await ownerContext.newPage();
		await gotoHydrated(ownerPage, `/workflows/${workflow.id}/export`);
		await ownerPage.getByLabel('Public display name').fill('Alice Draft');
		await ownerPage
			.getByText('Customize instructions and variables (optional)', { exact: true })
			.click();
		await ownerPage.getByLabel('Key').fill('project_name');
		await ownerPage.getByRole('textbox', { name: 'Label', exact: true }).fill('Project name');
		await ownerPage.getByLabel('Default').fill('customer-portal');
		await ownerPage.getByRole('button', { name: 'Add variable' }).click();
		await ownerPage
			.getByLabel('Edit instructions')
			.selectOption({ label: 'instructions — prompt body' });
		const editor = ownerPage.locator('textarea');
		await editor.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(0, 15));
		await ownerPage.getByRole('button', { name: 'Use selected variable here' }).click();
		await ownerPage.getByRole('button', { name: 'Edit input project_name' }).click();
		await ownerPage.getByLabel('Default').fill('billing-service');
		await ownerPage.getByRole('button', { name: 'Save changes' }).click();
		await expect(editor).toHaveValue('{{project_name:billing-service}} and customer-portal');
		await editor.fill('{{project_name:billing-service}} and UNSAVED candidate text');
		await ownerPage.getByRole('button', { name: 'Preview', exact: true }).click();
		await expect(ownerPage.getByRole('heading', { name: 'Customize', exact: true })).toBeVisible();
		await expect(ownerPage.getByTestId('package-actions')).toContainText(
			'Save or cancel the candidate text edit before previewing.'
		);
		await ownerPage.getByRole('button', { name: 'Cancel text edit' }).click();
		await expect(editor).toHaveValue('{{project_name:billing-service}} and customer-portal');

		await ownerPage.route('**/api/v1/publications/prepare', async (route) => {
			const request = route.request().postDataJSON();
			const document = JSON.parse(request.source.draft.document_json) as WorkflowPackageDocument;
			const oldToken = document.text_uses[0].token;
			document.inputs[0].default = '\u0001';
			const newToken = inputToken(document.inputs[0].key, document.inputs[0].default);
			document.text_uses[0].token = newToken;
			const prompt = document.context.find((item) => item.kind === 'prompt');
			if (!prompt || prompt.kind !== 'prompt') throw new Error('missing draft prompt');
			prompt.body = prompt.body.replace(oldToken, newToken);
			request.source.draft.document_json = canonicalizeLibraryValue(
				await withLibraryDocumentDigest(document)
			);
			await route.continue({
				headers: { ...route.request().headers(), 'content-type': 'application/json' },
				postData: JSON.stringify(request)
			});
		});
		await ownerPage.getByRole('button', { name: 'Preview', exact: true }).click();
		const inputRepair = ownerPage.getByRole('button', { name: 'Repair Project name — default' });
		await expect(inputRepair).toBeVisible();
		await inputRepair.click();
		await expect(ownerPage.getByLabel('Default')).toBeFocused();
		await ownerPage.getByLabel('Default').fill('billing-service');
		await ownerPage.getByRole('button', { name: 'Save changes' }).click();
		await ownerPage.unroute('**/api/v1/publications/prepare');
		await ownerPage.getByRole('button', { name: 'Preview', exact: true }).click();
		await ownerPage.getByRole('button', { name: 'Continue to Share' }).click();
		await ownerPage
			.getByRole('checkbox', { name: /I have the right to share all included content/ })
			.check();
		await ownerPage.getByRole('button', { name: 'Publish workflow' }).click();
		await expect(ownerPage.getByRole('heading', { name: 'Shared', exact: true })).toBeVisible();
		const publicHref = await ownerPage.locator('a[href*="/p/"]').first().getAttribute('href');
		expect(publicHref).toBeTruthy();
		await ownerContext.close();

		const bobContext = await browser.newContext();
		await signIn(bobContext, BOB.sessionToken);
		const bobPage = await bobContext.newPage();
		await gotoHydrated(bobPage, `${new URL(publicHref!).pathname}/install`);
		await bobPage.getByLabel('Project name').fill('support-console');
		await bobPage.getByRole('button', { name: 'Preview installation' }).click();
		await bobPage.getByLabel(/I reviewed what will be installed/).check();
		await bobPage.getByRole('button', { name: 'Install workflow' }).click();
		await expect(bobPage.getByRole('heading', { name: 'Installed', exact: true })).toBeVisible();
		const installedHref = await bobPage
			.getByRole('link', { name: 'Open workflow' })
			.getAttribute('href');
		const installedId = installedHref!.split('/').at(-1)!;
		await bobContext.close();

		const bob = apiClient(request, BOB.apiKey);
		const installed = await body<{ states: { id: string }[] }>(
			await bob.get(`/api/v1/workflows/${installedId}`)
		);
		const installedContext = await body<{ items: { body: string | null }[] }>(
			await bob.get(`/api/v1/context?state=${installed.states[0].id}`)
		);
		expect(installedContext.items[0].body).toBe('support-console and customer-portal');
		const sourceContext = await body<{ items: { body: string | null }[] }>(
			await alice.get(`/api/v1/context?state=${workflow.states[0].id}`)
		);
		expect(sourceContext.items[0].body).toBe('customer-portal and customer-portal');
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
