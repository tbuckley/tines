import {
	recordDispatchEffects,
	TEST_NOOP_DISPATCH_EFFECTS
} from '$lib/server/api/test-dispatch-effects';
import { describe, expect, it } from 'vitest';
import { parseExecutionReceipt, sweepSchedules } from '../schedule-sweep';
import type { ActorContext } from './core';
import { createIssue } from './issues';
import { archiveProject, unarchiveProject } from './projects';
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

function holdFirstBatch(t: TestDb) {
	let enter!: () => void;
	const entered = new Promise<void>((resolve) => (enter = resolve));
	let release!: () => void;
	const released = new Promise<void>((resolve) => (release = resolve));
	const env = { ...t.env, DB: Object.create(t.env.DB) } as Env;
	let held = true;
	env.DB.batch = async <T = unknown>(statements: Parameters<Env['DB']['batch']>[0]) => {
		if (held) {
			held = false;
			enter();
			await released;
		}
		return t.env.DB.batch<T>(statements);
	};
	return { env, entered, release };
}

async function createSchedule(
	t: TestDb,
	extra: { state?: string; requireAllClosed?: boolean } = {}
) {
	const res = await createIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, 'prj_1', {
		title: 'Daily triage',
		state: extra.state,
		schedule: {
			preset: { kind: 'daily', time: '09:00' },
			...(extra.requireAllClosed ? { require_all_closed: true } : {})
		}
	});
	return res.schedule!;
}

