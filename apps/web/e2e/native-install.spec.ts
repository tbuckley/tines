import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import {
	type PrepareWorkflowPackageResponse,
	type WorkflowPackageDocument,
	type WorkflowPackageReceipt,
	withLibraryDocumentDigest
} from '@tines/shared';
import { inheritedPackage } from '../../../packages/shared/src/library/fixtures';
import { ALICE } from './constants.mjs';
import { apiClient, body, errorBody, runId } from './helpers';

/**
 * Native-D1 acceptance for the workflow installer. Unlike the fast service
 * fixtures, these requests reach the built Worker and the assertions query
 * the isolated Wrangler database produced by e2e/server.sh.
 */
function d1(sql: string): Array<Record<string, unknown>> {
	const output = execFileSync(
		'pnpm',
		[
			'exec',
			'wrangler',
			'd1',
			'execute',
			'tines',
			'--local',
			'--persist-to',
			'.wrangler-e2e',
			'--command',
			sql,
			'--json'
		],
		{ encoding: 'utf8' }
	);
	const result = JSON.parse(output) as Array<{ results?: Array<Record<string, unknown>> }>;
	return result[0]?.results ?? [];
}

async function seal(document: WorkflowPackageDocument) {
	return JSON.stringify(await withLibraryDocumentDigest(document));
}

async function prepare(
	client: ReturnType<typeof apiClient>,
	documentJson: string,
	choices: Record<string, unknown>
) {
	return body<PrepareWorkflowPackageResponse>(
		await client.post('/api/v1/library/prepare', { document_json: documentJson, choices })
	);
}

