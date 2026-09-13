/** Populated analytics in an isolated account, using the real stats loader. */
export const WEEKLY = {
	id: 'usr_weekly',
	name: 'Weekly board',
	email: 'weekly@e2e.test',
	apiKey: 'tines_e2eweekly000000000000000000000000000000000',
	apiKeyName: 'weekly',
	sessionToken: 'e2e-weekly',
	projectId: 'prj_weekly',
	otherProjectId: 'prj_weekly_other'
};
export function stageStatsSeed(now) {
	const statements = [];
	const q = (v) => `'${String(v).replaceAll("'", "''")}'`;
	const insert = (table, row) =>
		statements.push(
			`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.values(row)
				.map((v) => (v === null ? 'NULL' : typeof v === 'number' ? v : q(v)))
				.join(',')});`
		);
	const day = 86400000,
		minute = 60000;
	const user = WEEKLY.id;
	insert('workflow', {
		id: 'wf_weekly',
		user_id: user,
		name: 'Engineering · platform and orchestration',
		initial_state_id: 'ws_implementation',
		created_at: now,
		updated_at: now
	});
	for (const [position, name] of [
		'Implementation',
		'Research',
		'Discovering',
		'Automated Review',
		'Done'
	].entries())
		insert('workflow_state', {
			id: `ws_${name === 'Automated Review' ? 'review' : name.toLowerCase()}`,
			workflow_id: 'wf_weekly',
			name,
			category: name === 'Done' ? 'done' : 'active',
			position,
			created_at: now
		});
	insert('project', {
		id: WEEKLY.projectId,
		user_id: user,
		name: 'Weekly analytics',
		default_workflow_id: 'wf_weekly',
		created_at: now,
		updated_at: now
	});
	insert('project', {
		id: WEEKLY.otherProjectId,
		user_id: user,
		name: 'Weekly other project',
		default_workflow_id: 'wf_weekly',
		created_at: now,
		updated_at: now
	});
	insert('event', {
		id: 'evt_weekly_other_rule',
		user_id: user,
		actor_user_id: user,
		project_id: WEEKLY.otherProjectId,
		type: 'routing_rule.updated',
		payload: JSON.stringify({
			workflow_state_id: 'ws_review',
			scope_label: 'Weekly other project'
		}),
		created_at: now - 5 * day
	});
	insert('runner', {
		id: 'rnr_weekly',
		user_id: user,
		type: 'claude_managed',
		name: 'Review runner',
		status: 'active',
		max_concurrent: 2,
		max_run_minutes: 30,
		default_tier: 'balanced',
		config: '{}',
		created_at: now,
		updated_at: now
	});
	let number = 0,
		event = 0,
		run = 0;
	const emit = (type, at, payload, issue = null) =>
		insert('event', {
			id: `evt_weekly_${++event}`,
			user_id: user,
			actor_user_id: user,
			issue_id: issue,
			project_id: issue ? WEEKLY.projectId : null,
			type,
			payload: JSON.stringify(payload),
			created_at: at
		});
	function visit(state, at, wait, runs, failed, sent = false) {
		const id = `iss_weekly_${++number}`;
		const exit = at + wait + 2 * 60 * minute;
		insert('issue', {
			id,
			project_id: WEEKLY.projectId,
			number,
			title: `${state} visit ${number}`,
			workflow_id: 'wf_weekly',
			state_id: sent ? 'ws_implementation' : 'ws_done',
			created_at: at,
			updated_at: exit
		});
		emit('issue.created', at, { state_id: state }, id);
		for (let i = 0; i < runs; i++) {
			const bad = i < failed;
			insert('agent_run', {
				id: `arun_weekly_${++run}`,
				user_id: user,
				issue_id: id,
				runner_id: 'rnr_weekly',
				status: bad ? 'failed' : 'completed',
				outcome: bad ? null : 'advanced',
				tier: 'balanced',
				model: 'test-model',
				state_id_at_start: state,
				state_id_at_end: sent ? 'ws_implementation' : 'ws_done',
				created_at: at + i * 1000,
				started_at: bad ? null : at + wait + i * 1000,
				ended_at: exit - 1000,
				error: bad ? 'Provider could not start the run' : null
			});
		}
		emit(
			'issue.transitioned',
			exit,
			{
				from_state_id: state,
				to_state_id: sent ? 'ws_implementation' : 'ws_done',
				action: sent ? 'Send back' : 'Complete'
			},
			id
		);
	}
	for (let i = 0; i < 55; i++) visit('ws_review', now - 3 * day, 2 * minute, 1, 0, i < 11);
	for (let i = 0; i < 11; i++) visit('ws_review', now - 10 * day, 3 * minute, 1, 0, i === 0);
	for (let i = 0; i < 12; i++) visit('ws_research', now - 4 * day, 155 * minute, 1, 0);
	for (let i = 0; i < 6; i++)
		visit('ws_discovering', now - 2 * day, 10 * minute, i < 2 ? 4 : 3, i < 5 ? 2 : 1);
	insert('context_item', {
		id: 'ctx_weekly_prompt',
		user_id: user,
		kind: 'prompt',
		name: 'instructions',
		description: '',
		workflow_state_id: 'ws_review',
		body: 'Review the evidence and return actionable findings.',
		position: 0,
		version: 2,
		created_at: now - 12 * day,
		updated_at: now - day
	});
	emit('context.created', now - 12 * day, {
		context_id: 'ctx_weekly_prompt',
		kind: 'prompt',
		name: 'instructions',
		scope: { workflow_state_id: 'ws_review' }
	});
	emit('context.updated', now - day, {
		context_id: 'ctx_weekly_prompt',
		kind: 'prompt',
		name: 'instructions',
		version: 2,
		scope: { workflow_state_id: 'ws_review' }
	});
	emit('settings.updated', now - 2 * day, { changed: ['quota'] });
	emit('runner.updated', now - 3 * day, { changed: ['max_concurrent'], name: 'Review runner' });
	emit('routing_rule.updated', now - 4 * day, { workflow_state_id: 'ws_discovering' });
	return statements;
}