describe('schedule start state', () => {
	it('refuses to retry Run now with a definition changed during count contention', async () => {
		const t = createTestDb();
		seed(t);
		const schedule = await createSchedule(t);
		const realBatch = t.env.DB.batch.bind(t.env.DB);
		let first = true;
		t.env.DB.batch = async <T = unknown>(statements: Parameters<Env['DB']['batch']>[0]) => {
			if (first) {
				first = false;
				t.sqlite
					.prepare(
						`UPDATE scheduled_task
						 SET run_count = run_count + 1
						 WHERE id = ?`
					)
					.run(schedule.id);
			}
			const result = await realBatch<T>(statements);
			if (!first) {
				t.sqlite
					.prepare(
						`UPDATE scheduled_task
						 SET title_template = 'Edited while busy', definition_revision = definition_revision + 1
						 WHERE id = ?`
					)
					.run(schedule.id);
				first = true;
			}
			return result;
		};

		await expect(
			runScheduleNow(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, schedule.id)
		).rejects.toMatchObject({ status: 409, code: 'schedule_changed' });
		expect(t.all(`SELECT id FROM issue WHERE scheduled_task_id = ?`, schedule.id)).toHaveLength(1);
		expect(t.all(`SELECT title_template FROM scheduled_task WHERE id = ?`, schedule.id)).toEqual([
			{ title_template: 'Edited while busy' }
		]);
	});

	it('makes concurrent Run now calls share the commit-time all-closed gate in either winner order', async () => {
		for (const winner of ['left', 'right'] as const) {
			const t = createTestDb();
			seed(t);
			const schedule = await createSchedule(t, { requireAllClosed: true });
			t.sqlite
				.prepare(`UPDATE issue SET state_id = 'wfs_std_closed' WHERE scheduled_task_id = ?`)
				.run(schedule.id);
			const left = holdFirstBatch(t);
			const right = holdFirstBatch(t);
			const leftCall = runScheduleNow(
				t.db,
				left.env,
				actor,
				TEST_NOOP_DISPATCH_EFFECTS,
				schedule.id
			);
			const rightCall = runScheduleNow(
				t.db,
				right.env,
				actor,
				TEST_NOOP_DISPATCH_EFFECTS,
				schedule.id
			);
			await Promise.all([left.entered, right.entered]);

			const winningCall = winner === 'left' ? leftCall : rightCall;
			const losingCall = winner === 'left' ? rightCall : leftCall;
			const winningRelease = winner === 'left' ? left.release : right.release;
			const losingRelease = winner === 'left' ? right.release : left.release;
			winningRelease();
			await expect(winningCall).resolves.toEqual(expect.any(String));
			losingRelease();
			await expect(losingCall).rejects.toMatchObject({
				code: 'schedule_blocked',
				status: 422
			});

			expect(t.all(`SELECT id FROM issue WHERE scheduled_task_id = ?`, schedule.id)).toHaveLength(
				2
			);
			expect(
				t.all(`SELECT id FROM event WHERE type = 'issue.created' AND issue_id IS NOT NULL`)
			).toHaveLength(2);
			expect(t.all(`SELECT run_count FROM scheduled_task WHERE id = ?`, schedule.id)).toEqual([
				{ run_count: 2 }
			]);
		}
	});

	it('dispatch effects: runScheduleNow signals only after its instance batch commits', async () => {
		const t = createTestDb();
		seed(t);
		const schedule = await createSchedule(t);
		const effects = recordDispatchEffects();
		const issueId = await runScheduleNow(t.db, t.env, actor, effects, schedule.id);
		expect(effects.count()).toBe(1);
		expect(t.all('SELECT id FROM issue WHERE id = ?', issueId)).toHaveLength(1);
		await expect(runScheduleNow(t.db, t.env, actor, effects, 'tsk_missing')).rejects.toMatchObject({
			status: 404
		});
		expect(effects.count()).toBe(1);

		const beforeIssues = t.all('SELECT id FROM issue').length;
		const beforeEvents = t.all("SELECT id FROM event WHERE type = 'issue.created'").length;
		const realBatch = t.env.DB.batch.bind(t.env.DB);
		t.env.DB.batch = async () => {
			throw new Error('injected schedule instance batch failure');
		};
		await expect(runScheduleNow(t.db, t.env, actor, effects, schedule.id)).rejects.toThrow(
			'injected schedule instance batch failure'
		);
		t.env.DB.batch = realBatch;
		expect(effects.count()).toBe(1);
		expect(t.all('SELECT id FROM issue')).toHaveLength(beforeIssues);
		expect(t.all("SELECT id FROM event WHERE type = 'issue.created'")).toHaveLength(beforeEvents);
	});

	it('fails closed on a malformed committed receipt without dispatching', async () => {
		const t = createTestDb();
		seed(t);
		const schedule = await createSchedule(t);
		const effects = recordDispatchEffects();
		const realBatch = t.env.DB.batch.bind(t.env.DB);
		t.env.DB.batch = async <T = unknown>(statements: Parameters<Env['DB']['batch']>[0]) => {
			const results = await realBatch<T>(statements);
			const receipt = results.at(-1)!;
			const row = receipt.results?.[0] as Record<string, unknown>;
			return [
				...results.slice(0, -1),
				{
					...receipt,
					results: [{ ...row, created_event_id: 'evt_corrupt' } as T]
				}
			];
		};

		await expect(runScheduleNow(t.db, t.env, actor, effects, schedule.id)).rejects.toThrow(
			'Malformed scheduled-task execution receipt'
		);
		expect(effects.count()).toBe(0);
		expect(t.all(`SELECT id FROM issue WHERE scheduled_task_id = ?`, schedule.id)).toHaveLength(2);
		expect(t.all(`SELECT id FROM event WHERE type = 'issue.created'`)).toHaveLength(2);
	});

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
		const [ev] = t.all(`SELECT payload FROM event WHERE type = 'scheduled_task.created'`);
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

		const issueId = await runScheduleNow(
			t.db,
			t.env,
			actor,
			TEST_NOOP_DISPATCH_EFFECTS,
			schedule.id
		);
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

	it('skips a due schedule while its project is archived, then resumes without a backfill', async () => {
		const t = createTestDb();
		seed(t);
		const schedule = await createSchedule(t);
		const due = Date.now() - 60_000;
		t.sqlite
			.prepare(`UPDATE scheduled_task SET next_run_at = ? WHERE id = ?`)
			.run(due, schedule.id);
		await archiveProject(t.db, t.env, actor, 'prj_1', Date.now());

		const instances = () =>
			t.all(`SELECT id FROM issue WHERE scheduled_task_id = ?`, schedule.id).length;
		const before = instances();
		const runCount = () => t.all(`SELECT run_count FROM scheduled_task WHERE id = ?`, schedule.id);
		const runsBefore = runCount();
		await sweepSchedules(t.env);
		await sweepSchedules(t.env);
		expect(instances()).toBe(before);
		// Skipping is silent: an archived project is not a schedule problem.
		expect(t.all(`SELECT id FROM event WHERE type = 'scheduled_task.skipped'`)).toEqual([]);
		expect(runCount()).toEqual(runsBefore);

		const now = Date.now();
		await unarchiveProject(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, 'prj_1', now);
		const next = (await getSchedule(t.db, 'u1', schedule.id)).next_run_at!;
		expect(next).toBeGreaterThan(now);
		// One more sweep at the same instant still fires nothing: no catch-up.
		await sweepSchedules(t.env);
		expect(instances()).toBe(before);
	});

	it('re-checks pause at the cron commit boundary', async () => {
		const t = createTestDb();
		seed(t);
		const schedule = await createSchedule(t);
		const due = Date.now() - 60_000;
		t.sqlite
			.prepare(`UPDATE scheduled_task SET next_run_at = ? WHERE id = ?`)
			.run(due, schedule.id);
		const realBatch = t.env.DB.batch.bind(t.env.DB);
		let paused = false;
		t.env.DB.batch = async <T = unknown>(statements: Parameters<Env['DB']['batch']>[0]) => {
			if (!paused) {
				paused = true;
				t.sqlite.prepare(`UPDATE scheduled_task SET enabled = 0 WHERE id = ?`).run(schedule.id);
			}
			return realBatch<T>(statements);
		};

		await sweepSchedules(t.env, Date.now());
		expect(t.all(`SELECT id FROM issue WHERE scheduled_task_id = ?`, schedule.id)).toHaveLength(1);
		expect(
			t.all(`SELECT id FROM event WHERE type = 'issue.created' AND issue_id IS NOT NULL`)
		).toHaveLength(1);
		expect(
			t.all(`SELECT run_count, next_run_at FROM scheduled_task WHERE id = ?`, schedule.id)
		).toEqual([{ run_count: 1, next_run_at: due }]);
	});

	it('re-checks archive at the manual commit boundary', async () => {
		const t = createTestDb();
		seed(t);
		const schedule = await createSchedule(t);
		const beforeSchedule = t.all(
			`SELECT run_count, last_run_at, next_run_at FROM scheduled_task WHERE id = ?`,
			schedule.id
		);
		const realBatch = t.env.DB.batch.bind(t.env.DB);
		let enter!: () => void;
		const prepared = new Promise<void>((resolve) => (enter = resolve));
		let release!: () => void;
		const released = new Promise<void>((resolve) => (release = resolve));
		const env = { ...t.env, DB: Object.create(t.env.DB) } as Env;
		env.DB.batch = async <T = unknown>(statements: Parameters<Env['DB']['batch']>[0]) => {
			enter();
			await released;
			return realBatch<T>(statements);
		};

		const pending = runScheduleNow(t.db, env, actor, TEST_NOOP_DISPATCH_EFFECTS, schedule.id);
		await prepared;
		t.sqlite.prepare(`UPDATE project SET archived_at = ? WHERE id = ?`).run(Date.now(), 'prj_1');
		release();

		await expect(pending).rejects.toMatchObject({ status: 422, code: 'project_archived' });
		expect(t.all(`SELECT id FROM issue WHERE scheduled_task_id = ?`, schedule.id)).toHaveLength(1);
		expect(t.all(`SELECT id FROM event WHERE type = 'issue.created'`)).toHaveLength(1);
		expect(t.all(`SELECT id FROM event WHERE type = 'scheduled_task.skipped'`)).toEqual([]);
		expect(
			t.all(
				`SELECT run_count, last_run_at, next_run_at FROM scheduled_task WHERE id = ?`,
				schedule.id
			)
		).toEqual(beforeSchedule);
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

	it('refuses a stale schedule writer without overwriting the competing edit', async () => {
		const t = createTestDb();
		seed(t);
		const schedule = await createSchedule(t);
		const realBatch = t.env.DB.batch.bind(t.env.DB);
		let injected = false;
		t.env.DB.batch = async (statements: Parameters<Env['DB']['batch']>[0]) => {
			if (!injected) {
				injected = true;
				t.sqlite
					.prepare(
						`UPDATE scheduled_task
						 SET name = 'Competing edit', title_template = 'Competing edit',
						     definition_revision = definition_revision + 1
						 WHERE id = ?`
					)
					.run(schedule.id);
			}
			return realBatch(statements);
		};

		await expect(
			updateSchedule(t.db, t.env, actor, schedule.id, { name: 'Stale edit' })
		).rejects.toMatchObject({ status: 409, code: 'schedule_changed' });
		expect(
			t.all(`SELECT name, title_template FROM scheduled_task WHERE id = ?`, schedule.id)
		).toEqual([{ name: 'Competing edit', title_template: 'Competing edit' }]);
		expect(t.all(`SELECT type FROM event WHERE type = 'scheduled_task.updated'`)).toEqual([]);
	});

	it('refuses a schedule edit when its project archives at the commit boundary', async () => {
		const t = createTestDb();
		seed(t);
		const schedule = await createSchedule(t);
		const realBatch = t.env.DB.batch.bind(t.env.DB);
		let injected = false;
		t.env.DB.batch = async (statements: Parameters<Env['DB']['batch']>[0]) => {
			if (!injected) {
				injected = true;
				t.sqlite
					.prepare(`UPDATE project SET archived_at = ? WHERE id = ?`)
					.run(Date.now(), 'prj_1');
			}
			return realBatch(statements);
		};

		await expect(
			updateSchedule(t.db, t.env, actor, schedule.id, { name: 'Archived race' })
		).rejects.toMatchObject({ status: 422, code: 'project_archived' });
		expect(t.all(`SELECT name FROM scheduled_task WHERE id = ?`, schedule.id)).toEqual([
			{ name: 'Daily triage' }
		]);
		expect(t.all(`SELECT type FROM event WHERE type = 'scheduled_task.updated'`)).toEqual([]);
	});
});

describe('schedule execution receipts', () => {
	const expected = { issueId: 'iss_1', createdEventId: 'evt_1', skippedEventId: null };
	const valid = {
		status: 'blocked',
		issue_id: expected.issueId,
		created_event_id: expected.createdEventId,
		skipped_event_id: null,
		archived_at: null,
		blocking: JSON.stringify([
			{
				issue_id: 'iss_2',
				project_id: 'prj_2',
				project_name: 'other project',
				number: 7,
				title: 'Open blocker'
			}
		])
	};

	it.each([
		[
			'missing status',
			(() => {
				const row = { ...valid };
				delete (row as Record<string, unknown>).status;
				return row;
			})()
		],
		['missing issue id', { ...valid, issue_id: undefined }],
		['missing created event id', { ...valid, created_event_id: undefined }],
		[
			'missing blocking',
			(() => {
				const row = { ...valid };
				delete (row as Record<string, unknown>).blocking;
				return row;
			})()
		],
		['non-object blocker', { ...valid, blocking: '[1]' }],
		[
			'missing issue_id',
			{
				...valid,
				blocking: JSON.stringify([
					{
						project_id: 'prj_2',
						project_name: 'other project',
						number: 7,
						title: 'Open blocker'
					}
				])
			}
		],
		[
			'missing project_id',
			{
				...valid,
				blocking: JSON.stringify([
					{
						issue_id: 'iss_2',
						project_name: 'other project',
						number: 7,
						title: 'Open blocker'
					}
				])
			}
		],
		[
			'missing project_name',
			{
				...valid,
				blocking: JSON.stringify([
					{
						issue_id: 'iss_2',
						project_id: 'prj_2',
						number: 7,
						title: 'Open blocker'
					}
				])
			}
		],
		[
			'non-integer number',
			{
				...valid,
				blocking: JSON.stringify([
					{
						issue_id: 'iss_2',
						project_id: 'prj_2',
						project_name: 'other project',
						number: 7.5,
						title: 'Open blocker'
					}
				])
			}
		],
		[
			'missing title',
			{
				...valid,
				blocking: JSON.stringify([
					{
						issue_id: 'iss_2',
						project_id: 'prj_2',
						project_name: 'other project',
						number: 7
					}
				])
			}
		],
		['invalid archive value', { ...valid, archived_at: 'not-a-number' }]
	] as const)('fails closed for %s', (_name, row) => {
		expect(() => parseExecutionReceipt({ results: [row] }, expected)).toThrow(
			/Malformed scheduled-task/i
		);
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

		const issueId = await runScheduleNow(
			t.db,
			t.env,
			actor,
			TEST_NOOP_DISPATCH_EFFECTS,
			schedule.id
		);
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
			updateWorkflow(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, 'wf_2', {
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
		const updated = await updateWorkflow(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, 'wf_2', {
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
