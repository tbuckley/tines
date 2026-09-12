// Independent acceptance manifest: no production classifier, resolver, or accumulator imports.
// Orphan references below simulate historical storage corruption; ordinary deletes may cascade.
import assert from 'node:assert/strict';
export const user = 'u_usage_mixed';
export const foreignUser = 'u_usage_foreign';
export const from = 1700000000000;
export const to = from + 100000;
export const bounds = { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
const tokenNames = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'];
const diagnosticNames = [
	'legacy_null',
	'explicit_none',
	'malformed',
	'invalid_cost',
	'invalid_token_fields',
	'partial_token_fields',
	'unknown_or_inconsistent_source',
	'invalid_or_missing_calculated_basis'
];
const basis = {
	calculation_version: 'tokens-times-usd-per-million-v1',
	rate_id: 'mixed-rate',
	rate_version: 'v7',
	model: 'fixture-model',
	plan: 'api',
	context_band: 'standard',
	source_url: 'https://example.test/rates',
	source_checked_at: '2023-11-01',
	source_effective_at: '2023-10-01',
	rate_adopted_at: from - 1000,
	rate_valid_to: null,
	rate_selected_at: from + 1,
	unit_tokens: 1000000,
	rates: {
		input_tokens: '2',
		output_tokens: '8',
		cache_read_tokens: '0.2',
		cache_write_tokens: null
	},
	cost_usd_exact: '0.25'
};
// Each tuple explicitly declares the expected accounting; never classify the raw fixture.
/** @type {Array<[unknown, string, string|null, string|null, Array<number|null>, Record<string,number>, string[], any, string|null]>} */
const kinds = [
	[
		{
			cost_usd: 0.1,
			cost_source: 'provider',
			input_tokens: 10,
			output_tokens: 2,
			cache_read_tokens: 3,
			cache_write_tokens: 0
		},
		'priced',
		'0.1',
		'provider',
		[10, 2, 3, 0],
		{},
		[],
		null,
		null
	],
	[{ cost_usd: 0, cost_source: 'provider' }, 'priced', '0', 'provider', [], {}, [], null, null],
	[
		{
			cost_usd: 0.25,
			cost_source: 'priced',
			input_tokens: 100,
			pricing: { status: 'calculated', basis }
		},
		'priced',
		'0.25',
		'calculated',
		[100],
		{ partial_token_fields: 1 },
		[],
		basis,
		null
	],
	[{ cost_usd: 0.03 }, 'priced', '0.03', 'unknown_source', [], {}, [], null, null],
	[
		{ input_tokens: 7, pricing: { status: 'unpriced', reason: 'model_unknown' } },
		'unpriced',
		null,
		null,
		[7],
		{ partial_token_fields: 1 },
		[],
		null,
		'model_unknown'
	],
	[null, 'unreported', null, null, [], { legacy_null: 1 }, [], null, null],
	[{ cost_source: 'none' }, 'unreported', null, null, [], { explicit_none: 1 }, [], null, null],
	['{broken', 'unreported', null, null, [], { malformed: 1 }, [], null, null],
	[
		{ cost_usd: -1, input_tokens: 'bad', output_tokens: 4, cache_read_tokens: null },
		'unpriced',
		null,
		null,
		[null, 4],
		{ invalid_cost: 1, invalid_token_fields: 2, partial_token_fields: 1 },
		['input_tokens', 'cache_read_tokens'],
		null,
		null
	],
	[
		{ cost_usd: 0.02, cost_source: 'priced' },
		'priced',
		'0.02',
		'calculated',
		[],
		{ invalid_or_missing_calculated_basis: 1 },
		[],
		null,
		null
	],
	[
		{ cost_usd: 0.04, cost_source: 'none' },
		'priced',
		'0.04',
		'unknown_source',
		[],
		{ explicit_none: 1, unknown_or_inconsistent_source: 1 },
		[],
		null,
		null
	],
	[
		{
			cost_usd: 0.25,
			cost_source: 'priced',
			pricing: {
				status: 'calculated',
				basis: {
					calculation_version: basis.calculation_version,
					rate_id: 'partial-rate',
					cost_usd_exact: '0.25'
				}
			}
		},
		'priced',
		'0.25',
		'calculated',
		[],
		{},
		[],
		{
			calculation_version: basis.calculation_version,
			rate_id: 'partial-rate',
			cost_usd_exact: '0.25'
		},
		null
	]
];
/** @param {string|null} id @param {string} name */
const dim = (id, name) => ({ id, name });
const structures = [
	{
		issue: 'iss_mixed_a',
		project: dim('prj_mixeda', 'Mixed active'),
		workflow: dim('wf_deletedstart', 'Unknown/deleted workflow (wf_deletedstart)'),
		state: dim('wfs_deletedstart', 'Unknown/deleted state (wfs_deletedstart)')
	},

	{
		issue: 'iss_mixed_deletedworkflow',
		project: dim('prj_mixeda', 'Mixed active'),
		workflow: dim('wf_deleted', 'Unknown/deleted workflow (wf_deleted)'),
		state: dim('wfs_deletedworkflow', 'Unknown/deleted state (wfs_deletedworkflow)')
	},

	{
		issue: 'iss_mixed_a',
		project: dim('prj_mixeda', 'Mixed active'),
		workflow: dim('wf_standard', 'Standard'),
		state: dim('wfs_std_open', 'Open')
	},
	{
		issue: 'iss_mixed_b',
		project: dim('prj_mixedb', 'Mixed archived'),
		workflow: dim('wf_mixed', 'Mixed workflow'),
		state: dim('wfs_mixed', 'Mixed state')
	},
	{
		issue: 'iss_mixed_a',
		project: dim('prj_mixeda', 'Mixed active'),
		workflow: dim('wf_mixed', 'Mixed workflow'),
		state: dim('wfs_mixed', 'Mixed state')
	},
	{
		issue: 'iss_mixed_b',
		project: dim('prj_mixedb', 'Mixed archived'),
		workflow: dim('wf_mixed', 'Mixed workflow'),
		state: dim('wfs_deleted_a', 'Unknown/deleted state (wfs_deleted_a)')
	},
	{
		issue: 'iss_mixed_orphan',
		project: dim('prj_deleteda', 'Unknown/deleted project (prj_deleteda)'),
		workflow: dim('wf_standard', 'Standard'),
		state: dim('wfs_deleted_b', 'Unknown/deleted state (wfs_deleted_b)')
	},
	{
		issue: 'iss_missing',
		project: dim(null, 'Unknown/deleted project'),
		workflow: dim(null, 'Unknown/deleted workflow'),
		state: dim('wfs_lost', 'Unknown/deleted state (wfs_lost)')
	},
	{
		issue: 'iss_mixed_orphan_b',
		project: dim('prj_deletedb', 'Unknown/deleted project (prj_deletedb)'),
		workflow: dim('wf_standard', 'Standard'),
		state: dim('wfs_std_open', 'Open')
	}
];
/** @type {Array<any>} Raw historical fixtures intentionally include invalid persisted fields. */
export const manifest = Array.from({ length: 250 }, (_, i) => {
	const s = structures[i % structures.length];
	const [
		raw,
		status,
		cost_exact,
		source,
		tokens,
		diagnostics,
		invalid_tokens,
		rate,
		pricing_reason
	] = kinds[i % kinds.length];
	const runnerId = ['rnr_mixeda', 'rnr_mixedb', 'rnr_deleteda', 'rnr_deletedb'][i % 4];
	const tier = ['smartest', 'balanced', 'cheapest'][i % 3];
	const outcome = ['advanced', 'stalled', 'interrupted', null][Math.floor(i / 3) % 4];
	return {
		id: `arun_mixed_${String(i).padStart(3, '0')}`,
		issue: s.issue,
		pending: i >= 143,
		raw: typeof raw === 'string' ? raw : raw === null ? null : JSON.stringify(raw),
		created: from - 1000 + Math.floor(i / 4),
		ended: i >= 143 ? (i % 2 ? to + 1000 : null) : from + Math.floor(i / 5),
		dimensions: {
			project: s.project,
			workflow: s.workflow,
			state: { ...s.state, workflow_id: s.workflow.id, workflow_name: s.workflow.name },
			runner: dim(
				runnerId,
				runnerId === 'rnr_mixeda'
					? 'Mixed runner A'
					: runnerId === 'rnr_mixedb'
						? 'Mixed runner B'
						: `Unknown/deleted runner (${runnerId})`
			),
			tier: dim(tier, tier),
			outcome: dim(outcome, outcome ? outcome[0].toUpperCase() + outcome.slice(1) : 'Unknown')
		},
		accounting: {
			status,
			cost: cost_exact === null ? null : Number(cost_exact),
			cost_exact,
			source,
			basis: rate,
			tokens: Object.fromEntries(tokenNames.map((t, j) => [t, tokens[j] ?? null])),
			invalid_tokens,
			diagnostics: Object.fromEntries(diagnosticNames.map((d) => [d, diagnostics[d] ?? 0])),
			pricing_reason
		}
	};
});
/** @param {import('node:sqlite').DatabaseSync} sqlite */
export function seedMixed(sqlite) {
	sqlite.exec(`PRAGMA foreign_keys=OFF;
 INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES ('${user}','Mixed','mixed@example.test',1,${from},${from}),('${foreignUser}','Foreign secret','mixed-foreign@example.test',1,${from},${from});
 INSERT INTO workflow (id,user_id,name,initial_state_id,created_at,updated_at) VALUES ('wf_mixed','${user}','Mixed workflow','wfs_mixed',${from},${from}),('wf_mixedforeign','${foreignUser}','Foreign secret workflow','wfs_mixed_foreign',${from},${from});
 INSERT INTO workflow_state (id,workflow_id,name,category,position,created_at) VALUES ('wfs_deletedstart','wf_deletedstart','Unverifiable historical state','active',0,${from}),('wfs_mixed','wf_mixed','Mixed state','active',0,${from}),('wfs_mixed_foreign','wf_mixedforeign','Foreign secret state','active',0,${from});
 INSERT INTO project (id,user_id,name,created_at,updated_at,archived_at) VALUES ('prj_mixeda','${user}','Mixed active',${from},${from},NULL),('prj_mixedb','${user}','Mixed archived',${from},${from},${from}),('prj_mixedforeign','${foreignUser}','Foreign secret project',${from},${from},NULL);
 INSERT INTO issue (id,project_id,number,title,workflow_id,state_id,created_at,updated_at) VALUES
 ('iss_mixed_deletedworkflow','prj_mixeda',2,'Deleted workflow','wf_deleted','wfs_deletedworkflow',${from},${from}),
 ('iss_mixed_a','prj_mixeda',1,'Mixed A','wf_standard','wfs_std_open',${from},${from}),
 ('iss_mixed_b','prj_mixedb',1,'Mixed B','wf_mixed','wfs_mixed',${from},${from}),
 ('iss_mixed_orphan','prj_deleteda',1,'Historical orphan','wf_standard','wfs_std_open',${from},${from}),
 ('iss_mixed_orphan_b','prj_deletedb',1,'Historical orphan B','wf_standard','wfs_std_open',${from},${from}),
 ('iss_mixed_foreign','prj_mixedforeign',1,'Foreign secret issue','wf_mixedforeign','wfs_mixed_foreign',${from},${from});
 INSERT INTO runner (id,user_id,type,name,status,max_concurrent,max_run_minutes,default_tier,config,created_at,updated_at) VALUES
 ('rnr_mixeda','${user}','local','Mixed runner A','paused',1,30,'balanced','{}',${from},${from}),
 ('rnr_mixedb','${user}','local','Mixed runner B','paused',1,30,'balanced','{}',${from},${from}),
 ('rnr_mixedforeign','${foreignUser}','local','Foreign secret runner','paused',1,30,'balanced','{}',${from},${from});`);
	const insert = sqlite.prepare(
		`INSERT INTO agent_run (id,user_id,issue_id,runner_id,status,outcome,tier,usage,state_id_at_start,log,created_at,started_at,ended_at,error,provider_session_id,state_id_at_end) VALUES (?,?,?,?,?,?,?,?,?,'',?,?,?,?,?,?)`
	);
	for (const r of manifest)
		insert.run(
			r.id,
			user,
			r.issue,
			r.dimensions.runner.id,
			r.pending ? 'running' : 'completed',
			r.pending ? 'advanced' : r.dimensions.outcome.id,
			r.dimensions.tier.id,
			r.pending ? '{"cost_usd":999999,"future-secret":true}' : r.raw,
			r.dimensions.state.id,
			r.created,
			r.created,
			r.ended,
			r.pending ? 'future-secret-error' : null,
			r.pending ? 'future-secret-session' : null,
			r.pending ? 'future-secret-end' : null
		);
	sqlite.exec(
		`INSERT INTO agent_run (id,user_id,issue_id,runner_id,status,outcome,tier,usage,state_id_at_start,created_at,ended_at) VALUES ('arun_mixed_foreign','${foreignUser}','iss_mixed_foreign','rnr_mixedforeign','completed','advanced','smartest','{"cost_usd":900000}','wfs_mixed_foreign',${from - 1},${from + 1}); PRAGMA foreign_keys=ON;`
	);
}
/** @type {Array<Record<string,string>>} */
export const cases = [
	{ by: 'state', workflow: 'wf_standard', state: 'unknown' },
	...['project', 'workflow', 'state', 'outcome', 'runner', 'tier'].map((by) => ({ by })),
	...['prj_mixeda', 'prj_mixedb', 'prj_deleteda', 'prj_deletedb', 'unknown'].map((project) => ({
		by: 'workflow',
		project
	})),
	...['wf_standard', 'wf_mixed', 'wf_deleted', 'wf_deletedstart', 'unknown'].map((workflow) => ({
		by: 'state',
		workflow
	})),
	{ by: 'state', workflow: 'wf_mixed', state: 'wfs_deleted_a' },
	{ by: 'state', workflow: 'wf_standard', state: 'wfs_deleted_b' },
	{ by: 'state', workflow: 'unknown', state: 'wfs_lost' },
	...['rnr_mixeda', 'rnr_mixedb', 'rnr_deleteda', 'rnr_deletedb', 'unknown'].map((runner) => ({
		by: 'project',
		runner
	})),
	...['smartest', 'balanced', 'cheapest', 'unknown'].map((tier) => ({ by: 'workflow', tier })),
	...['advanced', 'stalled', 'interrupted', 'unknown'].map((outcome) => ({
		by: 'outcome',
		outcome
	})),
	...['priced', 'unpriced', 'unreported'].map((accounting_status) => ({
		by: 'project',
		accounting_status
	})),
	{
		by: 'state',
		project: 'prj_mixedb',
		runner: 'rnr_deletedb',
		tier: 'balanced',
		outcome: 'advanced',
		accounting_status: 'priced'
	},
	{ by: 'state', project: 'prj_mixeda', workflow: 'wf_mixed', state: 'wfs_deleted_a' } // authorized but disjoint
];
/** @param {Record<string,string>} filters */
export function selected(filters, pending = false, scope = false) {
	return manifest.filter(
		(r) =>
			r.pending === pending &&
			Object.entries(filters).every(([k, v]) => {
				if (
					k === 'by' ||
					(scope && k !== 'project') ||
					(pending && ['outcome', 'accounting_status'].includes(k))
				)
					return true;
				const actual = k === 'accounting_status' ? r.accounting.status : r.dimensions[k]?.id;
				return actual === (v === 'unknown' ? null : v);
			})
	);
}
/** @param {Array<{accounting:any}>} rows */
const exact = (rows) =>
	String(rows.reduce((n, r) => n + Math.round(Number(r.accounting.cost_exact) * 100), 0) / 100);
/** @param {any} actual @param {Array<{accounting:any}>} rows */
export function assertAggregate(actual, rows) {
	const priced = rows.filter((r) => r.accounting.status === 'priced');
	assert.equal(actual.finalized_run_count, rows.length);
	for (const status of ['priced', 'unpriced', 'unreported'])
		assert.equal(
			actual[`${status}_run_count`],
			rows.filter((r) => r.accounting.status === status).length
		);
	assert.equal(actual.cost_usd_exact, priced.length ? exact(priced) : null);
	assert.equal(actual.cost_usd, priced.length ? Number(exact(priced)) : null);
	assert.equal(
		actual.coverage,
		!rows.length
			? 'empty'
			: !priced.length
				? 'unknown'
				: priced.length === rows.length
					? 'complete'
					: 'partial'
	);
	for (const source of ['provider', 'calculated', 'unknown_source']) {
		const part = priced.filter((r) => r.accounting.source === source);
		assert.deepEqual(actual.portions[source], {
			priced_run_count: part.length,
			cost_usd: Number(exact(part)),
			cost_usd_exact: exact(part)
		});
	}
	for (const token of tokenNames) {
		const reported = rows.filter((r) => r.accounting.tokens[token] !== null);
		assert.deepEqual(actual.tokens[token], {
			value: reported.length ? reported.reduce((n, r) => n + r.accounting.tokens[token], 0) : null,
			reported_runs: reported.length,
			invalid_runs: rows.filter((r) => r.accounting.invalid_tokens.includes(token)).length
		});
	}
	assert.deepEqual(
		actual.diagnostics,
		Object.fromEntries(
			diagnosticNames.map((d) => [d, rows.reduce((n, r) => n + r.accounting.diagnostics[d], 0)])
		)
	);
	/** @type {Record<string,number>} */
	const reasons = {};
	for (const r of rows)
		if (r.accounting.pricing_reason)
			reasons[r.accounting.pricing_reason] = (reasons[r.accounting.pricing_reason] ?? 0) + 1;
	assert.deepEqual(actual.pricing_reasons, reasons);
	const samples = priced.map((r) => r.accounting.cost).sort((a, b) => a - b),
		n = samples.length;
	assert.deepEqual(actual.distribution, {
		subset: 'priced_finalized_runs',
		sample_count: n,
		missing_price_count: rows.length - n,
		mean_cost_usd: n ? Number(exact(priced)) / n : null,
		median_cost_usd: n ? (samples[Math.floor((n - 1) / 2)] + samples[Math.floor(n / 2)]) / 2 : null,
		p95_cost_usd: n ? samples[Math.ceil(0.95 * n) - 1] : null,
		max_cost_usd: n ? samples[n - 1] : null,
		percentile_rule: 'nearest_rank',
		low_sample: n > 0 && n < 20
	});
	const expectedRates = [];
	for (const rate of [
		basis,
		{
			calculation_version: basis.calculation_version,
			rate_id: 'partial-rate',
			cost_usd_exact: '0.25'
		},
		null
	]) {
		const part = priced.filter(
			(r) => r.accounting.source === 'calculated' && r.accounting.basis?.rate_id === rate?.rate_id
		);
		if (!part.length) continue;
		const identity = rate
			? Object.fromEntries(
					Object.entries(rate).filter(([k]) => !['cost_usd_exact', 'rate_selected_at'].includes(k))
				)
			: null;
		expectedRates.push({
			basis: identity,
			priced_run_count: part.length,
			cost_usd: Number(exact(part)),
			cost_usd_exact: exact(part),
			rate_selected_at_min: rate && 'rate_selected_at' in rate ? rate.rate_selected_at : null,
			rate_selected_at_max: rate && 'rate_selected_at' in rate ? rate.rate_selected_at : null
		});
	}
	/** @param {Array<any>} a */
	const sortRates = (a) =>
		[...a].sort((x, y) => (x.basis?.rate_id ?? '').localeCompare(y.basis?.rate_id ?? ''));
	assert.deepEqual(sortRates(actual.rate_portions), sortRates(expectedRates));
}
/**
 * @param {(path:string, query:Record<string,string>)=>Promise<any>} request
 * @param {(filters:any, report:any, populations:any)=>Promise<void>} onCase
 */
export async function verifyMixed(request, onCase = async () => {}) {
	let pages = 0;
	for (const filters of cases) {
		const report = await request('/usage', { ...bounds, ...filters });
		const scope = selected(filters, false, true),
			matching = selected(filters);
		assertAggregate(report.scope_total, scope);
		assertAggregate(report.matching_total, matching);
		const groups = new Map();
		for (const row of matching) {
			const d = row.dimensions[filters.by];
			const key = JSON.stringify([d.workflow_id ?? null, d.id]);
			groups.set(key, [...(groups.get(key) ?? []), row]);
		}
		assert.equal(report.groups.length, groups.size);
		for (const group of report.groups) {
			const rows = groups.get(group.key);
			assert.ok(rows, group.key);
			assert.deepEqual(group.dimension, rows[0].dimensions[filters.by]);
			assertAggregate(group.aggregate, rows);
		}
		assert.equal(report.pending.scope_count, selected(filters, true, true).length);
		assert.equal(report.pending.matching_count, selected(filters, true).length);
		/** @type {Record<string,Array<any>>} */
		const populations = {};
		for (const pending of [false, true]) {
			const population = pending ? 'pending' : 'finalized',
				rows = selected(filters, pending);
			const query = {
				...(pending ? report.pending_evidence_filters : report.matching_evidence_filters),
				limit: '17'
			};
			const items = [];
			/** @type {string|null} */
			let cursor = null;
			do {
				/** @type {any} */
				const page = await request('/runs', { ...query, ...(cursor ? { cursor } : {}) });
				pages++;
				assert.equal(page.usage_window.from, from);
				assert.equal(page.usage_window.to, to);
				assert.equal(page.usage_window.timezone, report.timezone);
				items.push(...page.items);
				cursor = page.next_cursor;
				assert.ok(items.length <= manifest.length, 'paging did not terminate');
			} while (cursor);
			assert.equal(
				new Set(items.map((r) => r.id)).size,
				items.length,
				'duplicate raw HTTP evidence'
			);
			assert.deepEqual(items.map((r) => r.id).sort(), rows.map((r) => r.id).sort());
			for (const item of items) {
				const row = rows.find((r) => r.id === item.id),
					dimensions = { ...row.dimensions };
				if (pending) {
					delete dimensions.outcome;
					assert.deepEqual(
						Object.keys(item).sort(),
						[
							'id',
							'issue_id',
							'issue_ref',
							'runner_id',
							'runner_name',
							'tier',
							'state_id_at_start',
							'state_at_start_name',
							'created_at',
							'pending_at',
							'usage_dimensions',
							'accounting_status'
						].sort()
					);
					assert.equal(item.accounting_status, 'pending');
					assert.equal(item.pending_at, to);
					assert.ok(!JSON.stringify(item).includes('future-secret'));
				} else assert.deepEqual(item.usage_accounting, row.accounting);
				assert.deepEqual(item.usage_dimensions, dimensions);
			}
			if (!pending)
				assertAggregate(
					report.matching_total,
					items.map((item) => ({ accounting: item.usage_accounting }))
				);
			populations[population] = items;
		}
		await onCase(filters, report, populations);
	}
	return {
		cases: cases.length,
		finalized: 143,
		pending: 107,
		raw_http_pages: pages,
		all_fields_and_groups_reconciled: true
	};
}
