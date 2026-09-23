import { expect, test } from './fixtures';
import { ALICE, RUNROW } from './constants.mjs';
import { d1, sqlLiteral } from './d1';
import { gotoHydrated, signIn } from './helpers';

test.describe('user-entered model rates', () => {
	test.beforeEach(async ({ context }) => signIn(context, ALICE.sessionToken));

	test('adds a rate with copy-from and removes it from settings', async ({ page }) => {
		const model = `e2e-user-model-${Date.now()}`;
		await gotoHydrated(page, '/agents');
		await page.getByRole('button', { name: 'Add rate', exact: true }).click();
		await expect(page.getByRole('heading', { name: `Add rate for a model` })).toBeVisible();
		await page.getByRole('textbox', { name: 'Model' }).fill(model);
		await page.locator('#rate-copy').selectOption('gpt-5.6-sol');
		await expect(page.locator('#rate-input')).toHaveValue('4');
		await page.getByRole('button', { name: 'Save rate', exact: true }).click();
		await expect(page.getByText(model, { exact: false })).toBeVisible();
		const row = page.locator('li').filter({ hasText: model });
		await row.getByRole('button', { name: 'Remove', exact: true }).click();
		await expect(row).toBeHidden();
	});
});

test.describe('entering a rate from an unpriced run', () => {
	test.beforeEach(async ({ context }) => signIn(context, ALICE.sessionToken));

	test('prices the run and shows its cost after saving', async ({ page }) => {
		const stamp = Date.now();
		const model = `e2e-basis-model-${stamp}`;
		const runnerName = `basis-rate-runner-${stamp}`;
		const issueNumber = 700_000 + (stamp % 100_000);
		const ids = {
			runner: `rnr_basis_${stamp}`,
			issue: `iss_basis_${stamp}`,
			run: `run_basis_${stamp}`
		};
		const createdAt = stamp - 60_000;
		const evidence = {
			version: 1,
			harness: 'codex',
			model,
			identity_source: 'launch_argument',
			usage_scope: 'thread_total',
			session_mode: 'cold',
			normalization: 'codex-jsonl-v1',
			raw_usage: {
				input_tokens: 1_000_000,
				cached_input_tokens: 0,
				cache_write_input_tokens: 0,
				output_tokens: 0
			},
			model_rerouted: false,
			measurement_status: 'complete',
			terminal_snapshots: 1
		};
		const usage = JSON.stringify({
			input_tokens: 1_000_000,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
			output_tokens: 0,
			cost_source: 'priced',
			pricing: {
				version: 1,
				evidence,
				evaluated_at: createdAt + 1,
				status: 'unpriced',
				reason: 'unsupported_model'
			}
		});
		d1(
			[
				`INSERT INTO runner (id, user_id, type, name, status, max_concurrent, max_run_minutes, default_tier, config, created_at, updated_at)
				 VALUES (${sqlLiteral(ids.runner)}, ${sqlLiteral(ALICE.id)}, 'local', ${sqlLiteral(runnerName)}, 'paused', 1, 30, 'balanced', '{}', ${createdAt}, ${createdAt});`,
				`INSERT INTO issue (id, project_id, number, title, description, workflow_id, state_id, created_at, updated_at)
				 VALUES (${sqlLiteral(ids.issue)}, ${sqlLiteral(RUNROW.projectId)}, ${issueNumber}, 'Unpriced unlisted model run', '', 'wf_standard', 'wfs_std_open', ${createdAt}, ${createdAt});`,
				`INSERT INTO agent_run (id, user_id, issue_id, runner_id, status, outcome, tier, model, usage, state_id_at_start, state_id_at_end, log, created_at, started_at, ended_at)
				 VALUES (${sqlLiteral(ids.run)}, ${sqlLiteral(ALICE.id)}, ${sqlLiteral(ids.issue)}, ${sqlLiteral(ids.runner)}, 'completed', 'advanced', 'balanced', ${sqlLiteral(model)}, ${sqlLiteral(usage)}, 'wfs_std_open', 'wfs_std_open', 'log', ${createdAt}, ${createdAt}, ${createdAt + 1});`
			].join('\n')
		);

		await gotoHydrated(page, `/issues/${encodeURIComponent(RUNROW.projectName)}/${issueNumber}`);
		const row = page.locator('li:not([inert])', { hasText: runnerName });
		await row.getByRole('button', { name: 'Unpriced', exact: true }).click();
		const evidenceDialog = page.getByRole('dialog', { name: 'Cost evidence' });
		await evidenceDialog.getByRole('button', { name: `Enter a rate for ${model}` }).click();
		await page.locator('#rate-copy').selectOption('gpt-5.6-sol');
		await expect(page.locator('#rate-input')).toHaveValue('4');
		await page.getByRole('button', { name: 'Save rate', exact: true }).click();

		// 1M input tokens at the copied $4 / 1M input rate.
		await expect(row.getByRole('button', { name: '$4.00 Estimated', exact: true })).toBeVisible();
	});
});
