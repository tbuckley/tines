import { expect, test } from '@playwright/test';
import type { PublicationOwnerResult, PublicationProof } from '@tines/shared';
import { ALICE } from './constants.mjs';
import { apiClient, body, gotoHydrated, PHONE, runId, signIn } from './helpers';

test('reports, removes, restores, suspends and recovers one exact public snapshot', async ({
	browser,
	page,
	request
}) => {
	test.setTimeout(90_000);
	const marker = `moderation-journey-${runId}`;
	const alice = apiClient(request, ALICE.apiKey);
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

	await page.setViewportSize(PHONE);
	await gotoHydrated(page, `/p/${snapshotId}`);
	await page.getByRole('button', { name: 'Report', exact: true }).click();
	await page.getByLabel('Reason').selectOption('malicious_phishing');
	await page.getByLabel('Details (optional)').fill(`private ${marker}`);
	await page.getByRole('button', { name: 'Send report' }).click();
	await expect(page.getByText(/^Reference: rpt_/)).toBeFocused();

	const moderator = await browser.newContext();
	await signIn(moderator, ALICE.sessionToken);
	const host = await moderator.newPage();
	await gotoHydrated(host, '/host/workflow-reports');
	await host.getByText(marker, { exact: true }).click();
	await expect(host.getByText(`private ${marker}`, { exact: true })).toBeVisible();
	await expect(host.getByText('https://example.test/track', { exact: false })).toBeVisible();
	await expect(host.getByRole('link', { name: /hostile destination/i })).toHaveCount(0);

	await host.getByLabel('Reason').fill('Publisher-safe removal reason');
	await host.getByRole('button', { name: 'Disable now' }).click();
	await expect(host.getByText('disable recorded.')).toBeVisible();
	expect((await request.get(`/p/${snapshotId}`)).status()).toBe(404);

	await host.getByLabel('Reason').fill('Current-policy content reviewed');
	await host.getByRole('button', { name: 'Restore' }).click();
	await expect(host.getByText('restore recorded.')).toBeVisible();
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

	await host.getByLabel('Reason').fill('Appeal reviewed; explicit recovery');
	await host.getByRole('button', { name: 'Unsuspend' }).click();
	await expect(host.getByText('unsuspend recorded.')).toBeVisible();
	expect((await request.get(`/p/${snapshotId}`)).status()).toBe(200);
	await Promise.all([moderator.close(), owner.close()]);
});
