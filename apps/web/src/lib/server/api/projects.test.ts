/**
 * Archiving a project: the drain report, idempotence, the schedules that
 * resume from *now* rather than replaying, and the list default that hides
 * archived projects from every picker.
 */
import {
	recordDispatchEffects,
	TEST_NOOP_DISPATCH_EFFECTS
} from '$lib/server/api/test-dispatch-effects';
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
import { createContextItem, listContextItems } from './context';
import { ApiFail, type ActorContext } from './core';
import { countIssuesByCategory, createIssue, listIssues } from './issues';
import {
	archiveProject,
	createProject,
	deleteProject,
	listProjects,
	unarchiveProject,
	updateProject
} from './projects';
import { getSchedule, listSchedules } from './schedules';
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
	const res = await createIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, PROJECT, {
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
		const effects = recordDispatchEffects();
		const res = await unarchiveProject(t.db, t.env, actor, effects, PROJECT, later);

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
		expect(effects.count()).toBe(1);
	});

	it('is a no-op on a live project', async () => {
		const effects = recordDispatchEffects();
		const res = await unarchiveProject(t.db, t.env, actor, effects, PROJECT, NOW);
		expect(res.schedules_resumed).toBe(0);
		expect(events().filter((e) => e.type === 'project.unarchived')).toEqual([]);
		expect(effects.count()).toBe(1);
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
		const e = await failure(() => createProject(t.db, t.env, actor, { name: 'demo' }));
		expect(e.code).toBe('duplicate_project_name');
	});
});

