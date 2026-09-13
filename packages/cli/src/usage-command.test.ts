import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

it('ships usage JSON and forwards workflow narrowing to the API', async () => {
	vi.stubEnv('TINES_API_URL', 'https://usage.example.test');
	vi.stubEnv('TINES_API_KEY', 'test-key');
	const report = {
		from: 1,
		to: 2,
		generated_at: 2,
		timezone: 'UTC',
		timezone_source: 'utc_fallback',
		accounting_basis: 'finalized_by_ended_at_v1',
		attribution_basis: 'current_issue_project_start_state_workflow_v1',
		filters: { workflow: 'unknown' },
		by: 'workflow',
		scope_total: {},
		matching_total: {},
		groups: [],
		workflow_options: [],
		pending: { scope_count: 0, matching_count: 0, unapplied_filters: [] },
		evidence_filters: {}
	};
	const fetchMock = vi.fn(
		async (_input: string | URL | Request) =>
			new Response(JSON.stringify(report), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
	);
	vi.stubGlobal('fetch', fetchMock);
	const log = vi.spyOn(console, 'log').mockImplementation((..._args: unknown[]) => undefined);
	vi.resetModules();
	const { program } = await import('./program.js');
	await program.parseAsync(['node', 'tines', 'usage', '--workflow', 'unknown', '--json']);

	expect(fetchMock).toHaveBeenCalledOnce();
	expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v1/usage?');
	expect(String(fetchMock.mock.calls[0][0])).toContain('workflow=unknown');
	expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual(report);
});

it('forwards retained opaque identities without metadata lookups', async () => {
	vi.stubEnv('TINES_API_URL', 'https://usage.example.test');
	vi.stubEnv('TINES_API_KEY', 'test-key');
	const report = {
		from: 1,
		to: 2,
		generated_at: 2,
		timezone: 'UTC',
		timezone_source: 'utc_fallback',
		accounting_basis: 'finalized_by_ended_at_v1',
		attribution_basis: 'current_issue_project_start_state_workflow_v1',
		filters: {},
		by: 'workflow',
		scope_total: {},
		matching_total: {},
		groups: [],
		workflow_options: [],
		pending: { scope_count: 0, matching_count: 0, unapplied_filters: [] },
		evidence_filters: {}
	};
	const fetchMock = vi.fn(async (_input: string | URL | Request) =>
		Promise.resolve(
			new Response(JSON.stringify(report), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		)
	);
	vi.stubGlobal('fetch', fetchMock);
	vi.spyOn(console, 'log').mockImplementation((..._args: unknown[]) => undefined);
	vi.resetModules();
	const { program } = await import('./program.js');
	await program.parseAsync([
		'node',
		'tines',
		'usage',
		'--project',
		'prj_deleted123',
		'--workflow',
		'wf_deleted123',
		'--runner',
		'rnr_deleted123',
		'--json'
	]);

	expect(fetchMock).toHaveBeenCalledOnce();
	const url = String(fetchMock.mock.calls[0][0]);
	expect(url).toContain('project=prj_deleted123');
	expect(url).toContain('workflow=wf_deleted123');
	expect(url).toContain('runner=rnr_deleted123');
});

it('exports all frozen evidence pages without summing page totals', async () => {
	vi.stubEnv('TINES_API_URL', 'https://usage.example.test');
	vi.stubEnv('TINES_API_KEY', 'test-key');
	const aggregate = { cost_usd: 0.3, finalized_run_count: 2 };
	const pages = [
		{
			items: [
				{
					issue_id: 'iss_a',
					issue_ref: null,
					aggregate,
					attempt_count: 1,
					pending_count: 0,
					fully_priced: true,
					latest_at: 2
				}
			],
			next_cursor: 'next',
			previous_cursor: null,
			total_count: 2,
			scope: 'frozen',
			kind: 'issues',
			population: 'finalized',
			sort: 'cost',
			direction: 'desc',
			matching_total: aggregate,
			attempt_count: 2,
			pending_count: 0
		},
		{
			items: [
				{
					issue_id: 'iss_b',
					issue_ref: null,
					aggregate,
					attempt_count: 1,
					pending_count: 0,
					fully_priced: true,
					latest_at: 1
				}
			],
			next_cursor: null,
			previous_cursor: 'previous',
			total_count: 2,
			scope: 'frozen',
			kind: 'issues',
			population: 'finalized',
			sort: 'cost',
			direction: 'desc',
			matching_total: aggregate,
			attempt_count: 2,
			pending_count: 0
		}
	];
	const fetchMock = vi.fn(
		async (_input: string | URL | Request) =>
			new Response(JSON.stringify(pages.shift()), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
	);
	vi.stubGlobal('fetch', fetchMock);
	const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
	vi.resetModules();
	const { program } = await import('./program.js');
	await program.parseAsync([
		'node',
		'tines',
		'usage',
		'--scope',
		'frozen',
		'--evidence',
		'issues',
		'--all-pages',
		'--json'
	]);
	expect(fetchMock).toHaveBeenCalledTimes(2);
	expect(String(fetchMock.mock.calls[1][0])).toContain('cursor=next');
	const output = JSON.parse(String(log.mock.calls[0][0]));
	expect(output.items.map((item: { issue_id: string }) => item.issue_id)).toEqual([
		'iss_a',
		'iss_b'
	]);
	expect(output.matching_total).toEqual(aggregate);
});

it('rejects explicit grouping with issue lifetime before a request', async () => {
	vi.stubEnv('TINES_API_URL', 'https://usage.example.test');
	const fetchMock = vi.fn();
	vi.stubGlobal('fetch', fetchMock);
	vi.resetModules();
	const { program } = await import('./program.js');
	await expect(
		program.parseAsync(['node', 'tines', 'usage', '--issue', 'iss_retained', '--by', 'workflow'])
	).rejects.toThrow('--issue cannot be combined');
	expect(fetchMock).not.toHaveBeenCalled();
});

it('prints complete aggregate diagnostics and historical rate references', async () => {
	vi.stubEnv('TINES_API_URL', 'https://usage.example.test');
	vi.stubEnv('TINES_API_KEY', 'test-key');
	const aggregate = {
		finalized_run_count: 2,
		priced_run_count: 1,
		unpriced_run_count: 1,
		unreported_run_count: 0,
		coverage: 'partial',
		cost_usd: 0.25,
		cost_usd_exact: '0.25',
		portions: {
			provider: { cost_usd: 0, cost_usd_exact: '0', priced_run_count: 0 },
			calculated: { cost_usd: 0.25, cost_usd_exact: '0.25', priced_run_count: 1 },
			unknown_source: { cost_usd: 0, cost_usd_exact: '0', priced_run_count: 0 }
		},
		tokens: {
			input_tokens: { value: 10, reported_runs: 1, invalid_runs: 0 },
			output_tokens: { value: 2, reported_runs: 1, invalid_runs: 0 },
			cache_read_tokens: { value: 0, reported_runs: 1, invalid_runs: 0 },
			cache_write_tokens: { value: 0, reported_runs: 1, invalid_runs: 0 }
		},
		diagnostics: { malformed: 1 },
		pricing_reasons: { missing_rate: 1 },
		rate_portions: [
			{
				basis: {
					calculation_version: 'tokens-times-usd-per-million-v1',
					provider: 'openai',
					model: 'gpt-test',
					model_identity: 'requested_launch_no_observed_reroute',
					usage_scope: 'attempt',
					plan: 'api_standard',
					context_band: 'short',
					rate_id: 'rate-2026',
					rate_version: 3,
					rate_adopted_at: 1,
					rate_valid_to: null,
					source_url: 'https://example.test/rates',
					source_checked_at: '2026-01-01',
					source_effective_at: '2026-01-01',
					unit_tokens: 1_000_000,
					rates: {
						input_tokens: '1',
						output_tokens: '2',
						cache_read_tokens: '0.1',
						cache_write_tokens: null
					}
				},
				cost_usd: 0.25,
				cost_usd_exact: '0.25',
				priced_run_count: 1,
				rate_selected_at_min: 2,
				rate_selected_at_max: 3
			}
		],
		distribution: {
			subset: 'priced_finalized_runs',
			sample_count: 1,
			missing_price_count: 1,
			mean_cost_usd: 0.25,
			median_cost_usd: 0.25,
			p95_cost_usd: 0.25,
			max_cost_usd: 0.25,
			percentile_rule: 'nearest_rank',
			low_sample: true
		}
	};
	const report = {
		from: 1,
		to: 2,
		generated_at: 2,
		timezone: 'UTC',
		timezone_source: 'utc_fallback',
		accounting_basis: 'finalized_by_ended_at_v1',
		attribution_basis: 'current_issue_project_start_state_workflow_v1',
		filters: {},
		by: 'workflow',
		scope_total: aggregate,
		matching_total: aggregate,
		groups: [],
		workflow_options: [],
		pending: { scope_count: 0, matching_count: 0, unapplied_filters: [] },
		evidence_filters: {}
	};
	vi.stubGlobal(
		'fetch',
		vi.fn(async () =>
			Promise.resolve(
				new Response(JSON.stringify(report), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
			)
		)
	);
	const log = vi.spyOn(console, 'log').mockImplementation((..._args: unknown[]) => undefined);
	vi.resetModules();
	const { program } = await import('./program.js');
	await program.parseAsync(['node', 'tines', 'usage']);
	const text = log.mock.calls.map(([line]) => String(line)).join('\n');
	expect(text).toContain('Scope diagnostics: malformed=1');
	expect(text).toContain('Matching pricing reasons: missing_rate=1');
	expect(text).toContain('id rate-2026 · version 3 · model gpt-test');
	expect(text).toContain('source https://example.test/rates');
	expect(text).toContain('selected 1970-01-01T00:00:00.002Z — 1970-01-01T00:00:00.003Z');
});

const rateDateFields = [null, 'rate_adopted_at', 'rate_valid_to', 'rate_selected_at'] as const;
it.each(rateDateFields)('prints rate evidence with malformed date %s', async (invalidField) => {
	vi.stubEnv('TINES_API_URL', 'https://usage.example.test');
	vi.stubEnv('TINES_API_KEY', 'test-key');
	const response = {
		items: [
			{
				id: 'arun_evidence',
				issue_id: 'iss_1',
				issue_ref: null,
				runner_id: 'rnr_deleted',
				runner_name: 'Unknown/deleted runner (rnr_deleted)',
				status: 'completed',
				outcome: 'advanced',
				tier: 'balanced',
				model: 'gpt-test',
				usage: { cost_usd: 0.25, cost_source: 'priced' },
				state_id_at_start: 'wfs_deleted',
				state_at_start_name: null,
				state_id_at_end: null,
				state_at_end_name: null,
				provider_session_id: null,
				provider_url: null,
				turn_count: 1,
				conversation_turn_count: 1,
				resumed_from_run_id: null,
				resume_expires_at: null,
				resume_fallback_reason: null,
				error: null,
				created_at: 1,
				started_at: 1,
				ended_at: 2,
				usage_dimensions: Object.fromEntries(
					['project', 'workflow', 'state', 'outcome', 'runner', 'tier'].map((name) => [
						name,
						{ id: `${name}_id`, name: `${name} label` }
					])
				),
				usage_accounting: {
					status: 'priced',
					cost: 0.25,
					cost_exact: '0.25',
					source: 'calculated',
					basis: {
						calculation_version: 'tokens-times-usd-per-million-v1',
						provider: 'openai',
						model: 'gpt-test',
						model_identity: 'requested_launch_no_observed_reroute',
						usage_scope: 'attempt',
						plan: 'api_standard',
						context_band: 'short',
						rate_id: 'rate-evidence',
						rate_version: 4,
						rate_adopted_at: 1,
						rate_valid_to: null,
						rate_selected_at: 2,
						source_url: 'https://example.test/evidence',
						source_checked_at: '2026-01-01',
						source_effective_at: null,
						unit_tokens: 1_000_000,
						rates: {
							input_tokens: '1',
							output_tokens: '2',
							cache_read_tokens: '0.1',
							cache_write_tokens: null
						},
						cost_usd_exact: '0.25'
					},
					tokens: {},
					invalid_tokens: [],
					diagnostics: { invalid_token_fields: 1 },
					pricing_reason: null
				}
			}
		],
		next_cursor: null
	};
	if (invalidField)
		(response.items[0].usage_accounting.basis as Record<string, unknown>)[invalidField] = 1e20;
	vi.stubGlobal(
		'fetch',
		vi.fn(async () =>
			Promise.resolve(
				new Response(JSON.stringify(response), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
			)
		)
	);
	const log = vi.spyOn(console, 'log').mockImplementation((..._args: unknown[]) => undefined);
	vi.resetModules();
	const { program } = await import('./program.js');
	await program.parseAsync([
		'node',
		'tines',
		'runs',
		'list',
		'--population',
		'finalized',
		'--from',
		'2026-01-01T00:00:00Z',
		'--to',
		'2026-01-02T00:00:00Z'
	]);
	const text = log.mock.calls.map(([line]) => String(line)).join('\n');
	if (invalidField)
		expect(text).toContain(
			`${invalidField === 'rate_adopted_at' ? 'adopted' : invalidField === 'rate_valid_to' ? 'valid to' : 'selected'} unavailable`
		);
	expect(text).toContain('project=project label [project_id]');
	expect(text).toContain('exact cost 0.25');
	expect(text).toContain('invalid_token_fields=1');
	expect(text).toContain('id rate-evidence · version 4');
	expect(text).toContain('effective unavailable');
	if (!invalidField) {
		expect(text).toContain('adopted 1970-01-01T00:00:00.001Z');
		expect(text).toContain('selected 1970-01-01T00:00:00.002Z');
	}
});
