import type { APIRequestContext, Browser } from '@playwright/test';
import { expect, test } from './fixtures';
import {
	canonicalizeLibraryValue,
	type PrepareWorkflowPackageResponse,
	type PublicationOwnerResult,
	type PublicationProof,
	type WorkflowPackageReceipt
} from '@tines/shared';
import {
	ALICE,
	BASE_URL,
	BOB,
	CAROL,
	NATIVE_PUBLICATIONS_PUBLISHER,
	PUBLICATION_DAILY_QUOTA
} from './constants.mjs';
import { d1, sqlLiteral } from './d1';
import { apiClient, body, runId, signIn } from './helpers';

test.describe.serial('native D1 publication transaction gate', () => {
	let workflowId: string;

	test.beforeAll(async ({ apiFor, uniqueName }) => {
		workflowId = (
			await body<{ id: string }>(
				await apiFor(CAROL).post('/api/v1/workflows', {
					name: uniqueName('native-publication', { maxLength: 100 }),
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
				prepare_request_id: `${workflowId}-${sequence}`,
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

	test('rejects a stale owned source without a receipt, event, or quota write', async ({
		request
	}) => {
		const publisher = apiClient(request, NATIVE_PUBLICATIONS_PUBLISHER.apiKey);
		const source = await body<{ id: string }>(
			await publisher.post('/api/v1/workflows', {
				name: `native-source-race-${runId}`,
				description: 'reviewed source',
				initial_state: 'Open',
				states: [{ name: 'Open', category: 'active' }],
				transitions: []
			})
		);
		const proof = await body<PublicationProof>(
			await publisher.post('/api/v1/publications/prepare', {
				prepare_request_id: `native-source-stale-${runId}`,
				source: { kind: 'owned_workflow', workflow_id: source.id, options: {} },
				metadata: { display_name: 'Native source race', license: 'MIT', license_year: 2026 }
			})
		);
		expect(
			(await publisher.patch(`/api/v1/workflows/${source.id}`, { description: 'changed' })).ok()
		).toBe(true);
		const publish = await publisher.post(
			`/api/v1/publications/${proof.candidate_id}/publish`,
			confirmation(proof)
		);
		expect(publish.status()).toBe(409);
		expect(await publish.json()).toMatchObject({ error: { code: 'publication_source_changed' } });
		expect(
			d1(
				`SELECT published_at, snapshot_id, publication_receipt_json FROM workflow_publication WHERE id=${sqlLiteral(proof.candidate_id)}`
			)
		).toEqual([{ published_at: null, snapshot_id: null, publication_receipt_json: null }]);
		expect(
			d1(
				`SELECT COUNT(*) AS n FROM workflow_publication_event WHERE publication_id=${sqlLiteral(proof.candidate_id)}`
			)
		).toEqual([{ n: 0 }]);
	});

	test('rechecks a draft-mode source with the native D1 publication guard', async ({ request }) => {
		const alice = apiClient(request, ALICE.apiKey);
		const source = await body<{ id: string }>(
			await alice.post('/api/v1/workflows', {
				name: `native-draft-source-${runId}`,
				description: 'reviewed draft source',
				initial_state: 'Open',
				states: [{ name: 'Open', category: 'active' }],
				transitions: []
			})
		);
		const baseline = await body<PublicationProof>(
			await alice.post('/api/v1/publications/prepare', {
				prepare_request_id: `native-draft-baseline-${runId}`,
				source: { kind: 'owned_workflow', workflow_id: source.id, options: {} },
				metadata: { display_name: 'Native draft baseline', license: 'MIT', license_year: 2026 }
			})
		);
		const proof = await body<PublicationProof>(
			await alice.post('/api/v1/publications/prepare', {
				prepare_request_id: `native-draft-guard-${runId}`,
				source: {
					kind: 'owned_workflow',
					workflow_id: source.id,
					options: {},
					draft: {
						version: 1,
						baseline: {
							document_digest: baseline.document_digest,
							exported_at: baseline.document.exported_at
						},
						document_json: canonicalizeLibraryValue(baseline.document)
					}
				},
				metadata: { display_name: 'Native draft', license: 'MIT', license_year: 2026 }
			})
		);
		const publishedBefore = d1(
			`SELECT COUNT(*) AS n FROM workflow_publication WHERE user_id=${sqlLiteral(ALICE.id)} AND published_at IS NOT NULL`
		);

		const publish = await request.post(`/api/v1/publications/${proof.candidate_id}/publish`, {
			headers: {
				authorization: `Bearer ${ALICE.apiKey}`,
				'x-tines-e2e-publication-precommit-workflow': source.id
			},
			data: confirmation(proof)
		});
		expect(publish.status()).toBe(409);
		expect(await publish.json()).toMatchObject({ error: { code: 'publication_proof_stale' } });
		expect(
			d1(
				`SELECT published_at, snapshot_id, publication_receipt_json FROM workflow_publication WHERE id=${sqlLiteral(proof.candidate_id)}`
			)
		).toEqual([{ published_at: null, snapshot_id: null, publication_receipt_json: null }]);
		expect(
			d1(
				`SELECT COUNT(*) AS n FROM workflow_publication_event WHERE publication_id=${sqlLiteral(proof.candidate_id)}`
			)
		).toEqual([{ n: 0 }]);
		expect(
			d1(
				`SELECT COUNT(*) AS n FROM workflow_publication WHERE user_id=${sqlLiteral(ALICE.id)} AND published_at IS NOT NULL`
			)
		).toEqual(publishedBefore);
		expect(
			d1(`SELECT description FROM workflow WHERE id=${sqlLiteral(source.id)}`)[0]?.description
		).toBe(`native precommit mutation ${proof.candidate_id}`);
	});

	test('serializes concurrent source mutation and preserves only reviewed frozen bytes', async ({
		request,
		playwright
	}) => {
		const second = await playwright.request.newContext();
		try {
			const publisher = apiClient(request, NATIVE_PUBLICATIONS_PUBLISHER.apiKey);
			const other = apiClient(second, NATIVE_PUBLICATIONS_PUBLISHER.apiKey);
			const source = await body<{ id: string }>(
				await publisher.post('/api/v1/workflows', {
					name: `native-source-concurrent-${runId}`,
					description: 'reviewed concurrent source',
					initial_state: 'Open',
					states: [{ name: 'Open', category: 'active' }],
					transitions: []
				})
			);
			const proof = await body<PublicationProof>(
				await publisher.post('/api/v1/publications/prepare', {
					prepare_request_id: `native-source-concurrent-${runId}`,
					source: { kind: 'owned_workflow', workflow_id: source.id, options: {} },
					metadata: {
						display_name: 'Native source concurrency',
						license: 'MIT',
						license_year: 2026
					}
				})
			);
			const [mutation, publish] = await Promise.all([
				other.patch(`/api/v1/workflows/${source.id}`, { description: 'changed concurrently' }),
				publisher.post(`/api/v1/publications/${proof.candidate_id}/publish`, confirmation(proof))
			]);
			expect(mutation.status()).toBe(200);
			expect([200, 409]).toContain(publish.status());
			if (publish.status() === 200) {
				const result = await body<PublicationOwnerResult>(publish);
				const detail = await body<{ document: { workflows: Array<{ description: string }> } }>(
					await request.get(`/api/v1/publications/public/${result.receipt.snapshot_id}`)
				);
				expect(detail.document.workflows[0].description).toBe('reviewed concurrent source');
			} else {
				expect(await publish.json()).toMatchObject({
					error: { code: 'publication_source_changed' }
				});
				expect(
					d1(
						`SELECT publication_receipt_json FROM workflow_publication WHERE id=${sqlLiteral(proof.candidate_id)}`
					)
				).toEqual([{ publication_receipt_json: null }]);
			}
		} finally {
			await second.dispose();
		}
	});

	test('rejects selected context and skill-file mutations with no publication writes', async ({
		request
	}) => {
		const publisher = apiClient(request, NATIVE_PUBLICATIONS_PUBLISHER.apiKey);
		const source = await body<{ id: string; states: Array<{ id: string }> }>(
			await publisher.post('/api/v1/workflows', {
				name: `native-context-race-${runId}`,
				description: 'selected context source',
				initial_state: 'Open',
				states: [{ name: 'Open', category: 'active' }],
				transitions: []
			})
		);
		const skill = await body<{ id: string }>(
			await publisher.post('/api/v1/context', {
				kind: 'skill',
				name: `native-skill-${runId}`,
				workflow_state_id: source.states[0].id,
				files: [{ path: 'SKILL.md', content: 'reviewed selected file' }]
			})
		);
		const proof = await body<PublicationProof>(
			await publisher.post('/api/v1/publications/prepare', {
				prepare_request_id: `native-selected-context-${runId}`,
				source: { kind: 'owned_workflow', workflow_id: source.id, options: {} },
				metadata: { display_name: 'Selected context race', license: 'MIT', license_year: 2026 }
			})
		);
		d1(
			`UPDATE context_item_file SET content='mutated selected file' WHERE context_item_id=${sqlLiteral(skill.id)}`
		);
		const publish = await publisher.post(
			`/api/v1/publications/${proof.candidate_id}/publish`,
			confirmation(proof)
		);
		expect(publish.status()).toBe(409);
		expect(await publish.json()).toMatchObject({ error: { code: 'publication_source_changed' } });
		expect(
			d1(
				`SELECT publication_receipt_json FROM workflow_publication WHERE id=${sqlLiteral(proof.candidate_id)}`
			)
		).toEqual([{ publication_receipt_json: null }]);
		expect(
			d1(
				`SELECT COUNT(*) AS n FROM workflow_publication_event WHERE publication_id=${sqlLiteral(proof.candidate_id)}`
			)
		).toEqual([{ n: 0 }]);
	});

	test('deletes a private source through the native route without deleting its snapshot', async ({
		request
	}) => {
		const publisher = apiClient(request, NATIVE_PUBLICATIONS_PUBLISHER.apiKey);
		const source = await body<{ id: string }>(
			await publisher.post('/api/v1/workflows', {
				name: `native-source-delete-${runId}`,
				description: 'survives private deletion',
				initial_state: 'Open',
				states: [{ name: 'Open', category: 'active' }],
				transitions: []
			})
		);
		const proof = await body<PublicationProof>(
			await publisher.post('/api/v1/publications/prepare', {
				prepare_request_id: `native-source-delete-${runId}`,
				source: { kind: 'owned_workflow', workflow_id: source.id, options: {} },
				metadata: { display_name: 'Native source deletion', license: 'MIT', license_year: 2026 }
			})
		);
		const published = await body<PublicationOwnerResult>(
			await publisher.post(
				`/api/v1/publications/${proof.candidate_id}/publish`,
				confirmation(proof)
			)
		);
		expect((await publisher.delete(`/api/v1/workflows/${source.id}`)).status()).toBe(204);
		expect(
			d1(
				`SELECT source_workflow_id FROM workflow_publication WHERE id=${sqlLiteral(proof.candidate_id)}`
			)
		).toEqual([{ source_workflow_id: null }]);
		const detail = await request.get(
			`/api/v1/publications/public/${published.receipt.snapshot_id}`
		);
		expect(detail.status()).toBe(200);
		expect(await detail.text()).toContain('survives private deletion');
	});

	type RevocationMode = 'withdrawal' | 'host' | 'publisher';

	function installedObjectCounts() {
		return d1<Record<string, number>>(
			`SELECT
			 (SELECT COUNT(*) FROM library_install WHERE user_id=${sqlLiteral(BOB.id)}) AS installs,
			 (SELECT COUNT(*) FROM workflow WHERE user_id=${sqlLiteral(BOB.id)}) AS workflows,
			 (SELECT COUNT(*) FROM workflow_state s JOIN workflow w ON w.id=s.workflow_id WHERE w.user_id=${sqlLiteral(BOB.id)}) AS states,
			 (SELECT COUNT(*) FROM workflow_transition t JOIN workflow w ON w.id=t.workflow_id WHERE w.user_id=${sqlLiteral(BOB.id)}) AS transitions,
			 (SELECT COUNT(*) FROM context_item WHERE user_id=${sqlLiteral(BOB.id)}) AS context_items,
			 (SELECT COUNT(*) FROM context_item_file f JOIN context_item c ON c.id=f.context_item_id WHERE c.user_id=${sqlLiteral(BOB.id)}) AS context_files,
			 (SELECT COUNT(*) FROM label WHERE user_id=${sqlLiteral(BOB.id)}) AS labels,
			 (SELECT COUNT(*) FROM routing_rule WHERE user_id=${sqlLiteral(BOB.id)}) AS routing_rules,
			 (SELECT COUNT(*) FROM scheduled_task s JOIN project p ON p.id=s.project_id WHERE p.user_id=${sqlLiteral(BOB.id)}) AS schedules,
			 (SELECT COUNT(*) FROM event WHERE user_id=${sqlLiteral(BOB.id)}) AS events`
		)[0];
	}

	async function exerciseRevocation(
		mode: RevocationMode,
		request: APIRequestContext,
		browser: Browser
	) {
		const publisher = apiClient(request, NATIVE_PUBLICATIONS_PUBLISHER.apiKey);
		const bob = apiClient(request, BOB.apiKey);
		const revokerContext = await browser.newContext();
		if (mode !== 'withdrawal') await signIn(revokerContext, ALICE.sessionToken);
		try {
			const source = await body<{ id: string }>(
				await publisher.post('/api/v1/workflows', {
					name: `native-${mode}-guard-${runId}`,
					description: `native ${mode} guard`,
					initial_state: 'Open',
					states: [{ name: 'Open', category: 'active' }],
					transitions: []
				})
			);
			const proof = await body<PublicationProof>(
				await publisher.post('/api/v1/publications/prepare', {
					prepare_request_id: `native-${mode}-guard-${runId}`,
					source: { kind: 'owned_workflow', workflow_id: source.id, options: {} },
					metadata: { display_name: `Native ${mode}`, license: 'MIT', license_year: 2026 }
				})
			);
			const published = await body<PublicationOwnerResult>(
				await publisher.post(
					`/api/v1/publications/${proof.candidate_id}/publish`,
					confirmation(proof)
				)
			);
			const snapshot = published.receipt.snapshot_id;
			if (mode === 'publisher')
				d1(
					`INSERT INTO workflow_publisher_status(user_id,suspended,status_version) VALUES(${sqlLiteral(NATIVE_PUBLICATIONS_PUBLISHER.id)},0,1)
					 ON CONFLICT(user_id) DO UPDATE SET suspended=0,status_version=status_version+1`
				);
			const documentJson = canonicalizeLibraryValue(proof.document);
			const prepareInstall = async () =>
				body<PrepareWorkflowPackageResponse>(
					await bob.post(`/api/v1/publications/public/${snapshot}/prepare-install`, { choices: {} })
				);
			const install = (plan: PrepareWorkflowPackageResponse) =>
				bob.post('/api/v1/library/install', {
					document_json: documentJson,
					plan_token: plan.plan_token,
					confirmation: { plan_digest: plan.plan_digest }
				});
			const owner = apiClient(revokerContext.request, NATIVE_PUBLICATIONS_PUBLISHER.apiKey);
			const moderation = (action: 'disable' | 'restore' | 'suspend' | 'unsuspend') => {
				const [{ status_version: snapshotVersion }] = d1<{ status_version: number }>(
					`SELECT status_version FROM workflow_publication WHERE snapshot_id=${sqlLiteral(snapshot)}`
				);
				const publisherVersion =
					d1<{ status_version: number }>(
						`SELECT status_version FROM workflow_publisher_status WHERE user_id=${sqlLiteral(NATIVE_PUBLICATIONS_PUBLISHER.id)}`
					)[0]?.status_version ?? 0;
				return revokerContext.request.post('/api/v1/host/workflow-moderation/decisions', {
					headers: { origin: BASE_URL },
					data: {
						request_id: crypto.randomUUID(),
						action,
						target: {
							snapshot_id: snapshot,
							...(mode === 'publisher' ? { publisher_id: NATIVE_PUBLICATIONS_PUBLISHER.id } : {})
						},
						reason: `Native ${mode} lifecycle`,
						...(mode === 'host' ? { expected_snapshot_version: snapshotVersion } : {}),
						...(mode === 'publisher' ? { expected_publisher_version: publisherVersion } : {})
					}
				});
			};
			const revoke = () =>
				mode === 'withdrawal'
					? owner.post(`/api/v1/publications/${snapshot}/withdraw`)
					: moderation(mode === 'host' ? 'disable' : 'suspend');
			const restore = () =>
				mode === 'withdrawal'
					? owner.post(`/api/v1/publications/${snapshot}/restore`)
					: moderation(mode === 'host' ? 'restore' : 'unsuspend');
			const expectRejectedWithoutObjects = async (
				response: Awaited<ReturnType<typeof install>>,
				before: Record<string, number>
			) => {
				expect(response.status()).toBe(409);
				expect(installedObjectCounts()).toEqual(before);
			};

			const refusedPlan = await prepareInstall();
			const before = installedObjectCounts();
			expect((await revoke()).status()).toBe(200);
			await expectRejectedWithoutObjects(await install(refusedPlan), before);
			expect((await restore()).status()).toBe(200);
			// Restoration changes the source version: an old, uncommitted plan
			// stays invalid and cannot become usable again after a lifecycle cycle.
			await expectRejectedWithoutObjects(await install(refusedPlan), before);

			const completedPlan = await prepareInstall();
			const receipt = await body<WorkflowPackageReceipt>(await install(completedPlan));
			expect((await revoke()).status()).toBe(200);
			expect(await body<WorkflowPackageReceipt>(await install(completedPlan))).toEqual(receipt);
			expect((await restore()).status()).toBe(200);

			const racedPlan = await prepareInstall();
			const beforeRace = installedObjectCounts();
			const [raced, revoked] = await Promise.all([install(racedPlan), revoke()]);
			expect(revoked.status()).toBe(200);
			expect([200, 409]).toContain(raced.status());
			if (raced.status() === 409) {
				expect(installedObjectCounts()).toEqual(beforeRace);
			} else {
				const racedReceipt = await body<WorkflowPackageReceipt>(raced);
				expect(await body<WorkflowPackageReceipt>(await install(racedPlan))).toEqual(racedReceipt);
			}
			expect((await restore()).status()).toBe(200);
			if (raced.status() === 409) {
				await expectRejectedWithoutObjects(await install(racedPlan), beforeRace);
				const recoveredPlan = await prepareInstall();
				expect((await install(recoveredPlan)).status()).toBe(200);
			}
		} finally {
			await revokerContext.close();
		}
	}

	for (const mode of ['withdrawal', 'host', 'publisher'] as const) {
		test(`${mode} revocation races a native install and completes a versioned lifecycle`, async ({
			request,
			browser
		}) => {
			test.setTimeout(60_000);
			await exerciseRevocation(mode, request, browser);
		});
	}

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

			// The idempotent candidate above occupies one slot. Fill through the
			// configured penultimate slot so the pair below races for the last one.
			for (let sequence = 1; sequence < PUBLICATION_DAILY_QUOTA - 1; sequence += 1) {
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

			const final = await Promise.all([
				prepare(request, PUBLICATION_DAILY_QUOTA - 1),
				prepare(request, PUBLICATION_DAILY_QUOTA)
			]);
			const raced = await Promise.all([
				request.post(`/api/v1/publications/${final[0].candidate_id}/publish`, {
					headers: {
						authorization: `Bearer ${CAROL.apiKey}`,
						'x-tines-e2e-publication-race': 'quota-barrier'
					},
					data: confirmation(final[0])
				}),
				second.post(`/api/v1/publications/${final[1].candidate_id}/publish`, {
					headers: {
						authorization: `Bearer ${CAROL.apiKey}`,
						'x-tines-e2e-publication-race': 'quota-barrier'
					},
					data: confirmation(final[1])
				})
			]);
			expect(raced.map((response) => response.status()).sort()).toEqual([200, 429]);
			const refused = raced.find((response) => response.status() === 429);
			expect(await refused!.json()).toMatchObject({
				error: { code: 'publication_quota_exceeded' }
			});
			expect(
				d1(
					`SELECT COUNT(*) AS n FROM workflow_publication WHERE user_id=${sqlLiteral(CAROL.id)} AND published_at IS NOT NULL`
				)
			).toEqual([{ n: PUBLICATION_DAILY_QUOTA }]);
			expect(
				d1(
					`SELECT COUNT(*) AS n FROM workflow_publication_event WHERE user_id=${sqlLiteral(CAROL.id)} AND action='published'`
				)
			).toEqual([{ n: PUBLICATION_DAILY_QUOTA }]);
		} finally {
			await second.dispose();
		}
	});
});
