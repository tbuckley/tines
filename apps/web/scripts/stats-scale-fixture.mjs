/** Extra rows for the opt-in weekly-stats Worker profile. Never loaded by normal E2E. */
export function statsScaleStatements(now, irrelevantMultiplier = 1) {
	const q = (value) => `'${String(value).replaceAll("'", "''")}'`;
	const rows = [];
	const insert = (table, value) =>
		rows.push(
			`INSERT INTO ${table} (${Object.keys(value).join(',')}) VALUES (${Object.values(value)
				.map((item) => (item === null ? 'NULL' : typeof item === 'number' ? item : q(item)))
				.join(',')});`
		);
	const day = 86_400_000;
	for (let index = 5; index < 28; index++)
		insert('workflow_state', {
			id: `ws_scale_${index}`,
			workflow_id: 'wf_weekly',
			name: `Scale stage ${index}`,
			category: 'active',
			position: index,
			created_at: now
		});
	for (let index = 0; index < 524; index++) {
		const issue = `iss_stats_scale_${index}`;
		const state =
			index % 28 < 5
				? ['ws_implementation', 'ws_research', 'ws_discovering', 'ws_review', 'ws_done'][index % 28]
				: `ws_scale_${index % 28}`;
		const at = now - 13 * day + index * 1_000_000;
		insert('issue', {
			id: issue,
			project_id: index % 7 === 0 ? 'prj_weekly_other' : 'prj_weekly',
			number: 10_000 + index,
			title: `Scale issue ${index}`,
			workflow_id: 'wf_weekly',
			state_id: state,
			created_at: at,
			updated_at: at
		});
		insert('event', {
			id: `evt_stats_scale_${index}_created`,
			user_id: 'usr_weekly',
			actor_user_id: 'usr_weekly',
			issue_id: issue,
			project_id: index % 7 === 0 ? 'prj_weekly_other' : 'prj_weekly',
			type: 'issue.created',
			payload: JSON.stringify({ state_id: state }),
			created_at: at
		});
		for (let move = 1; move < 4; move++)
			insert('event', {
				id: `evt_stats_scale_${index}_${move}`,
				user_id: 'usr_weekly',
				actor_user_id: 'usr_weekly',
				issue_id: issue,
				project_id: index % 7 === 0 ? 'prj_weekly_other' : 'prj_weekly',
				type: 'issue.transitioned',
				payload: JSON.stringify({ from_state_id: state, to_state_id: state }),
				created_at: at + move * 3_600_000
			});
	}
	for (let index = 0; index < 1525; index++) {
		const issue = `iss_stats_scale_${index % 524}`;
		const stateIndex = index % 28;
		const state =
			stateIndex < 5
				? ['ws_implementation', 'ws_research', 'ws_discovering', 'ws_review', 'ws_done'][stateIndex]
				: `ws_scale_${stateIndex}`;
		const at = now - 6 * day + index * 100_000;
		insert('agent_run', {
			id: `arun_stats_scale_${index}`,
			user_id: 'usr_weekly',
			issue_id: issue,
			runner_id: 'rnr_weekly',
			status: 'completed',
			outcome: 'advanced',
			tier: 'balanced',
			model: 'profile',
			state_id_at_start: state,
			state_id_at_end: state,
			created_at: at,
			started_at: at + 30_000,
			ended_at: at + 90_000
		});
	}
	for (let index = 0; index < 20; index++)
		insert('event', {
			id: `evt_stats_marker_${String(index).padStart(2, '0')}`,
			user_id: 'usr_weekly',
			actor_user_id: 'usr_weekly',
			issue_id: null,
			project_id: null,
			type: 'settings.updated',
			payload: JSON.stringify({ changed: ['quota'] }),
			created_at: now - (index + 1) * 4 * 3_600_000
		});
	for (let index = 0; index < 1_000 * irrelevantMultiplier; index++)
		insert('event', {
			id: `evt_stats_irrelevant_${index}`,
			user_id: 'usr_weekly',
			actor_user_id: 'usr_weekly',
			issue_id: null,
			project_id: null,
			type: 'comment.created',
			payload: JSON.stringify({ body: `Unrelated event ${index}` }),
			created_at: now - (index % (7 * 24)) * 3_600_000
		});
	return rows;
}
