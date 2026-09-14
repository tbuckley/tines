import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './fixtures';
import type {
	PrepareWorkflowPackageResponse,
	WorkflowPackageDocument,
	WorkflowPackageReceipt
} from '@tines/shared';
import { ALICE, BASE_URL, RUNROW } from './constants.mjs';

const CLI_DIR = fileURLToPath(new URL('../../../packages/cli', import.meta.url));
const TSX = join(CLI_DIR, 'node_modules', '.bin', 'tsx');
const CLI = join(CLI_DIR, 'src', 'index.ts');

function cli(args: string[], apiKey = ALICE.apiKey): string {
	return execFileSync(TSX, [CLI, ...args, '--url', BASE_URL, '--api-key', apiKey], {
		encoding: 'utf8',
		env: {
			...process.env,
			// This intentionally disagrees with the isolated worker. Every command
			// must remain pinned by its explicit --url and never reach production.
			TINES_API_URL: 'https://ambient-must-not-be-used.invalid'
		}
	});
}

test('CLI export, preview, install, and same-plan receipt retry use the real local API', () => {
	const directory = mkdtempSync(join(tmpdir(), 'tines-cli-real-api-'));
	const packagePath = join(directory, 'package.json');
	const choicesPath = join(directory, 'choices.json');
	const planPath = join(directory, 'plan.json');

	const exported = cli(['workflows', 'export', 'wf_standard']);
	const document = JSON.parse(exported) as WorkflowPackageDocument;
	expect(document.profile).toBe('workflow');
	expect(document.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
	writeFileSync(packagePath, exported);
	writeFileSync(
		choicesPath,
		JSON.stringify({
			workflow_names: Object.fromEntries(
				document.workflows.map((workflow, index) => [
					workflow.id,
					`CLI real API ${Date.now()} ${index}`
				])
			)
		})
	);

	const plan = JSON.parse(
		cli([
			'workflows',
			'preview',
			packagePath,
			'--choices',
			choicesPath,
			'--plan-out',
			planPath,
			'--json'
		])
	) as PrepareWorkflowPackageResponse;
	expect(plan.document_digest).toBe(document.digest);
	expect(plan.operations.some((operation) => operation.action === 'create')).toBe(true);
	expect(
		new Set(
			plan.operations.map(
				(operation) => `${operation.action}:${operation.kind}:${operation.local_id}`
			)
		).size
	).toBe(plan.operations.length);

	const installArgs = [
		'workflows',
		'install',
		packagePath,
		'--plan',
		planPath,
		'--confirm',
		plan.plan_digest,
		'--json'
	];
	const receipt = JSON.parse(cli(installArgs)) as WorkflowPackageReceipt;
	const retry = JSON.parse(cli(installArgs)) as WorkflowPackageReceipt;
	expect(retry).toEqual(receipt);
	expect(receipt.plan_digest).toBe(plan.plan_digest);
	expect(receipt.objects.some((object) => object.relationship === 'main')).toBe(true);

	const runPlanPath = join(directory, 'run-plan.json');
	const runChoicesPath = join(directory, 'run-choices.json');
	writeFileSync(
		runChoicesPath,
		JSON.stringify({
			workflow_names: Object.fromEntries(
				document.workflows.map((workflow, index) => [
					workflow.id,
					`CLI denied run ${Date.now()} ${index}`
				])
			)
		})
	);
	const runPlan = JSON.parse(
		cli(
			[
				'workflows',
				'preview',
				packagePath,
				'--choices',
				runChoicesPath,
				'--plan-out',
				runPlanPath,
				'--json'
			],
			RUNROW.runKey
		)
	) as PrepareWorkflowPackageResponse;
	expect(() =>
		cli(
			[
				'workflows',
				'install',
				packagePath,
				'--plan',
				runPlanPath,
				'--confirm',
				runPlan.plan_digest,
				'--json'
			],
			RUNROW.runKey
		)
	).toThrow(/run_key_forbidden/);
});
