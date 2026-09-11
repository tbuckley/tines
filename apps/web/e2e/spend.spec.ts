import { expect, test } from '@playwright/test';
import { ALICE } from './constants.mjs';
import { gotoHydrated, resetFocus, signIn } from './helpers';

const aggregate = {
	finalized_run_count: 2,
	priced_run_count: 2,
	unpriced_run_count: 0,
	unreported_run_count: 0,
	coverage: 'complete',
	cost_usd: 1.23,
	cost_usd_exact: '1.23',
	portions: {
		provider: { priced_run_count: 1, cost_usd: 1, cost_usd_exact: '1' },
		calculated: { priced_run_count: 1, cost_usd: 0.23, cost_usd_exact: '0.23' },
		unknown_source: { priced_run_count: 0, cost_usd: 0, cost_usd_exact: '0' }
	},
	tokens: Object.fromEntries(
		['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'].map((key) => [
			key,
			{ value: 10, reported_runs: 2, invalid_runs: 0 }
		])
	),
	diagnostics: {
		legacy_null: 0,
		explicit_none: 0,
		malformed: 0,
		invalid_cost: 0,
		invalid_token_fields: 0,
		partial_token_fields: 0,
		unknown_or_inconsistent_source: 0,
		invalid_or_missing_calculated_basis: 0
	},
	pricing_reasons: {},
	rate_portions: [
		{
			priced_run_count: 1,
			cost_usd: 0.23,
			cost_usd_exact: '0.23',
			basis: { model: 'gpt-5.6-sol' },
			rate_selected_at_min: 1,
			rate_selected_at_max: 1
		}
	],
	distribution: {
		subset: 'priced_finalized_runs',
		sample_count: 2,
		missing_price_count: 0,
		mean_cost_usd: 0.615,
		median_cost_usd: 0.23,
		p95_cost_usd: 1,
		max_cost_usd: 1,
		percentile_rule: 'nearest_rank',
		low_sample: true
	}
};

const report = {
	from: Date.parse('2026-09-01T00:00:00Z'),
	to: Date.parse('2026-09-08T00:00:00Z'),
	generated_at: Date.parse('2026-09-08T00:00:00Z'),
	timezone: 'UTC',
	timezone_source: 'utc_fallback',
	accounting_basis: 'finalized_by_ended_at_v1',
	attribution_basis: 'current_issue_project_start_state_workflow_v1',
	filters: {},
	by: 'workflow',
	scope_total: aggregate,
	matching_total: aggregate,
	groups: [{ key: 'workflow', dimension: { id: 'wf', name: 'Engineering' }, aggregate }],
	workflow_options: [{ id: 'wf', name: 'Engineering' }],
	pending: {
		scope_count: 1,
		matching_count: 1,
		basis: 'created_before_cutoff_not_ended_before_cutoff',
		unapplied_filters: []
	},
	evidence_filters: {
		from: '2026-09-01T00:00:00.000Z',
		to: '2026-09-08T00:00:00.000Z',
		population: 'finalized'
	}
};

test.describe('Agents Spend', () => {
	test.beforeEach(async ({ context, request }) => {
		await signIn(context, ALICE.sessionToken);
		await resetFocus(request);
	});

	test('loads, preserves prior data on refresh failure, and provides a modal estimate dialog', async ({
		page
	}) => {
		let requests = 0;
		await page.route('**/api/v1/usage?**', async (route) => {
			requests++;
			if (requests === 1) await route.fulfill({ json: report });
			else await route.fulfill({ status: 500, json: { error: { message: 'temporary failure' } } });
		});
		await gotoHydrated(page, '/agents?agents_view=spend');
		await expect(page.getByText('Project total · all workflows')).toBeVisible();
		await expect(page.getByRole('button', { name: /Engineering 2 finalized/ })).toBeVisible();
		await page.getByRole('button', { name: 'Refresh' }).click();
		await expect(page.getByText(/Refresh failed · showing previous report/)).toBeVisible();
		await expect(page.getByRole('button', { name: /Engineering 2 finalized/ })).toBeVisible();

		const trigger = page.getByRole('button', { name: 'Estimated' });
		await trigger.focus();
		await trigger.press('Enter');
		const dialog = page.getByRole('dialog', { name: 'Estimate basis' });
		await expect(dialog).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		await expect(trigger).toBeFocused();
	});

	test('restores custom bounds from the URL without fetching an empty range', async ({ page }) => {
		await page.route('**/api/v1/usage?**', (route) => route.fulfill({ json: report }));
		await gotoHydrated(
			page,
			'/agents?agents_view=spend&spend_window=custom&spend_from=2026-09-01&spend_to=2026-09-08'
		);
		await expect(page.getByLabel('From')).toHaveValue('2026-09-01');
		await expect(page.getByRole('textbox', { name: 'To', exact: true })).toHaveValue('2026-09-08');
	});
});
