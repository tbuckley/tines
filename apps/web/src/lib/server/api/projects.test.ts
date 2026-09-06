/**
 * Archiving a project: the drain report, idempotence, the schedules that
 * resume from *now* rather than replaying, and the list default that hides
 * archived projects from every picker.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
	NOW,
	OPEN,
	PROJECT,
	USER,
	addIssue,
	addRun,
	addRunner,
	seedBase
} from '../supervisor/test-fixtures';
import { ApiFail, type ActorContext } from './core';
import { createIssue } from './issues';
import {
	archiveProject,
	createProject,
	deleteProject,
	listProjects,
	unarchiveProject,
	updateProject
} from './projects';
import { getSchedule } from './schedules';
import { createTestDb, type TestDb } from './test-db';

const actor: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

let t: TestDb;

beforeEach(() => {
	t = createTestDb();
	seedBase(t);
});

const events = () =>
	t.all('SELECT type, payload FROM event ORDER BY created_at, id').map((r) => ({
		type: r.type as string,
		payload: JSON.parse(r.payload as string) as Record<string, unknown>
	}));

const archivedAt = () =>
	t.all(`SELECT archived_at FROM project WHERE id = '${PROJECT}'`)[0].archived_at;

/** A daily schedule in the project, created the way the API creates one. */
async function seedSchedule(name = 'Daily triage') {
	const res = await createIssue(t.db, t.env, actor, PROJECT, {
		title: name,
		schedule: { preset: { kind: 'daily', time: '09:00' } }
	});
	return res.schedule!;
}

async function failure(fn: () => Promise<unknown>): Promise<ApiFail> {
	try {
		await fn();
	} catch (e) {
		if (e instanceof ApiFail) return e;
		throw e;
	}
	throw new Error('expected the call to throw');
}

describe('archiveProject', () => {
	it('sets archived_at, emits one event, and reports what the archive froze', async () => {
		const schedule = await seedSchedule();
		const issue = addIssue(t);
		const runner = addRunner(t, { name: 'macbook' });
		addRun(t, { issueId: issue, runnerId: runner, status: 'running', stateAtStart: OPEN });
		// A finished run is not draining, and neither is one in another project.
		addRun(t, { issueId: issue, runnerId: runner, status: 'completed', stateAtStart: OPEN });

		const res = await archiveProject(t.db, t.env, actor, PROJECT, NOW + 1000);

		expect(res.project.archived_at).toBe(NOW + 1000);
		expect(res.schedules_paused).toBe(1);
		expect(res.issues_read_only).toBe(res.project.issue_count);
		expect(res.draining_runs).toEqual([
			{
				run_id: expect.any(String),
				runner_name: 'macbook',
				issue_id: issue,
				issue_number: expect.any(Number)
			}
		]);
		expect(events().filter((e) => e.type === 'project.archived')).toEqual([
			{
				type: 'project.archived',
				payload: {
					name: 'demo',
					schedules_paused: 1,
					draining_runs: 1,
					issues_read_only: res.issues_read_only
				}
			}
		]);
		// The schedule is paused by the sweep's predicate, never by its own flag.
		expect((await getSchedule(t.db, USER, schedule.id)).enabled).toBe(true);
	});

	it('counts only enabled schedules as paused', async () => {
		const schedule = await seedSchedule();
		t.sqlite.exec(`UPDATE scheduled_task SET enabled = 0 WHERE id = '${schedule.id}'`);
		const res = await archiveProject(t.db, t.env, actor, PROJECT, NOW + 1000);
		expect(res.schedules_paused).toBe(0);
	});

	it('is idempotent: a second archive keeps the first instant and writes no event', async () => {
		await archiveProject(t.db, t.env, actor, PROJECT, NOW + 1000);
		const again = await archiveProject(t.db, t.env, actor, PROJECT, NOW + 9000);
		expect(again.project.archived_at).toBe(NOW + 1000);
		expect(archivedAt()).toBe(NOW + 1000);
		expect(events().filter((e) => e.type === 'project.archived')).toHaveLength(1);
	});

	it('404s for a project that is not the actor’s', async () => {
		const e = await failure(() => archiveProject(t.db, t.env, actor, 'prj_nope'));
		expect(e.status).toBe(404);
	});
});

describe('unarchiveProject', () => {
	it('clears archived_at, emits the event, and re-arms enabled schedules from now', async () => {
		const schedule = await seedSchedule();
		const disabled = await seedSchedule('Weekly review');
		t.sqlite.exec(`UPDATE scheduled_task SET enabled = 0 WHERE id = '${disabled.id}'`);
		await archiveProject(t.db, t.env, actor, PROJECT, NOW);
		// A long archive leaves every next_run_at in the past; unarchive must
		// skip forward rather than let the sweep fire a month of catch-up.
		const stale = NOW - 1000;
		t.sqlite.exec(`UPDATE scheduled_task SET next_run_at = ${stale}`);

		const later = Date.parse('2026-09-05T12:00:00Z');
		const res = await unarchiveProject(t.db, t.env, actor, PROJECT, later);

		expect(res.project.archived_at).toBeNull();
		expect(res.schedules_resumed).toBe(1);
		expect((await getSchedule(t.db, USER, schedule.id)).next_run_at).toBeGreaterThan(later);
		// A disabled schedule keeps its stale next_run_at and its flag.
		const untouched = await getSchedule(t.db, USER, disabled.id);
		expect(untouched.enabled).toBe(false);
		expect(untouched.next_run_at).toBe(stale);
		expect(events().filter((e) => e.type === 'project.unarchived')).toEqual([
			{ type: 'project.unarchived', payload: { name: 'demo', schedules_resumed: 1 } }
		]);
	});

	it('is a no-op on a live project', async () => {
		const res = await unarchiveProject(t.db, t.env, actor, PROJECT, NOW);
		expect(res.schedules_resumed).toBe(0);
		expect(events().filter((e) => e.type === 'project.unarchived')).toEqual([]);
	});
});

describe('an archived project is read-only', () => {
	beforeEach(async () => {
		await archiveProject(t.db, t.env, actor, PROJECT, NOW);
	});

	it('refuses PATCH', async () => {
		const e = await failure(() => updateProject(t.db, t.env, actor, PROJECT, { name: 'renamed' }));
		expect(e.code).toBe('project_archived');
	});

	it('refuses DELETE', async () => {
		const e = await failure(() => deleteProject(t.db, t.env, actor, PROJECT));
		expect(e.code).toBe('project_archived');
	});

	it('keeps its name reserved', async () => {
		const e = await failure(() =>
			createProject(t.db, t.env, actor, { name: 'demo' })
		);
		expect(e.code).toBe('duplicate_project_name');
	});
});

describe('listProjects', () => {
	it('hides archived projects by default and shows them on request', async () => {
		t.sqlite.exec(`
			INSERT INTO project (id, user_id, name, created_at, updated_at)
				VALUES ('prj_2', '${USER}', 'other', ${NOW}, ${NOW});
		`);
		await archiveProject(t.db, t.env, actor, PROJECT, NOW);

		expect((await listProjects(t.db, USER)).map((p) => p.name)).toEqual(['other']);
		expect((await listProjects(t.db, USER, { archived: 'false' })).map((p) => p.name)).toEqual([
			'other'
		]);
		expect((await listProjects(t.db, USER, { archived: 'true' })).map((p) => p.name)).toEqual([
			'demo'
		]);
		expect((await listProjects(t.db, USER, { archived: 'all' })).map((p) => p.name).sort()).toEqual(
			['demo', 'other']
		);
	});
});