test.describe.serial('native D1 workflow install gate', () => {
	test('commits the exact 800-statement boundary once and rejects 801 before writes', async ({
		request
	}) => {
		test.setTimeout(120_000);
		const client = apiClient(request, ALICE.apiKey);
		const document = inheritedPackage();
		const source = document.context[0];
		if (source.kind !== 'prompt') throw new Error('expected prompt fixture');
		for (let i = 0; i < 390; i++)
			document.context.push({
				...source,
				id: `native-context-${runId}-${i}`,
				name: `native-${runId}-${i}`
			});
		const documentJson = await seal(document);
		const label = `native-boundary-${runId}`;
		const plan = await prepare(client, documentJson, {
			inputs: { 'input:1': { mode: 'create', name: label, color: 'blue' } },
			workflow_names: Object.fromEntries(
				document.workflows.map((workflow, index) => [
					workflow.id,
					`Native boundary ${runId} ${index}`
				])
			)
		});
		expect(plan.budget.statements).toBe(800);
		const receipt = await body<WorkflowPackageReceipt>(
			await client.post('/api/v1/library/install', {
				document_json: documentJson,
				plan_token: plan.plan_token,
				confirmation: { plan_digest: plan.plan_digest }
			})
		);
		expect(receipt.id).toBe(plan.plan_id);
		expect(d1(`SELECT COUNT(*) AS n FROM library_install WHERE id='${plan.plan_id}'`)).toEqual([
			{ n: 1 }
		]);
		expect(
			d1(`SELECT COUNT(*) AS n FROM context_item WHERE name LIKE 'native-${runId}-%'`)
		).toEqual([{ n: 390 }]);

		const over = structuredClone(document);
		over.context.push({
			...source,
			id: `native-context-${runId}-over`,
			name: `native-${runId}-over`
		});
		const rejected = await client.post('/api/v1/library/prepare', {
			document_json: await seal(over),
			choices: {
				inputs: {
					'input:1': { mode: 'create', name: `native-over-${runId}`, color: 'blue' }
				}
			}
		});
		expect(rejected.status()).toBe(422);
		expect(await errorBody(rejected)).toMatchObject({
			error: { code: 'package_too_large', details: { field: 'statements', actual: 802 } }
		});
		expect(d1(`SELECT COUNT(*) AS n FROM label WHERE name='native-over-${runId}'`)).toEqual([
			{ n: 0 }
		]);
	});

	test('rolls back every object, pointer, and event family after native trigger failures', async ({
		request
	}) => {
		test.setTimeout(120_000);
		const client = apiClient(request, ALICE.apiKey);
		const failures = [
			['workflow', 'INSERT'],
			['workflow_state', 'INSERT'],
			['workflow_transition', 'INSERT'],
			['context_item', 'INSERT'],
			['context_item_file', 'INSERT'],
			['workflow_state', 'UPDATE'],
			['label', 'INSERT'],
			['event', 'INSERT']
		] as const;
		for (const [index, [table, operation]] of failures.entries()) {
			const marker = `nr-${runId}-${index}`;
			const documentJson = await seal(inheritedPackage());
			const plan = await prepare(client, documentJson, {
				inputs: { 'input:1': { mode: 'create', name: marker, color: 'red' } },
				workflow_names: {
					'workflow:1': `${marker} main`,
					'workflow:2': `${marker} dependency`
				}
			});
			d1(`CREATE TRIGGER native_install_failure BEFORE ${operation} ON ${table}
				BEGIN SELECT RAISE(ABORT, 'native install injection'); END`);
			try {
				const failed = await client.post('/api/v1/library/install', {
					document_json: documentJson,
					plan_token: plan.plan_token,
					confirmation: { plan_digest: plan.plan_digest }
				});
				expect(failed.status(), `${operation} ${table}`).toBeGreaterThanOrEqual(500);
			} finally {
				d1('DROP TRIGGER IF EXISTS native_install_failure');
			}
			expect(d1(`SELECT COUNT(*) AS n FROM library_install WHERE id='${plan.plan_id}'`)).toEqual([
				{ n: 0 }
			]);
			expect(d1(`SELECT COUNT(*) AS n FROM workflow WHERE name LIKE '${marker}%'`)).toEqual([
				{ n: 0 }
			]);
			expect(d1(`SELECT COUNT(*) AS n FROM label WHERE name='${marker}'`)).toEqual([{ n: 0 }]);
		}
	});

	test('makes concurrent retries one-copy and recovers the durable receipt', async ({
		request
	}) => {
		const client = apiClient(request, ALICE.apiKey);
		const marker = `native-retry-${runId}`;
		const documentJson = await seal(inheritedPackage());
		const plan = await prepare(client, documentJson, {
			inputs: { 'input:1': { mode: 'create', name: marker, color: 'green' } },
			workflow_names: {
				'workflow:1': `${marker} main`,
				'workflow:2': `${marker} dependency`
			}
		});
		const install = () =>
			client.post('/api/v1/library/install', {
				document_json: documentJson,
				plan_token: plan.plan_token,
				confirmation: { plan_digest: plan.plan_digest }
			});
		// Simulate a dropped client response by discarding it and using only durable recovery.
		const dropped = await install();
		expect(dropped.status()).toBe(200);
		const recovered = await body<WorkflowPackageReceipt>(
			await client.get(`/api/v1/library/installs/${plan.plan_id}`)
		);
		const responses = await Promise.all([install(), install()]);
		const receipts = await Promise.all(
			responses.map((response) => body<WorkflowPackageReceipt>(response))
		);
		expect(recovered).toEqual(receipts[0]);
		expect(receipts[1]).toEqual(receipts[0]);
		expect(await body(await client.get(`/api/v1/library/installs/${plan.plan_id}`))).toEqual(
			receipts[0]
		);
		expect(d1(`SELECT COUNT(*) AS n FROM library_install WHERE id='${plan.plan_id}'`)).toEqual([
			{ n: 1 }
		]);
		expect(d1(`SELECT COUNT(*) AS n FROM workflow WHERE name LIKE '${marker}%'`)).toEqual([
			{ n: 2 }
		]);
	});
});
