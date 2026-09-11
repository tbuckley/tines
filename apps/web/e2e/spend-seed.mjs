import { SPEND } from './constants.mjs';

const json = (value) => JSON.stringify(value).replaceAll("'", "''");

/** Deterministic real-D1 ledger rows; totals are independent browser-test oracles. */
export function spendStatements(nowMs) {
	const midnight = Date.UTC(
		new Date(nowMs).getUTCFullYear(),
		new Date(nowMs).getUTCMonth(),
		new Date(nowMs).getUTCDate()
	);
	const today = Math.floor((midnight + nowMs) / 2);
	const twoDaysAgo = midnight - 36 * 60 * 60 * 1000;
	const tenDaysAgo = midnight - 9.5 * 24 * 60 * 60 * 1000;
	const p = SPEND.projects;
	const w = SPEND.workflows;
	const statements = [
		`INSERT INTO supervisor_settings (user_id, enabled, quota, attempt_limit, budget, updated_at)
		 VALUES ('${SPEND.id}', 0, '{"type":"global_cap","limit":1}', 3, '{"timezone":"UTC"}', ${nowMs});`,
		`INSERT INTO workflow (id, user_id, name, description, initial_state_id, created_at, updated_at) VALUES
		 ('${w.build.id}', '${SPEND.id}', '${w.build.name}', '', 'wfs_e2e_spend_design', ${nowMs}, ${nowMs}),
		 ('${w.ship.id}', '${SPEND.id}', '${w.ship.name}', '', 'wfs_e2e_spend_review', ${nowMs}, ${nowMs}),
		 ('${w.unknown.id}', '${SPEND.id}', '${w.unknown.name}', '', 'wfs_e2e_spend_open', ${nowMs}, ${nowMs});`,
		`INSERT INTO workflow_state (id, workflow_id, name, category, position, created_at) VALUES
		 ('wfs_e2e_spend_design', '${w.build.id}', 'Design', 'active', 0, ${nowMs}),
		 ('wfs_e2e_spend_implementation', '${w.build.id}', 'Implementation', 'active', 1, ${nowMs}),
		 ('wfs_e2e_spend_review', '${w.ship.id}', 'Review', 'active', 0, ${nowMs}),
		 ('wfs_e2e_spend_open', '${w.unknown.id}', 'Open', 'active', 0, ${nowMs});`,
		`INSERT INTO runner (id, user_id, type, name, status, max_concurrent, max_run_minutes, default_tier, config, created_at, updated_at)
		 VALUES ('rnr_e2e_spend', '${SPEND.id}', 'local', 'spend-paused', 'paused', 1, 30, 'balanced', '{}', ${nowMs}, ${nowMs});`
	];
	const projects = Object.values(p);
	statements.push(
		`INSERT INTO project (id, user_id, name, description, default_workflow_id, created_at, updated_at, archived_at) VALUES
		 ${projects
				.map(
					(project) =>
						`('${project.id}', '${SPEND.id}', '${project.name}', '', '${w.build.id}', ${nowMs}, ${nowMs}, ${project === p.archived ? nowMs : 'NULL'})`
				)
				.join(',\n')};`
	);
	const fixtures = [
		[
			'alpha_today',
			p.alpha.id,
			w.build.id,
			'wfs_e2e_spend_design',
			'advanced',
			today,
			{ cost_usd: 2, cost_source: 'provider', input_tokens: 20 }
		],
		[
			'alpha_2d',
			p.alpha.id,
			w.build.id,
			'wfs_e2e_spend_implementation',
			'stalled',
			twoDaysAgo,
			{ cost_usd: 3, cost_source: 'provider', input_tokens: 30 }
		],
		[
			'alpha_10d',
			p.alpha.id,
			w.ship.id,
			'wfs_e2e_spend_review',
			'interrupted',
			tenDaysAgo,
			{ cost_usd: 7, cost_source: 'provider', input_tokens: 70 }
		],
		['alpha_unknown', p.alpha.id, w.unknown.id, 'wfs_e2e_spend_open', null, today + 1, null],
		[
			'beta_today',
			p.beta.id,
			w.ship.id,
			'wfs_e2e_spend_review',
			'advanced',
			today + 2,
			{ cost_usd: 11, cost_source: 'provider' }
		],
		[
			'beta_10d',
			p.beta.id,
			w.ship.id,
			'wfs_e2e_spend_review',
			'stalled',
			tenDaysAgo + 2,
			{ cost_usd: 13, cost_source: 'provider' }
		],
		['unreported', p.unreported.id, w.build.id, 'wfs_e2e_spend_design', null, today + 3, null],
		[
			'tokens',
			p.tokens.id,
			w.build.id,
			'wfs_e2e_spend_design',
			null,
			today + 4,
			{ input_tokens: 100, output_tokens: 25 }
		],
		[
			'zero',
			p.zero.id,
			w.build.id,
			'wfs_e2e_spend_design',
			'advanced',
			today + 5,
			{ cost_usd: 0, cost_source: 'provider' }
		],
		[
			'archived',
			p.archived.id,
			w.ship.id,
			'wfs_e2e_spend_review',
			'advanced',
			today + 6,
			{ cost_usd: 17, cost_source: 'provider' }
		]
	];
	const issueNumbers = new Map();
	for (const [name, projectId, workflowId, stateId, outcome, endedAt, usage] of fixtures) {
		const issueNumber = (issueNumbers.get(projectId) ?? 0) + 1;
		issueNumbers.set(projectId, issueNumber);
		statements.push(
			`INSERT INTO issue (id, project_id, number, title, description, workflow_id, state_id, created_at, updated_at)
			 VALUES ('iss_e2e_spend_${name}', '${projectId}', ${issueNumber}, 'Spend ${name}', '', '${workflowId}', '${stateId}', ${endedAt}, ${endedAt});`,
			`INSERT INTO agent_run (id, user_id, issue_id, runner_id, status, outcome, tier, model, usage, state_id_at_start, state_id_at_end, log, created_at, started_at, ended_at)
			 VALUES ('run_e2e_spend_${name}', '${SPEND.id}', 'iss_e2e_spend_${name}', 'rnr_e2e_spend', 'completed', ${outcome ? `'${outcome}'` : 'NULL'}, 'balanced', NULL, ${usage ? `'${json(usage)}'` : 'NULL'}, '${stateId}', '${stateId}', '', ${endedAt}, ${endedAt}, ${endedAt});`
		);
	}
	statements.push(
		`INSERT INTO issue (id, project_id, number, title, description, workflow_id, state_id, created_at, updated_at)
		 VALUES ('iss_e2e_spend_pending', '${p.pending.id}', 1, 'Spend pending', '', '${w.build.id}', 'wfs_e2e_spend_design', ${today}, ${today});`,
		`INSERT INTO agent_run (id, user_id, issue_id, runner_id, status, outcome, tier, model, usage, state_id_at_start, log, created_at, started_at, ended_at)
		 VALUES ('run_e2e_spend_pending', '${SPEND.id}', 'iss_e2e_spend_pending', 'rnr_e2e_spend', 'running', NULL, 'balanced', NULL, NULL, 'wfs_e2e_spend_design', '', ${today}, ${today}, NULL);`
	);
	return statements;
}
