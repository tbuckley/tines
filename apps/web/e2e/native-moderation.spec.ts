import {
	canonicalizeLibraryValue,
	type PrepareWorkflowPackageResponse,
	type PublicationOwnerResult,
	type PublicationProof
} from '@tines/shared';
import type { APIRequestContext, Page } from '@playwright/test';
import { ALICE, BOB } from './constants.mjs';
import { d1, sqlLiteral } from './d1';
import { expect, test } from './fixtures';
import { apiClient, body, errorBody, signIn } from './helpers';

test.describe.serial('native D1 moderation gates', () => {
	let snapshotId: string;
	let marker: string;

	async function prepareCandidate(request: APIRequestContext, suffix: string) {
		const alice = apiClient(request, ALICE.apiKey);
		const workflow = await body<{ id: string }>(
			await alice.post('/api/v1/workflows', {
				name: `${marker}-${suffix}`,
				description: `${marker}-${suffix}`,
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
				metadata: { display_name: `Native ${suffix}`, license: 'MIT', license_year: 2026 }
			})
		);
		return { alice, proof, documentJson: canonicalizeLibraryValue(proof.document) };
	}

	async function publishSnapshot(request: APIRequestContext, suffix: string) {
		const candidate = await prepareCandidate(request, suffix);
		const published = await body<PublicationOwnerResult>(
			await candidate.alice.post(`/api/v1/publications/${candidate.proof.candidate_id}/publish`, {
				review_digest: candidate.proof.review_digest,
				sharing_rights: true,
				exact_content: true,
				reviewed_repo_ids: []
			})
		);
		return {
			...candidate,
			snapshotId: published.receipt.snapshot_id
		};
	}

	async function report(page: Page, id: string, action?: 'disable' | 'suspend') {
		return page.evaluate(
			async ({ snapshot, mutation }) => {
				const response = await fetch(`/api/v1/publications/public/${snapshot}/reports`, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						...(mutation ? { 'x-tines-e2e-publication-race': mutation } : {})
					},
					body: JSON.stringify({
						request_id: crypto.randomUUID(),
						reason: 'other',
						note: `native ${mutation ?? 'first'} report`
					})
				});
				return response.status;
			},
			{ snapshot: id, mutation: action }
		);
	}

	test.beforeAll(async ({ apiFor, uniqueName }) => {
		marker = uniqueName('native-moderation', { maxLength: 100 });
		const alice = apiFor(ALICE);
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
		// The e2e worker sees one loopback network. Release only this fixture's quota rows so
		// later public-report journeys still exercise their own five-slot window.
		d1(`DELETE FROM workflow_report_rate_event WHERE receipt_id IN
			(SELECT id FROM workflow_report WHERE snapshot_id=${sqlLiteral(snapshotId)})`);

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

	test('orders native report admission against disable and suspension in both directions', async ({
		page,
		request
	}) => {
		test.setTimeout(90_000);
		for (const action of ['disable', 'suspend'] as const) {
			d1(`DELETE FROM workflow_publisher_status WHERE user_id=${sqlLiteral(ALICE.id)}`);
			const statusFirst = await publishSnapshot(request, `report-${action}-status-first`);
			await page.goto(`/p/${statusFirst.snapshotId}`);
			expect(await report(page, statusFirst.snapshotId, action)).toBe(404);
			expect(
				d1(`SELECT id FROM workflow_report WHERE snapshot_id=${sqlLiteral(statusFirst.snapshotId)}`)
			).toEqual([]);

			d1(`DELETE FROM workflow_publisher_status WHERE user_id=${sqlLiteral(ALICE.id)}`);
			const reportFirst = await publishSnapshot(request, `report-${action}-report-first`);
			await page.goto(`/p/${reportFirst.snapshotId}`);
			expect(await report(page, reportFirst.snapshotId)).toBe(201);
			if (action === 'disable') {
				d1(
					`UPDATE workflow_publication SET host_state='removed', status_version=status_version+1
					 WHERE snapshot_id=${sqlLiteral(reportFirst.snapshotId)}`
				);
			} else {
				d1(
					`INSERT INTO workflow_publisher_status (user_id, suspended, status_version)
					 VALUES (${sqlLiteral(ALICE.id)}, 1, 1)`
				);
			}
			expect((await request.get(`/p/${reportFirst.snapshotId}`)).status()).toBe(404);
			expect(
				d1(
					`SELECT COUNT(*) AS n FROM workflow_report WHERE snapshot_id=${sqlLiteral(reportFirst.snapshotId)}`
				)
			).toEqual([{ n: 1 }]);
		}
		d1(`DELETE FROM workflow_publisher_status WHERE user_id=${sqlLiteral(ALICE.id)}`);
	});

	test('orders native final install against disable and suspension and rejects restored stale plans', async ({
		request
	}) => {
		test.setTimeout(120_000);
		const bob = apiClient(request, BOB.apiKey);
		const prepare = async (suffix: string) => {
			d1(`DELETE FROM workflow_publisher_status WHERE user_id=${sqlLiteral(ALICE.id)}`);
			const publication = await publishSnapshot(request, suffix);
			const plan = await body<PrepareWorkflowPackageResponse>(
				await bob.post(`/api/v1/publications/public/${publication.snapshotId}/prepare-install`, {
					choices: {}
				})
			);
			return { ...publication, plan };
		};
		const install = (fixture: Awaited<ReturnType<typeof prepare>>, mutation?: string) =>
			request.post('/api/v1/library/install', {
				headers: {
					authorization: `Bearer ${BOB.apiKey}`,
					...(mutation ? { 'x-tines-e2e-publication-race': mutation } : {})
				},
				data: {
					document_json: fixture.documentJson,
					plan_token: fixture.plan.plan_token,
					confirmation: { plan_digest: fixture.plan.plan_digest }
				}
			});

		for (const action of ['disable', 'suspend'] as const) {
			const statusFirst = await prepare(`install-${action}-status-first`);
			const refused = await install(statusFirst, action);
			expect(refused.status()).toBe(409);
			expect((await errorBody(refused)).error.code).toBe('plan_stale');
			expect(
				d1(`SELECT id FROM library_install WHERE id=${sqlLiteral(statusFirst.plan.plan_id)}`)
			).toEqual([]);

			const installFirst = await prepare(`install-${action}-install-first`);
			const receipt = await install(installFirst);
			expect(receipt.status()).toBe(200);
			if (action === 'disable') {
				d1(
					`UPDATE workflow_publication SET host_state='removed', status_version=status_version+1
					 WHERE snapshot_id=${sqlLiteral(installFirst.snapshotId)}`
				);
			} else {
				d1(
					`INSERT INTO workflow_publisher_status (user_id, suspended, status_version)
					 VALUES (${sqlLiteral(ALICE.id)}, 1, 1)`
				);
			}
			expect((await request.get(`/p/${installFirst.snapshotId}`)).status()).toBe(404);
			expect(
				d1(
					`SELECT COUNT(*) AS n FROM library_install WHERE id=${sqlLiteral(installFirst.plan.plan_id)}`
				)
			).toEqual([{ n: 1 }]);
		}

		const restored = await prepare('install-restored-stale');
		d1(
			`UPDATE workflow_publication SET host_state='removed', status_version=status_version+1
			 WHERE snapshot_id=${sqlLiteral(restored.snapshotId)};
			 UPDATE workflow_publication SET host_state='active', status_version=status_version+1
			 WHERE snapshot_id=${sqlLiteral(restored.snapshotId)}`
		);
		expect((await install(restored)).status()).toBe(409);

		const unsuspended = await prepare('install-unsuspended-stale');
		d1(
			`INSERT INTO workflow_publisher_status (user_id, suspended, status_version)
			 VALUES (${sqlLiteral(ALICE.id)}, 1, 1);
			 UPDATE workflow_publisher_status SET suspended=0, status_version=status_version+1
			 WHERE user_id=${sqlLiteral(ALICE.id)}`
		);
		expect((await install(unsuspended)).status()).toBe(409);
		d1(`DELETE FROM workflow_publisher_status WHERE user_id=${sqlLiteral(ALICE.id)}`);
	});

	test('orders native publisher suspension against publication in both directions', async ({
		request
	}) => {
		d1(`DELETE FROM workflow_publisher_status WHERE user_id=${sqlLiteral(ALICE.id)}`);
		const statusFirst = await prepareCandidate(request, 'publish-status-first');
		const refused = await request.post(
			`/api/v1/publications/${statusFirst.proof.candidate_id}/publish`,
			{
				headers: {
					authorization: `Bearer ${ALICE.apiKey}`,
					'x-tines-e2e-publication-race': 'suspend'
				},
				data: {
					review_digest: statusFirst.proof.review_digest,
					sharing_rights: true,
					exact_content: true,
					reviewed_repo_ids: []
				}
			}
		);
		expect(refused.status()).toBe(403);
		expect((await errorBody(refused)).error.code).toBe('publisher_suspended');
		expect(
			d1(
				`SELECT snapshot_id FROM workflow_publication WHERE id=${sqlLiteral(statusFirst.proof.candidate_id)}`
			)
		).toEqual([{ snapshot_id: null }]);

		d1(`DELETE FROM workflow_publisher_status WHERE user_id=${sqlLiteral(ALICE.id)}`);
		const publicationFirst = await publishSnapshot(request, 'publish-publication-first');
		d1(
			`INSERT INTO workflow_publisher_status (user_id, suspended, status_version)
			 VALUES (${sqlLiteral(ALICE.id)}, 1, 1)`
		);
		expect((await request.get(`/p/${publicationFirst.snapshotId}`)).status()).toBe(404);
		d1(`DELETE FROM workflow_publisher_status WHERE user_id=${sqlLiteral(ALICE.id)}`);
	});
});
