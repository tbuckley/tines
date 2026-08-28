import { describe, expect, it } from 'vitest';
import { sweepSchedules } from '../schedule-sweep';
import type { ActorContext } from './core';
import { createIssue } from './issues';
import { getSchedule, runScheduleNow, updateSchedule } from './schedules';
import { createTestDb, type TestDb } from './test-db';
import { updateWorkflow } from './workflows';

const NOW = Date.parse('2026-08-01T00:00:00Z');

const actor: ActorContext = {
	userId: 'u1',
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

function seed(t: TestDb) {
	t.sqlite.exec(`
		INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
			VALUES ('u1', 'alice', 'a@example.com', 1, ${NOW}, ${NOW});
		INSERT INTO project (id, user_id, name, created_at, updated_at)
			VALUES ('prj_1', 'u1', 'demo', ${NOW}, ${NOW});
	`);
}

/** A user-owned workflow (Todo → Doing → Done) for cross-workflow tests. */
function seedCustomWorkflow(t: TestDb) {
	t.sqlite.exec(`
		INSERT INTO workflow (id, user_id, name, description, initial_state_id, created_at, updated_at)
			VALUES ('wf_2', 'u1', 'Custom', '', 'wfs_c_todo', ${NOW}, ${NOW});
		INSERT INTO workflow_state (id, workflow_id, name, category, position, created_at) VALUES
			('wfs_c_todo', 'wf_2', 'Todo', 'active', 0, ${NOW}),
			('wfs_c_doing', 'wf_2', 'Doing', 'active', 1, ${NOW}),
			('wfs_c_done', 'wf_2', 'Done', 'done', 2, ${NOW});
	`);
}

async function createSchedule(t: TestDb, extra: { state?: string } = {}) {
	const res = await createIssue(t.db, t.env, actor, 'prj_1', {
		title: 'Daily triage',
		state: extra.state,
		schedule: { preset: { kind: 'daily', time: '09:00' } }
	});
	return res.schedule!;
}

describe('schedule start state', () => {
	it('defaults to the workflow initial state, stored as NULL ("follow the workflow")', async () => {
		const t = createTestDb();
		seed(t);
		const schedule = await createSchedule(t);
		expect(schedule.workflow_id).toBe('wf_standard');
		expect(schedule.state_id).toBeNull();
		expect(schedule.state_name).toBeNull();
	});

	it('a non-initial starting state on the first issue pins the schedule too', async () => {
		const t = createTestDb();
		seed(t);
		const schedule = await createSchedule(t, { state: 'Human Review' });
		expect(schedule.state_id).toBe('wfs_std_review');
		expect(schedule.state_name).toBe('Human Review');
		// The scheduled_task.created event names the pinned start state.
		const [ev] = t.all(
			`SELECT payload FROM event WHERE type = 'scheduled_task.created'`
		);
		expect(JSON.parse(ev.payload as string).start_state).toBe('Human Review');
	});

	it('updateSchedule pins a state by name and instances start there', async () => {
		const t = createTestDb();
		seed(t);
		const schedule = await createSchedule(t);

		const updated = await updateSchedule(t.db, t.env, actor, schedule.id, {
			state: 'Human Review'
		});
		expect(updated.state_id).toBe('wfs_std_review');
		expect(updated.state_name).toBe('Human Review');

		const issueId = await runScheduleNow(t.db, t.env, actor, schedule.id);
		expect(t.all(`SELECT state_id FROM issue WHERE id = ?`, issueId)).toEqual([
			{ state_id: 'wfs_std_review' }
		]);

		// The summary diff records the change (null = the initial state).
		const events = t.all(`SELECT payload FROM event WHERE type = 'scheduled_task.updated'`);
		expect(JSON.parse(events[0].payload as string).start_state).toEqual({
			from: null,
			to: 'Human Review'
		});
	});

	it('the sweep creates instances in the pinned state', async () => {
		const t = createTestDb();
		seed(t);
		const schedule = await createSchedule(t, { state: 'Human Review' });
		t.sqlite
			.prepare(`UPDATE scheduled_task SET next_run_at = ? WHERE id = ?`)
			.run(Date.now() - 60_000, schedule.id);

		await sweepSchedules(t.env);

		const instances = t.all(
			`SELECT state_id FROM issue WHERE scheduled_task_id = ? ORDER BY number`,
			schedule.id
		);
		expect(instances).toHaveLength(2); // the initial issue + the swept one
		expect(instances[1]).toEqual({ state_id: 'wfs_std_review' });
	});

	it('picking the initial state — or explicit null — resets to "follow the workflow"', async () => {
		const t = createTestDb();
		seed(t);
		const schedule = await createSchedule(t, { state: 'Human Review' });

		const reset = await updateSchedule(t.db, t.env, actor, schedule.id, { state: 'Open' });
		expect(reset.state_id).toBeNull();

		await updateSchedule(t.db, t.env, actor, schedule.id, { state: 'Human Review' });
		const cleared = await updateSchedule(t.db, t.env, actor, schedule.id, { state: null });
		expect(cleared.state_id).toBeNull();
	});

	it('rejects a state the workflow does not have, naming the known states', async () => {
		const t = createTestDb();
		seed(t);
		const schedule = await createSchedule(t);
		await expect(
			updateSchedule(t.db, t.env, actor, schedule.id, { state: 'Nope' })
		).rejects.toMatchObject({ code: 'unknown_state' });
	});
});

describe('schedule workflow changes', () => {
	it('moves future instances onto the new workflow, resetting a pinned state', async () => {
		const t = createTestDb();
		seed(t);
		seedCustomWorkflow(t);
		const schedule = await createSchedule(t, { state: 'Human Review' });

		const updated = await updateSchedule(t.db, t.env, actor, schedule.id, {
			workflow_id: 'wf_2'
		});
		expect(updated.workflow_id).toBe('wf_2');
		expect(updated.workflow_name).toBe('Custom');
		expect(updated.state_id).toBeNull();

		const issueId = await runScheduleNow(t.db, t.env, actor, schedule.id);
		expect(t.all(`SELECT workflow_id, state_id FROM issue WHERE id = ?`, issueId)).toEqual([
			{ workflow_id: 'wf_2', state_id: 'wfs_c_todo' }
		]);

		const events = t.all(`SELECT payload FROM event WHERE type = 'scheduled_task.updated'`);
		const payload = JSON.parse(events[0].payload as string);
		expect(payload.workflow).toEqual({ from: 'Standard', to: 'Custom' });
		expect(payload.start_state).toEqual({ from: 'Human Review', to: null });
	});

	it('resolves a state sent with the workflow change within the new workflow', async () => {
		const t = createTestDb();
		seed(t);
		seedCustomWorkflow(t);
		const schedule = await createSchedule(t);

		const updated = await updateSchedule(t.db, t.env, actor, schedule.id, {
			workflow_id: 'wf_2',
			state: 'Doing'
		});
		expect(updated.workflow_id).toBe('wf_2');
		expect(updated.state_id).toBe('wfs_c_doing');
		expect(updated.state_name).toBe('Doing');
	});

	it('rejects a workflow outside the user library', async () => {
		const t = createTestDb();
		seed(t);
		const schedule = await createSchedule(t);
		await expect(
			updateSchedule(t.db, t.env, actor, schedule.id, { workflow_id: 'wf_missing' })
		).rejects.toMatchObject({ code: 'unknown_workflow' });
	});
});

describe('workflow editing guard', () => {
	it('a state a schedule starts instances in cannot be deleted', async () => {
		const t = createTestDb();
		seed(t);
		seedCustomWorkflow(t);
		const schedule = await createSchedule(t);
		await updateSchedule(t.db, t.env, actor, schedule.id, { workflow_id: 'wf_2', state: 'Doing' });

		await expect(
			updateWorkflow(t.db, t.env, actor, 'wf_2', {
				states: [
					{ id: 'wfs_c_todo', name: 'Todo', category: 'active' },
					{ id: 'wfs_c_done', name: 'Done', category: 'done' }
				],
				transitions: []
			})
		).rejects.toMatchObject({
			code: 'state_in_use',
			details: {
				schedules: [
					{ id: schedule.id, name: 'Daily triage', state_id: 'wfs_c_doing', state_name: 'Doing' }
				]
			}
		});

		// Removing an unscheduled state still works.
		await updateSchedule(t.db, t.env, actor, schedule.id, { state: null });
		const updated = await updateWorkflow(t.db, t.env, actor, 'wf_2', {
			states: [
				{ id: 'wfs_c_todo', name: 'Todo', category: 'active' },
				{ id: 'wfs_c_done', name: 'Done', category: 'done' }
			],
			transitions: []
		});
		expect(updated.states.map((s) => s.id)).toEqual(['wfs_c_todo', 'wfs_c_done']);
		expect((await getSchedule(t.db, actor.userId, schedule.id)).state_id).toBeNull();
	});
});
