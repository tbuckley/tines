import { expect, test } from './fixtures';
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
import { inheritedPackage } from '../../../packages/shared/src/library/fixtures';
import { ALICE, BOB, PAGINATION, WORKFLOW_PUBLICATIONS_PUBLISHER } from './constants.mjs';
import { d1, sqlLiteral } from './d1';
import { apiClient, body, errorBody, gotoHydrated, runId, signIn, PHONE, DESKTOP } from './helpers';

const IMPLEMENTATION_JARGON =
	/candidate-only|candidate rebuilt|input declaration|registered tokens|save candidate text|prepared plan|signed plan identity|a different digest is refused/i;

async function expectPlainLanguage(page: import('@playwright/test').Page) {
	const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
	expect(text).not.toMatch(IMPLEMENTATION_JARGON);
}

test.describe.serial('public workflow snapshots', () => {
	let marker: string;
	let snapshotId: string;
	let documentJson: string;
	let hostedPlan: PrepareWorkflowPackageResponse;

	test.beforeAll(async ({ uniqueName }) => {
		marker = uniqueName('public-snapshot', { maxLength: 100 });
	});

	test('publishes exact bytes and exposes a responsive anonymous text-only inspection', async ({
		request,
		browser
	}) => {
		for (const mode of ['throw', '304']) {
			const boundary = await request.get('/p/e2e-worker-boundary', {
				headers: { 'x-tines-e2e-publication-boundary': mode }
			});
			expect(boundary.status(), mode).toBe(500);
			expect(boundary.headers()['cache-control'], mode).toBe('no-store, max-age=0');
			expect(boundary.headers()['content-security-policy'], mode).toContain("default-src 'none'");
			expect(boundary.headers()['referrer-policy'], mode).toBe('no-referrer');
			expect(boundary.headers()['x-content-type-options'], mode).toBe('nosniff');
			expect(boundary.headers().etag, mode).toBeUndefined();
			expect(await boundary.text(), mode).not.toContain('generated Worker failure');
		}

		const publisher = apiClient(request, WORKFLOW_PUBLICATIONS_PUBLISHER.apiKey);
		const workflow = await body<{ id: string; states: { id: string; name: string }[] }>(
			await publisher.post('/api/v1/workflows', {
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
			await publisher.post('/api/v1/context', {
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
			await publisher.post('/api/v1/publications/prepare', {
				prepare_request_id: crypto.randomUUID(),
				source: { kind: 'owned_workflow', workflow_id: workflow.id, options: {} },
				metadata: { display_name: 'Alice Example', license: 'MIT', license_year: 2026 }
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
		snapshotId = published.receipt.snapshot_id;
		documentJson = canonicalizeLibraryValue(proof.document);

		const ownerContext = await browser.newContext();
		await signIn(ownerContext, WORKFLOW_PUBLICATIONS_PUBLISHER.sessionToken);
		const ownerPage = await ownerContext.newPage();
		await gotoHydrated(ownerPage, `/workflows/${workflow.id}/export#publish`);
		await expectPlainLanguage(ownerPage);
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

		let releaseExpiredPreparation!: () => void;
		const heldExpiredPreparation = new Promise<void>(
			(resolve) => (releaseExpiredPreparation = resolve)
		);
		let expiredPreparationStarted!: () => void;
		const startedExpiredPreparation = new Promise<void>(
			(resolve) => (expiredPreparationStarted = resolve)
		);
		await ownerPage.route('**/api/v1/publications/prepare', async (route) => {
			const response = await route.fetch();
			const expired = (await response.json()) as PublicationProof;
			expired.expires_at = 0;
			expiredPreparationStarted();
			await heldExpiredPreparation;
			await route.fulfill({ response, json: expired });
		});
		await ownerPage.getByRole('button', { name: 'Preview', exact: true }).click();
		await startedExpiredPreparation;
		await displayName.fill('Alice Current');
		const expiredResponse = ownerPage.waitForResponse('**/api/v1/publications/prepare');
		releaseExpiredPreparation();
		await expiredResponse;
		await expect(ownerPage.getByTestId('package-actions')).toContainText(
			'Your display name changed. Preview this version again.'
		);
		await expect(ownerPage.getByTestId('package-actions')).not.toContainText(
			'The preview expired before it was ready.'
		);
		await ownerPage.unroute('**/api/v1/publications/prepare');
		await ownerPage.getByRole('button', { name: 'Preview', exact: true }).click();
		await expect(ownerPage.getByRole('heading', { name: 'Preview', exact: true })).toBeFocused();
		await expectPlainLanguage(ownerPage);
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
		expect(prepareRequests).toBe(3);
		expect(new Set(prepareRequestIds).size).toBe(3);
		await continueAction.click();
		await expect(
			ownerPage.getByRole('heading', { name: 'Ready to share', exact: true })
		).toBeFocused();
		await expectPlainLanguage(ownerPage);
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
		for (const path of [
			`/p/${snapshotId}`,
			`/api/v1/publications/public/${snapshotId}`,
			`/api/v1/publications/public/${snapshotId}/status`,
			`/api/v1/publications/public/${snapshotId}/download`,
			`/api/v1/publications/public/${snapshotId}/reuse.txt`,
			`/api/v1/publications/public/${snapshotId}/unknown`
		]) {
			const conditional = await request.get(path, { headers: { 'if-none-match': '*' } });
			expect(conditional.status(), path).not.toBe(304);
			const headers = conditional.headers();
			if (!headers['cache-control'])
				throw new Error(`missing public boundary on ${path} (${conditional.status()})`);
			expect(headers['cache-control'], path).toContain('no-store');
			expect(headers['referrer-policy'], path).toBe('no-referrer');
			expect(headers['x-content-type-options'], path).toBe('nosniff');
			expect(headers['content-security-policy'], path).toContain("default-src 'none'");
			expect(headers.etag, path).toBeUndefined();
			const head = await request.fetch(path, { method: 'HEAD' });
			expect(await head.body(), path).toHaveLength(0);
			expect(head.headers()['cache-control'], path).toContain('no-store');
		}
		const unauthenticatedPrepare = await request.post(
			`/api/v1/publications/public/${snapshotId}/prepare-install`,
			{ data: { choices: {} } }
		);
		expect(unauthenticatedPrepare.status()).toBe(401);
		expect(unauthenticatedPrepare.headers()['cache-control']).toContain('no-store');

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

		let socialPayload: Record<string, unknown> | undefined;
		let socialAttempts = 0;
		await page.route('**/api/auth/**', async (route) => {
			if (route.request().method() !== 'POST') return route.continue();
			socialAttempts += 1;
			socialPayload = route.request().postDataJSON();
			await route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: '{"message":"provider unavailable"}'
			});
		});
		await page.getByRole('button', { name: 'Sign in to install' }).click();
		await page.getByRole('button', { name: 'Continue with Google' }).click();
		await expect(page.getByRole('status')).toHaveText('provider unavailable');
		expect(socialPayload).toMatchObject({
			provider: 'google',
			callbackURL: `/p/${snapshotId}/install`
		});
		await page.getByRole('button', { name: 'Continue with Google' }).click();
		await expect.poll(() => socialAttempts).toBe(2);
		await page.getByRole('button', { name: 'Close sign-in' }).click();
		await page.unroute('**/api/auth/**');

		await page.getByRole('button', { name: 'Sign in to install' }).click();
		const email = `publication-${runId}@example.com`;
		await page.getByPlaceholder('you@example.com').fill(email);
		await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
		await expect(page.getByText('Check your email')).toBeVisible();
		await expect(page.getByText(email)).toBeVisible();
		await page.getByRole('button', { name: 'Close sign-in' }).click();

		await page.goto(
			`/api/auth/magic-link/verify?token=invalid-publication-token&callbackURL=${encodeURIComponent(`/p/${snapshotId}/install`)}&errorCallbackURL=${encodeURIComponent(`/p/${snapshotId}?install=1&error=signin`)}`
		);
		await expect(page).toHaveURL(new RegExp(`/p/${snapshotId}.*error=INVALID_TOKEN`));
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect(page.getByRole('status')).toContainText('invalid or has expired');
		await page.getByRole('button', { name: 'Close sign-in' }).click();

		const validToken = `e2e-magic-link-${email}`;
		const installsBefore = d1<{ n: number }>(
			`SELECT COUNT(*) AS n FROM library_install WHERE user_id=${sqlLiteral(BOB.id)}`
		)[0].n;
		const validContext = await browser.newContext();
		const validPage = await validContext.newPage();
		await validPage.goto(
			`/api/auth/magic-link/verify?token=${encodeURIComponent(validToken)}&callbackURL=${encodeURIComponent(`/p/${snapshotId}/install`)}&errorCallbackURL=${encodeURIComponent(`/p/${snapshotId}?install=1&error=signin`)}`
		);
		await expect(validPage).toHaveURL(`/workflows/import?publication=${snapshotId}`);
		await expect(
			validPage.getByRole('heading', { name: 'Install workflow', exact: true })
		).toBeVisible();
		expect(
			d1<{ n: number }>(
				`SELECT COUNT(*) AS n FROM library_install WHERE user_id=${sqlLiteral(BOB.id)}`
			)[0].n
		).toBe(installsBefore);
		await validContext.close();

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

	test('pages more than 100 owner rows through API and Next, Back, and First UI controls', async ({
		browser,
		request
	}) => {
		d1(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<204)
			INSERT INTO workflow_publication(
				id,user_id,actor_key,prepare_request_id,prepare_request_hash,source_workflow_id,
				source_kind,source_provenance_json,document_json,document_digest,bytes_sha256,
				byte_length,metadata_json,review_digest,policy_version,created_at,expires_at,
				snapshot_id,published_at,owner_state,host_state,status_version,confirmed_at,
				confirmed_actor_key,publication_receipt_json,attempt_nonce,host_decision_reason,
				host_decision_reference)
			SELECT 'pub_page_'||printf('%03d',i),${sqlLiteral(PAGINATION.user.id)},actor_key,
				'page_request_'||printf('%03d',i),prepare_request_hash,NULL,source_kind,
				source_provenance_json,document_json,document_digest,bytes_sha256,byte_length,
				json_object('display_name','Pagination '||printf('%03d',i),'license','MIT','license_year',2026),
				review_digest,policy_version,created_at,expires_at,'snapshot_page_'||printf('%03d',i),
				CASE WHEN i<102 THEN 3000 ELSE 2000 END,owner_state,host_state,status_version,
				confirmed_at,confirmed_actor_key,publication_receipt_json,attempt_nonce,
				host_decision_reason,host_decision_reference
			FROM workflow_publication,n WHERE snapshot_id=${sqlLiteral(snapshotId)}`);
		const api = apiClient(request, PAGINATION.user.apiKey);
		const first = await body<{ items: Array<{ candidate_id: string }>; next_cursor: string }>(
			await api.get('/api/v1/publications?limit=100')
		);
		expect(first.items).toHaveLength(100);
		const second = await body<{ items: Array<{ candidate_id: string }>; next_cursor: string }>(
			await api.get(
				`/api/v1/publications?limit=100&cursor=${encodeURIComponent(first.next_cursor)}`
			)
		);
		expect(second.items).toHaveLength(100);
		const third = await body<{ items: Array<{ candidate_id: string }>; next_cursor: null }>(
			await api.get(
				`/api/v1/publications?limit=100&cursor=${encodeURIComponent(second.next_cursor)}`
			)
		);
		expect(third.items).toHaveLength(5);
		expect(
			new Set([...first.items, ...second.items, ...third.items].map((item) => item.candidate_id))
				.size
		).toBe(205);
		expect((await api.get('/api/v1/publications?cursor=not-a-cursor')).status()).toBe(400);
		const foreignRow = d1<{ published_at: number; id: string }>(
			`SELECT published_at,id FROM workflow_publication WHERE snapshot_id=${sqlLiteral(snapshotId)}`
		)[0];
		const foreignCursor = Buffer.from(`${foreignRow.published_at}:${foreignRow.id}`).toString(
			'base64url'
		);
		const foreignPage = await body<{ items: Array<{ candidate_id: string }> }>(
			await api.get(`/api/v1/publications?cursor=${encodeURIComponent(foreignCursor)}`)
		);
		expect(foreignPage.items.every((item) => item.candidate_id.startsWith('pub_page_'))).toBe(true);

		const context = await browser.newContext();
		await signIn(context, PAGINATION.user.sessionToken);
		const page = await context.newPage();
		await gotoHydrated(page, '/publications');
		await expect(page.locator('article')).toHaveCount(100);
		await page.getByRole('link', { name: 'Next page' }).click();
		await expect(page.locator('article')).toHaveCount(100);
		await expect(page.getByRole('link', { name: 'First page' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Next page' })).toBeVisible();
		for (const viewport of [DESKTOP, PHONE]) {
			await page.setViewportSize(viewport);
			const next = await page.getByRole('link', { name: 'Next page' }).boundingBox();
			const firstPage = await page.getByRole('link', { name: 'First page' }).boundingBox();
			expect(next).not.toBeNull();
			expect(firstPage).not.toBeNull();
			expect(firstPage!.x - (next!.x + next!.width)).toBeGreaterThan(0);
			expect(Math.min(next!.height, firstPage!.height)).toBeGreaterThanOrEqual(40);
		}
		await page.getByRole('link', { name: 'Next page' }).click();
		await expect(page.locator('article')).toHaveCount(5);
		await expect(page.getByRole('link', { name: 'First page' })).toBeVisible();
		await page.goBack();
		await expect(page.locator('article')).toHaveCount(100);
		await page.getByRole('link', { name: 'First page' }).click();
		await expect(page).toHaveURL('/publications');
		await expect(page.locator('article')).toHaveCount(100);
		await context.close();
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
		let committedReceipt: WorkflowPackageReceipt | undefined;
		await page.route('**/api/v1/library/install', async (route) => {
			const response = await route.fetch();
			expect(response.ok()).toBe(true);
			committedReceipt = await response.json();
			await route.abort('connectionreset');
		});
		await install.click();
		await expect(
			page.getByRole('heading', { name: 'Installation status is unknown' })
		).toBeVisible();
		await expect(page.getByRole('button', { name: 'Check result' })).toBeVisible();
		await expect(page.getByLabel('Workflow package file')).toHaveCount(0);
		await expect(
			page.getByText('choose the same workflow package file again', { exact: false })
		).toHaveCount(0);
		const recoveryDetails = page
			.getByRole('heading', { name: 'Installation status is unknown' })
			.locator('..')
			.locator('details');
		await expect(recoveryDetails).not.toHaveAttribute('open', '');
		await expectPlainLanguage(page);
		await page.reload({ waitUntil: 'networkidle' });
		await expect(
			page.getByRole('heading', { name: 'Installation status is unknown' })
		).toBeVisible();
		await expect(page.getByLabel('Workflow package file')).toHaveCount(0);
		await page.getByRole('button', { name: 'Check result' }).click();
		await expect(page.getByRole('heading', { name: 'Installed', exact: true })).toBeVisible();
		expect(committedReceipt?.id).toBeTruthy();
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
		const failedRecheck = observed.waitForResponse(
			(response) =>
				response.url().endsWith(`/api/v1/publications/public/${snapshotId}/status`) &&
				response.status() === 404
		);
		await observed.evaluate(() => dispatchEvent(new Event('focus')));
		await started;
		await expect(observed.getByText(marker, { exact: false })).toHaveCount(0);
		await expect(observed).toHaveTitle('Publication unavailable');
		const publisher = apiClient(request, WORKFLOW_PUBLICATIONS_PUBLISHER.apiKey);
		expect((await publisher.post(`/api/v1/publications/${snapshotId}/withdraw`)).ok()).toBe(true);
		releaseStatus();
		await failedRecheck;
		await observed.evaluate(
			() =>
				new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
				)
		);
		await expect(observed.getByText(/not available/i)).toBeVisible();
		await expect(observed.getByText(marker, { exact: false })).toHaveCount(0);
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

	test('navigates exact token occurrences, dependencies, inheritance, and tables', async ({
		page,
		request
	}) => {
		const document = inheritedPackage();
		document.workflows[0].description =
			'First {{filing_label:qa}} then second {{filing_label:qa}} occurrence.';
		document.context[0].body += '\n\n| Column | Value |\n| - | - |\n| Safe | rendered |';
		const sealed = await withLibraryDocumentDigest(document);
		const publisher = apiClient(request, WORKFLOW_PUBLICATIONS_PUBLISHER.apiKey);
		const proof = await body<PublicationProof>(
			await publisher.post('/api/v1/publications/prepare', {
				prepare_request_id: crypto.randomUUID(),
				source: { kind: 'file', document_json: canonicalizeLibraryValue(sealed) },
				metadata: { display_name: 'Inspector fixture', license: 'MIT', license_year: 2026 }
			})
		);
		const published = await body<PublicationOwnerResult>(
			await publisher.post(`/api/v1/publications/${proof.candidate_id}/publish`, {
				review_digest: proof.review_digest,
				sharing_rights: true,
				exact_content: true,
				reviewed_repo_ids: ['context:3']
			})
		);
		await gotoHydrated(page, `/p/${published.receipt.snapshot_id}`);
		const tokens = page.getByRole('button', { name: /Show declaration for/ });
		expect(await tokens.count()).toBeGreaterThanOrEqual(3);
		const tokenIds = await tokens.evaluateAll((elements) => elements.map((element) => element.id));
		expect(new Set(tokenIds).size).toBe(tokenIds.length);
		const second = tokens.nth(1);
		await second.click();
		await expect(page.locator('[id="public-input-7-input:1"]')).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(second).toBeFocused();
		const tokenInAnotherField = tokens.nth(2);
		await tokenInAnotherField.click();
		await expect(page.locator('[id="public-input-7-input:1"]')).toBeFocused();
		await page.getByRole('button', { name: 'Back to source' }).click();
		await expect(tokenInAnotherField).toBeFocused();

		await page.getByRole('button', { name: 'Shared', exact: true }).click();
		await expect(page.locator('[id="public-workflow-10-workflow:2"]')).toBeFocused();
		await page.keyboard.press('Escape');
		await page.getByRole('button', { name: 'Base', exact: true }).click();
		await expect(page.locator('[id="public-state-7-state:3"]')).toBeFocused();
		await expect(page.getByRole('table')).toContainText('Safe');
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
