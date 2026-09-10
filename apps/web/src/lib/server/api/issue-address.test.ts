import { describe, expect, it } from 'vitest';
import {
	NOW,
	OPEN,
	PROJECT,
	USER,
	addIssue,
	addRunner,
	seedBase
} from '../supervisor/test-fixtures';
import type { ActorContext } from './core';
import { eventInsert, eventQuery, serializeEvent } from './events';
import { createIssue, loadIssue } from './issues';
import { deleteProject } from './projects';
import { createTestDb } from './test-db';

const DESTINATION = 'prj_destination';
const actor: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

function fixture() {
	const t = createTestDb();
	seedBase(t);
	t.sqlite.exec(`
		INSERT INTO project (id, user_id, name, created_at, updated_at)
		VALUES ('${DESTINATION}', '${USER}', 'destination', ${NOW}, ${NOW})
	`);
	return t;
}

describe('permanent issue addresses', () => {
	it('records ordinary inserts and never reuses a moved-away highest number', async () => {
		const t = fixture();
		const moved = addIssue(t, { title: 'moved maximum' });
		const originalNumber = Number(t.all('SELECT number FROM issue WHERE id = ?', moved)[0].number);
		t.sqlite.exec(`
			UPDATE issue
			SET project_id = '${DESTINATION}', number = 1,
				project_assignment_token = 'assignment-2', updated_at = ${NOW + 1}
			WHERE id = '${moved}'
		`);

		const created = await createIssue(t.db, t.env, actor, PROJECT, { title: 'after move' });
		expect(created.number).toBe(originalNumber + 1);
		expect(
			t.all('SELECT project_id, number, issue_id FROM issue_address ORDER BY project_id, number')
		).toEqual(
			expect.arrayContaining([
				{ project_id: PROJECT, number: originalNumber, issue_id: moved },
				{ project_id: PROJECT, number: originalNumber + 1, issue_id: created.id },
				{ project_id: DESTINATION, number: 1, issue_id: moved }
			])
		);
	});

	it('resolves every old ID/name address to the current canonical issue', async () => {
		const t = fixture();
		const id = addIssue(t, { title: 'traveller' });
		const originalNumber = Number(t.all('SELECT number FROM issue WHERE id = ?', id)[0].number);
		t.sqlite.exec(`
			UPDATE issue
			SET project_id = '${DESTINATION}', number = 7,
				project_assignment_token = 'assignment-2', updated_at = ${NOW + 1}
			WHERE id = '${id}'
		`);

		for (const ref of [
			{ id },
			{ projectId: PROJECT, number: originalNumber },
			{ projectName: 'demo', number: originalNumber },
			{ projectId: DESTINATION, number: 7 },
			{ projectName: 'destination', number: 7 }
		] as const) {
			const issue = await loadIssue(t.db, USER, ref);
			expect(issue).toMatchObject({
				id,
				project_id: DESTINATION,
				project_name: 'destination',
				number: 7
			});
		}
	});

	it('keeps historical activity attribution separate from the live canonical ref', async () => {
		const t = fixture();
		const id = addIssue(t, { title: 'traveller' });
		await t.db.executeQuery(
			eventInsert(t.db, actor, {
				type: 'issue.updated',
				issueId: id,
				projectId: PROJECT,
				payload: { title: 'before' }
			})
		);
		t.sqlite.exec(`
			UPDATE issue SET project_id = '${DESTINATION}', number = 7,
				project_assignment_token = 'assignment-2' WHERE id = '${id}'
		`);

		const row = await eventQuery(t.db, USER)
			.where('event.issue_id', '=', id)
			.where('event.type', '=', 'issue.updated')
			.executeTakeFirstOrThrow();
		const event = serializeEvent(row);
		expect(event.project_name).toBe('demo');
		expect(event.issue_ref).toMatchObject({ project_name: 'destination', number: 7 });

		// Even a caller holding a stale source project resolves attribution in
		// the INSERT itself, after the move has committed.
		await t.db.executeQuery(
			eventInsert(t.db, actor, {
				type: 'issue.updated',
				issueId: id,
				projectId: PROJECT,
				payload: { title: 'after' }
			})
		);
		const attribution = new Map(
			t
				.all("SELECT project_id, payload FROM event WHERE type = 'issue.updated'")
				.map((row) => [JSON.parse(row.payload as string).title, row.project_id])
		);
		expect(attribution).toEqual(
			new Map([
				['before', PROJECT],
				['after', DESTINATION]
			])
		);
	});

	it('links a moved schedule instance back to the schedule origin', async () => {
		const t = fixture();
		const id = addIssue(t, { title: 'scheduled traveller' });
		t.sqlite.exec(`
			INSERT INTO scheduled_task
				(id, project_id, name, title_template, description_template, workflow_id, state_id,
				 cron, timezone, next_run_at, created_at, updated_at)
			VALUES ('sch_origin', '${PROJECT}', 'Daily', 'Daily', '', 'wf_standard', '${OPEN}',
				'0 9 * * *', 'UTC', ${NOW + 1000}, ${NOW}, ${NOW});
			UPDATE issue SET scheduled_task_id = 'sch_origin', project_id = '${DESTINATION}', number = 7,
				project_assignment_token = 'assignment-2' WHERE id = '${id}';
		`);

		expect(await loadIssue(t.db, USER, { id })).toMatchObject({
			scheduled_task_id: 'sch_origin',
			scheduled_task_name: 'Daily',
			scheduled_task_project_id: PROJECT,
			scheduled_task_project_name: 'demo'
		});
	});

	it('protects a former source project even during forced deletion', async () => {
		const t = fixture();
		const id = addIssue(t);
		t.sqlite.exec(`
			UPDATE issue SET project_id = '${DESTINATION}', number = 1,
				project_assignment_token = 'assignment-2' WHERE id = '${id}'
		`);

		await expect(
			deleteProject(t.db, t.env, actor, PROJECT, { forceDeleteContext: true })
		).rejects.toMatchObject({
			status: 422,
			code: 'project_has_issue_aliases',
			details: { alias_count: 1 }
		});
		expect(t.all('SELECT id FROM project WHERE id = ?', PROJECT)).toHaveLength(1);
	});

	it('rejects incoherent issue/project context and stale active claims', () => {
		const t = fixture();
		const id = addIssue(t);
		expect(() =>
			t.sqlite.exec(`
				INSERT INTO context_item
					(id, user_id, kind, name, project_id, issue_id, position, created_at, updated_at)
				VALUES ('ctx_bad', '${USER}', 'prompt', 'bad', '${DESTINATION}', '${id}', 0, ${NOW}, ${NOW})
			`)
		).toThrow(/incoherent_issue_project_scope/);

		const runner = addRunner(t);
		t.sqlite.exec(
			`UPDATE issue SET project_assignment_token = 'new-assignment' WHERE id = '${id}'`
		);
		expect(() =>
			t.sqlite.exec(`
				INSERT INTO agent_run
					(id, user_id, issue_id, runner_id, status, tier, state_id_at_start, created_at)
				VALUES ('arun_stale', '${USER}', '${id}', '${runner}', 'assigned', 'balanced', '${OPEN}', ${NOW})
			`)
		).toThrow(/stale_project_assignment/);
	});
});