describe('project deletion racing a historical address', () => {
	it('returns the archive remedy and rolls back forced context and schedule deletion', async () => {
		const source = 'prj_delete_race';
		const destination = 'prj_delete_destination';
		t.sqlite.exec(`
			INSERT INTO project (id, user_id, name, created_at, updated_at) VALUES
				('${source}', '${USER}', 'former', ${NOW}, ${NOW}),
				('${destination}', '${USER}', 'live', ${NOW}, ${NOW});
			INSERT INTO issue (
				id, project_id, number, title, description, workflow_id, state_id,
				attempt_count, needs_attention, created_at, updated_at, state_entered_at
			) VALUES (
				'iss_delete_race', '${destination}', 1, 'live issue', '', 'wf_standard', '${OPEN}',
				0, 0, ${NOW}, ${NOW}, ${NOW}
			);
			INSERT INTO context_item (
				id, user_id, kind, name, description, project_id, body, position, version,
				created_at, updated_at
			) VALUES (
				'ctx_delete_race', '${USER}', 'prompt', 'keep on rollback', '', '${source}', '',
				0, 1, ${NOW}, ${NOW}
			);
			INSERT INTO scheduled_task (
				id, project_id, name, title_template, description_template, workflow_id, state_id,
				cron, timezone, next_run_at, created_at, updated_at
			) VALUES (
				'sch_delete_race', '${source}', 'keep on rollback', 'x', '', 'wf_standard', '${OPEN}',
				'0 9 * * *', 'UTC', ${NOW + 1000}, ${NOW}, ${NOW}
			);
		`);
		const realBatch = t.env.DB.batch.bind(t.env.DB);
		let first = true;
		t.env.DB.batch = async (statements) => {
			if (first) {
				first = false;
				t.sqlite.exec(`
					INSERT INTO issue_address (project_id, number, issue_id, created_at)
					VALUES ('${source}', 9, 'iss_delete_race', ${NOW});
				`);
			}
			return realBatch(statements);
		};

		const error = await failure(() =>
			deleteProject(t.db, t.env, actor, source, { forceDeleteContext: true })
		);
		expect(error).toMatchObject({
			status: 422,
			code: 'project_has_issue_aliases',
			details: { alias_count: 1, remedy: 'tines projects archive "former"' }
		});
		expect(t.all(`SELECT id FROM project WHERE id = ?`, source)).toHaveLength(1);
		expect(t.all(`SELECT id FROM context_item WHERE id = 'ctx_delete_race'`)).toHaveLength(1);
		expect(t.all(`SELECT id FROM scheduled_task WHERE id = 'sch_delete_race'`)).toHaveLength(1);
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

describe('default lists exclude archived projects', () => {
	const page = { cursor: null, limit: 50 };

	/** One issue, one schedule and two context items in each of two projects. */
	async function seedBoth() {
		t.sqlite.exec(`
			INSERT INTO project (id, user_id, name, created_at, updated_at)
				VALUES ('prj_2', '${USER}', 'live', ${NOW}, ${NOW});
		`);
		await createIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, PROJECT, {
			title: 'Archived-side issue',
			schedule: { preset: { kind: 'daily', time: '09:00' } }
		});
		await createIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, 'prj_2', {
			title: 'Live-side issue',
			schedule: { preset: { kind: 'daily', time: '10:00' } }
		});
		await createContextItem(t.db, t.env, actor, {
			kind: 'prompt',
			name: 'archived-conventions',
			project_id: PROJECT,
			body: 'x'
		});
		await createContextItem(t.db, t.env, actor, {
			kind: 'prompt',
			name: 'global-guidelines',
			body: 'x'
		});
		await archiveProject(t.db, t.env, actor, PROJECT, NOW);
	}

	const titles = async (filters: Parameters<typeof listIssues>[2]) =>
		(await listIssues(t.db, USER, filters, page)).items.map((i) => i.title);

	it('hides an archived project’s issues until a project or archived filter asks', async () => {
		await seedBoth();
		expect(await titles({})).toEqual(['Live-side issue']);
		expect(await titles({ project: 'demo' })).toEqual(['Archived-side issue']);
		expect(await titles({ projectId: PROJECT })).toEqual(['Archived-side issue']);
		expect(await titles({ archived: 'true' })).toEqual(['Archived-side issue']);
		expect((await titles({ archived: 'all' })).sort()).toEqual([
			'Archived-side issue',
			'Live-side issue'
		]);
		// The category tabs count the same population the list shows.
		const counts = await countIssuesByCategory(t.db, USER, {});
		expect(counts.active).toBe(1);
	});

	it('hides an archived project’s schedules the same way', async () => {
		await seedBoth();
		const names = async (filters: Parameters<typeof listSchedules>[2]) =>
			(await listSchedules(t.db, USER, filters, page)).items.map((s) => s.project_name);
		expect(await names({})).toEqual(['live']);
		expect(await names({ projectId: PROJECT })).toEqual(['demo']);
		expect((await names({ archived: 'all' })).sort()).toEqual(['demo', 'live']);
	});

	it('hides context anchored on an archived project, but never global items', async () => {
		await seedBoth();
		const names = async (filters: Parameters<typeof listContextItems>[2]) =>
			(await listContextItems(t.db, USER, filters, page)).items.map((i) => i.name).sort();
		expect(await names({})).not.toContain('archived-conventions');
		expect(await names({})).toContain('global-guidelines');
		expect(await names({ project: 'demo' })).toContain('archived-conventions');
		expect(await names({ archived: 'all' })).toContain('archived-conventions');
	});

	it('still returns issue-scoped context when the issue is named', async () => {
		// The issue page's Context panel and `tines context list --issue <ref>`
		// pass only `issue`. Naming an issue names an anchor just as `project`
		// does, and reads of an archived project are never gated.
		const issue = await createIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, PROJECT, {
			title: 'Scoped'
		});
		await createContextItem(t.db, t.env, actor, {
			kind: 'prompt',
			name: 'issue-scoped-note',
			issue_id: issue.id,
			body: 'x'
		});
		await archiveProject(t.db, t.env, actor, PROJECT, NOW);
		const names = async (filters: Parameters<typeof listContextItems>[2]) =>
			(await listContextItems(t.db, USER, filters, page)).items.map((i) => i.name);
		expect(await names({ issue: issue.id })).toEqual(['issue-scoped-note']);
		expect(await names({})).not.toContain('issue-scoped-note');
	});
});
