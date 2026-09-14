import { expect, test, type APIRequestContext } from '@playwright/test';
import type { PublicationOwnerResult, PublicationProof } from '@tines/shared';
import { CAROL } from './constants.mjs';
import { d1, sqlLiteral } from './d1';
import { apiClient, body, runId } from './helpers';

test.describe.serial('native D1 publication transaction gate', () => {
	let workflowId: string;

	test.beforeAll(async ({ request }) => {
		workflowId = (
			await body<{ id: string }>(
				await apiClient(request, CAROL.apiKey).post('/api/v1/workflows', {
					name: `native-publication-${runId}`,
					description: 'Native D1 publication race fixture',
					initial_state: 'Open',
					states: [
						{ name: 'Open', category: 'active' },
						{ name: 'Done', category: 'done' }
					],
					transitions: [{ name: 'Finish', from: 'Open', to: 'Done' }]
				})
			)
		).id;
	});

	async function prepare(request: APIRequestContext, sequence: number) {
		return body<PublicationProof>(
			await apiClient(request, CAROL.apiKey).post('/api/v1/publications/prepare', {
				prepare_request_id: `${runId}-${sequence}`,
				source: { kind: 'owned_workflow', workflow_id: workflowId, options: {} },
				metadata: { display_name: 'Native D1', license: 'MIT', license_year: 2026 }
			})
		);
	}

	const confirmation = (proof: PublicationProof) => ({
		review_digest: proof.review_digest,
		sharing_rights: true,
		exact_content: true,
		reviewed_repo_ids: []
	});

	test('reconciles one candidate under concurrency and admits only one final quota slot', async ({
		request,
		playwright
	}) => {
		test.setTimeout(120_000);
		const second = await playwright.request.newContext();
		try {
			const first = await prepare(request, 0);
			const same = await Promise.all([
				apiClient(request, CAROL.apiKey).post(
					`/api/v1/publications/${first.candidate_id}/publish`,
					confirmation(first)
				),
				apiClient(second, CAROL.apiKey).post(
					`/api/v1/publications/${first.candidate_id}/publish`,
					confirmation(first)
				)
			]);
			expect(same.map((response) => response.status())).toEqual([200, 200]);
			const sameResults = await Promise.all(
				same.map((response) => body<PublicationOwnerResult>(response))
			);
			expect(new Set(sameResults.map((result) => result.receipt.snapshot_id)).size).toBe(1);

			for (let sequence = 1; sequence < 9; sequence += 1) {
				const proof = await prepare(request, sequence);
				expect(
					(
						await apiClient(request, CAROL.apiKey).post(
							`/api/v1/publications/${proof.candidate_id}/publish`,
							confirmation(proof)
						)
					).status()
				).toBe(200);
			}

			const final = await Promise.all([prepare(request, 9), prepare(request, 10)]);
			const raced = await Promise.all([
				apiClient(request, CAROL.apiKey).post(
					`/api/v1/publications/${final[0].candidate_id}/publish`,
					confirmation(final[0])
				),
				apiClient(second, CAROL.apiKey).post(
					`/api/v1/publications/${final[1].candidate_id}/publish`,
					confirmation(final[1])
				)
			]);
			expect(raced.map((response) => response.status()).sort()).toEqual([200, 429]);
			expect(
				d1(
					`SELECT COUNT(*) AS n FROM workflow_publication WHERE user_id=${sqlLiteral(CAROL.id)} AND published_at IS NOT NULL`
				)
			).toEqual([{ n: 10 }]);
			expect(
				d1(
					`SELECT COUNT(*) AS n FROM workflow_publication_event WHERE user_id=${sqlLiteral(CAROL.id)} AND action='published'`
				)
			).toEqual([{ n: 10 }]);
		} finally {
			await second.dispose();
		}
	});
});
