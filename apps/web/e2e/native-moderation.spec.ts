import { expect, test } from '@playwright/test';
import type { PublicationOwnerResult, PublicationProof } from '@tines/shared';
import { ALICE } from './constants.mjs';
import { d1, sqlLiteral } from './d1';
import { apiClient, body, errorBody, runId, signIn } from './helpers';

test.describe.serial('native D1 moderation gates', () => {
	let snapshotId: string;
	const marker = `native-moderation-${runId}`;

	test.beforeAll(async ({ request }) => {
		const alice = apiClient(request, ALICE.apiKey);
		const workflow = await body<{ id: string }>(
			await alice.post('/api/v1/workflows', {
				name: marker,
				description: marker,
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
				metadata: { display_name: 'Native moderator', license: 'MIT', license_year: 2026 }
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
	});

	test('commits only five concurrent network reports and keeps host data private', async ({
		page,
		request
	}) => {
		test.setTimeout(60_000);
		await page.goto(`/p/${snapshotId}`);
		const statuses = await page.evaluate(
			async (id) =>
				Promise.all(
					Array.from({ length: 6 }, (_, index) =>
						fetch(`/api/v1/publications/public/${id}/reports`, {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({
								request_id: crypto.randomUUID(),
								reason: 'other',
								note: `private-native-${index}`
							})
						}).then((response) => response.status)
					)
				),
			snapshotId
		);
		expect(statuses.sort()).toEqual([201, 201, 201, 201, 201, 429]);
		expect(
			d1(`SELECT COUNT(*) AS n FROM workflow_report WHERE snapshot_id=${sqlLiteral(snapshotId)}`)
		).toEqual([{ n: 5 }]);

		const denied = await apiClient(request, ALICE.apiKey).get(
			`/api/v1/host/workflow-moderation/snapshots/${snapshotId}`
		);
		expect(denied.status()).toBe(403);
		expect(JSON.stringify(await errorBody(denied))).not.toContain('private-native');
	});

	test('reconciles concurrent identical host decisions to one native audit row', async ({
		browser,
		request
	}) => {
		const firstContext = await browser.newContext();
		const secondContext = await browser.newContext();
		await Promise.all([
			signIn(firstContext, ALICE.sessionToken),
			signIn(secondContext, ALICE.sessionToken)
		]);
		const [firstPage, secondPage] = await Promise.all([
			firstContext.newPage(),
			secondContext.newPage()
		]);
		await Promise.all([
			firstPage.goto('/host/workflow-reports'),
			secondPage.goto('/host/workflow-reports')
		]);
		const requestId = crypto.randomUUID();
		const [{ status_version: snapshotVersion }] = d1<{ status_version: number }>(
			`SELECT status_version FROM workflow_publication WHERE snapshot_id=${sqlLiteral(snapshotId)}`
		);
		const payload = {
			request_id: requestId,
			action: 'disable',
			target: { snapshot_id: snapshotId },
			reason: 'Native urgent decision',
			expected_snapshot_version: snapshotVersion
		};
		const results = await Promise.all(
			[firstPage, secondPage].map((moderatorPage) =>
				moderatorPage.evaluate(async (body) => {
					const response = await fetch('/api/v1/host/workflow-moderation/decisions', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(body)
					});
					return { status: response.status, body: await response.json() };
				}, payload)
			)
		);
		expect(results.map((result) => result.status)).toEqual([200, 200]);
		expect(results[0].body).toEqual(results[1].body);
		expect(
			d1(
				`SELECT COUNT(*) AS n FROM workflow_moderation_audit WHERE request_id=${sqlLiteral(requestId)}`
			)
		).toEqual([{ n: 1 }]);
		expect((await request.get(`/p/${snapshotId}`)).status()).toBe(404);
		await Promise.all([firstContext.close(), secondContext.close()]);
	});
});
