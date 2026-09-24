import { describe, expect, it } from 'vitest';
import { TEST_NOOP_DISPATCH_EFFECTS } from './test-dispatch-effects';
import type { ActorContext } from './core';
import { createIssue, transitionIssue, updateIssue } from './issues';
import { readIssueConsent, writeIssueConsent } from './personal-consent';
import {
	readScheduleConsent,
	readSharedScheduleSummary,
	writeScheduleConsent
} from './schedule-consent';
import { deleteSchedule, runScheduleNow, updateSchedule } from './schedules';
import { createTestDb } from './test-db';
import { updateWorkflow } from './workflows';

const now = Date.parse('2026-09-23T00:00:00Z');
const session: ActorContext = {
	userId: 'u1',
	userName: 'owner',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};
const key: ActorContext = { ...session, apiKeyId: 'key_1', viaSession: false };

function fixture() {
	const t = createTestDb();
	t.sqlite.exec(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
		VALUES ('u1', 'owner', 'owner@example.test', 1, ${now}, ${now});
		INSERT INTO project (id, user_id, name, shared_at, sharing_revision, created_at, updated_at)
		VALUES ('prj_1', 'u1', 'shared', ${now}, 1, ${now}, ${now});`);
	return t;
}

async function initial(t: ReturnType<typeof fixture>, future?: boolean) {
	return createIssue(t.db, t.env, session, TEST_NOOP_DISPATCH_EFFECTS, 'prj_1', {
		title: 'Daily {{count}}',
		allow_my_agents: false,
		schedule: {
			preset: { kind: 'daily', time: '09:00' },
			...(future === undefined ? {} : { allow_my_agents_on_future_instances: future })
		}
	});
}

function inherited(t: ReturnType<typeof fixture>, issueId: string) {
	return t.all(
		`SELECT value, source_kind, source_grant_revision FROM issue_personal_choice WHERE issue_id = ?`,
		issueId
	) as { value: string; source_kind: string | null; source_grant_revision: number | null }[];
}

describe('future schedule permission', () => {
	it('acknowledges a future-only on choice in the creation batch', async () => {
		const t = fixture();
		const first = await createIssue(t.db, t.env, session, TEST_NOOP_DISPATCH_EFFECTS, 'prj_1', {
			title: 'Future only {{count}}',
			allow_my_agents: false,
			disclosure_version: 1,
			schedule: {
				preset: { kind: 'daily', time: '09:00' },
				allow_my_agents_on_future_instances: true
			}
		});
		expect((await readIssueConsent(t.db, 'u1', first.id)).my_agents.value).toBe('off');
		expect(
			(await readScheduleConsent(t.db, 'u1', first.schedule!.id)).my_future_permission.value
		).toBe('on');
		expect(t.all('SELECT version FROM personal_disclosure WHERE user_id = ?', 'u1')).toEqual([
			{ version: 1 }
		]);
	});
	it('stores a member browser choice without enabling execution or key authority', async () => {
		const t = fixture();
		t.sqlite.exec(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
			VALUES ('u2', 'member', 'member@example.test', 1, ${now}, ${now});
			INSERT INTO project_member (project_id, user_id, revision, joined_at, updated_at)
			VALUES ('prj_1', 'u2', 1, ${now}, ${now});`);
		const first = await initial(t);
		const member = { ...session, userId: 'u2', userName: 'member' };
		const future = await writeScheduleConsent(t.db, t.env, member, first.schedule!.id, {
			value: 'on',
			expected_revision: 0,
			permission_epoch: 0
		});
		expect(future).toMatchObject({ my_future_permission: { value: 'on', revision: 1 } });
		await expect(
			writeScheduleConsent(
				t.db,
				t.env,
				{ ...member, viaSession: false, apiKeyId: 'key_2' },
				first.schedule!.id,
				{
					value: 'off',
					expected_revision: 1,
					permission_epoch: 0
				}
			)
		).rejects.toMatchObject({ status: 403 });
		t.sqlite.exec(
			`UPDATE project_member SET revoked_at = ${now + 1}, revision = 2 WHERE project_id='prj_1' AND user_id='u2'`
		);
		await expect(
			writeScheduleConsent(t.db, t.env, member, first.schedule!.id, {
				value: 'off',
				expected_revision: 1,
				permission_epoch: 0
			})
		).rejects.toMatchObject({ status: 404 });
	});
	it('keeps initial and future choices independent, defaulting future off', async () => {
		const t = fixture();
		const first = await initial(t);
		expect(
			(await readScheduleConsent(t.db, 'u1', first.schedule!.id)).my_future_permission.value
		).toBe('unset');
		const next = await runScheduleNow(
			t.db,
			t.env,
			session,
			TEST_NOOP_DISPATCH_EFFECTS,
			first.schedule!.id
		);
		expect(inherited(t, next)).toEqual([]);
		const origin = t.all(
			`SELECT schedule_id, snapshot FROM issue_schedule_origin WHERE issue_id = ?`,
			next
		)[0] as { schedule_id: string; snapshot: string };
		expect(origin.schedule_id).toBe(first.schedule!.id);
		expect(JSON.parse(origin.snapshot).resolved_start_state_id).toBeTruthy();
		const grantRows = t.all(`SELECT schedule_id FROM schedule_personal_choice`);
		expect(grantRows).toEqual([]);
	});

	it('inherits a live grant, revokes old inherited rows on off, and never restores them', async () => {
		const t = fixture();
		const first = await initial(t, true);
		const scheduleId = first.schedule!.id;
		expect(inherited(t, first.id)[0].source_kind).toBe('explicit_issue');
		const second = await runScheduleNow(
			t.db,
			t.env,
			session,
			TEST_NOOP_DISPATCH_EFFECTS,
			scheduleId
		);
		expect(inherited(t, second)).toMatchObject([
			{
				value: 'on',
				source_kind: 'schedule',
				source_grant_revision: 1
			}
		]);
		const saved = await writeScheduleConsent(t.db, t.env, session, scheduleId, {
			value: 'off',
			expected_revision: 1,
			permission_epoch: 0
		});
		expect(saved.my_future_permission).toMatchObject({ value: 'off', revision: 2 });
		// The owner's inherited on becomes an explicit off: unset would be the owner default, on.
		expect(inherited(t, second)[0]).toMatchObject({ value: 'off', source_kind: null });
		await writeScheduleConsent(t.db, t.env, session, scheduleId, {
			value: 'on',
			expected_revision: 2,
			permission_epoch: 0
		});
		expect(inherited(t, second)[0].value).toBe('off');
		const third = await runScheduleNow(
			t.db,
			t.env,
			session,
			TEST_NOOP_DISPATCH_EFFECTS,
			scheduleId
		);
		expect(inherited(t, third)[0]).toMatchObject({ value: 'on', source_grant_revision: 3 });
	});

	it('keeps permission on pause and rename, and moves it to a new epoch for work changes', async () => {
		const t = fixture();
		const first = await initial(t, true);
		const id = first.schedule!.id;
		await updateSchedule(t.db, t.env, session, id, { enabled: false, name: 'Renamed' });
		await updateSchedule(t.db, t.env, session, id, { enabled: true });
		expect((await readScheduleConsent(t.db, 'u1', id)).my_future_permission).toMatchObject({
			value: 'on',
			epoch: 0
		});
		const second = await runScheduleNow(t.db, t.env, session, TEST_NOOP_DISPATCH_EFFECTS, id);
		await updateSchedule(t.db, t.env, session, id, { title_template: 'Different {{count}}' });
		// The owner keeps their choice under the new epoch; members start over at off.
		expect((await readScheduleConsent(t.db, 'u1', id)).my_future_permission).toMatchObject({
			value: 'on',
			epoch: 1
		});
		expect(inherited(t, second)[0].value).toBe('unset');
		await expect(
			writeScheduleConsent(t.db, t.env, session, id, {
				value: 'on',
				expected_revision: 1,
				permission_epoch: 0
			})
		).rejects.toMatchObject({ status: 409 });
	});

	for (const [name, edit] of [
		['description', { description_template: 'Changed {{count}}' }],
		['recurrence', { cron: '0 10 * * *' }],
		['timezone', { timezone: 'Europe/London' }],
		['gate', { require_all_closed: true }],
		['explicit starting state', { state: 'Human Review' }]
	] as const) {
		it(`resets future permission when ${name} changes`, async () => {
			const t = fixture();
			const first = await initial(t, true);
			const second = await runScheduleNow(
				t.db,
				t.env,
				session,
				TEST_NOOP_DISPATCH_EFFECTS,
				first.schedule!.id
			);
			await updateSchedule(t.db, t.env, session, first.schedule!.id, edit);
			expect(
				(await readScheduleConsent(t.db, 'u1', first.schedule!.id)).my_future_permission
			).toMatchObject({ value: 'on', epoch: 1 });
			expect(inherited(t, second)[0].value).toBe('unset');
		});
	}

	it('rejects key creation and key choice before any domain write', async () => {
		const t = fixture();
		await expect(
			createIssue(t.db, t.env, key, TEST_NOOP_DISPATCH_EFFECTS, 'prj_1', {
				title: 'Refused',
				schedule: { cron: '0 9 * * *', allow_my_agents_on_future_instances: false }
			})
		).rejects.toMatchObject({ status: 403, code: 'consent_browser_required' });
		expect(t.all(`SELECT id FROM issue`)).toHaveLength(0);
		const first = await initial(t);
		await expect(
			writeScheduleConsent(t.db, t.env, key, first.schedule!.id, {
				value: 'on',
				expected_revision: 0,
				permission_epoch: 0
			})
		).rejects.toMatchObject({ status: 403 });
		expect(t.all(`SELECT schedule_id FROM schedule_personal_choice`)).toHaveLength(0);
	});

	it('retains origin after deleting a source and clears inherited choice', async () => {
		const t = fixture();
		const first = await initial(t, true);
		const second = await runScheduleNow(
			t.db,
			t.env,
			session,
			TEST_NOOP_DISPATCH_EFFECTS,
			first.schedule!.id
		);
		await deleteSchedule(t.db, t.env, session, first.schedule!.id);
		expect(inherited(t, second)[0].value).toBe('unset');
		expect(
			t.all(`SELECT schedule_name FROM issue_schedule_origin WHERE issue_id = ?`, second)
		).toEqual([{ schedule_name: first.schedule!.name }]);
	});

	it('an explicit instance choice survives source off, while instance off overrides inheritance', async () => {
		const t = fixture();
		const first = await initial(t, true);
		const second = await runScheduleNow(
			t.db,
			t.env,
			session,
			TEST_NOOP_DISPATCH_EFFECTS,
			first.schedule!.id
		);
		const receipt = await readIssueConsent(t.db, 'u1', second);
		await writeIssueConsent(t.db, t.env, session, second, {
			value: 'on',
			expected_revision: receipt.my_agents.revision,
			issue_epoch: receipt.my_agents.epoch,
			decision_revision: receipt.issue_state.decision_revision
		});
		expect(inherited(t, second)[0].source_kind).toBe('explicit_issue');
		await writeScheduleConsent(t.db, t.env, session, first.schedule!.id, {
			value: 'off',
			expected_revision: 1,
			permission_epoch: 0
		});
		expect(inherited(t, second)[0]).toMatchObject({ value: 'on', source_kind: 'explicit_issue' });
		const third = await runScheduleNow(
			t.db,
			t.env,
			session,
			TEST_NOOP_DISPATCH_EFFECTS,
			first.schedule!.id
		);
		// The owner's future off is inherited, so the default does not admit the instance.
		expect(inherited(t, third)).toMatchObject([{ value: 'off', source_kind: 'schedule' }]);
	});

	it("an owner's inherited off survives a definition change and deletion; members reset to off", async () => {
		const t = fixture();
		t.sqlite.exec(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
			VALUES ('u2', 'member', 'member@example.test', 1, ${now}, ${now});
			INSERT INTO project_member (project_id, user_id, revision, joined_at, updated_at)
			VALUES ('prj_1', 'u2', 1, ${now}, ${now});`);
		const first = await initial(t, false);
		const id = first.schedule!.id;
		const member = { ...session, userId: 'u2', userName: 'member' };
		await writeScheduleConsent(t.db, t.env, member, id, {
			value: 'on',
			expected_revision: 0,
			permission_epoch: 0
		});
		const second = await runScheduleNow(t.db, t.env, session, TEST_NOOP_DISPATCH_EFFECTS, id);
		expect(
			t.all(
				`SELECT user_id, value FROM issue_personal_choice WHERE issue_id = ? ORDER BY user_id`,
				second
			)
		).toEqual([
			{ user_id: 'u1', value: 'off' },
			{ user_id: 'u2', value: 'on' }
		]);
		await updateSchedule(t.db, t.env, session, id, { title_template: 'Different {{count}}' });
		expect((await readScheduleConsent(t.db, 'u1', id)).my_future_permission).toMatchObject({
			value: 'off',
			epoch: 1
		});
		expect((await readScheduleConsent(t.db, 'u2', id)).my_future_permission).toMatchObject({
			value: 'off',
			epoch: 1
		});
		expect(
			t.all(
				`SELECT user_id, value FROM issue_personal_choice WHERE issue_id = ? ORDER BY user_id`,
				second
			)
		).toEqual([
			{ user_id: 'u1', value: 'off' },
			{ user_id: 'u2', value: 'unset' }
		]);
		await deleteSchedule(t.db, t.env, session, id);
		expect(
			t.all(
				`SELECT user_id, value FROM issue_personal_choice WHERE issue_id = ? ORDER BY user_id`,
				second
			)
		).toEqual([
			{ user_id: 'u1', value: 'off' },
			{ user_id: 'u2', value: 'unset' }
		]);
	});

	it('workflow initial-state changes reset following schedule permission atomically', async () => {
		const t = fixture();
		t.sqlite.exec(`INSERT INTO workflow
			(id, user_id, name, description, initial_state_id, created_at, updated_at)
			VALUES ('wf_custom', 'u1', 'Custom', '', 'state_a', ${now}, ${now});
			INSERT INTO workflow_state (id, workflow_id, name, category, position, created_at)
			VALUES ('state_a', 'wf_custom', 'A', 'active', 0, ${now}),
				('state_b', 'wf_custom', 'B', 'active', 1, ${now});`);
		const first = await createIssue(t.db, t.env, session, TEST_NOOP_DISPATCH_EFFECTS, 'prj_1', {
			title: 'Follow {{count}}',
			workflow_id: 'wf_custom',
			allow_my_agents: false,
			schedule: { cron: '0 9 * * *', allow_my_agents_on_future_instances: true }
		});
		const second = await runScheduleNow(
			t.db,
			t.env,
			session,
			TEST_NOOP_DISPATCH_EFFECTS,
			first.schedule!.id
		);
		await updateWorkflow(t.db, t.env, session, TEST_NOOP_DISPATCH_EFFECTS, 'wf_custom', {
			initial_state: 'B',
			states: [
				{ id: 'state_a', name: 'A', category: 'active' },
				{ id: 'state_b', name: 'B', category: 'active' }
			],
			transitions: []
		});
		expect(
			(await readScheduleConsent(t.db, 'u1', first.schedule!.id)).my_future_permission
		).toMatchObject({ value: 'on', epoch: 1 });
		expect(inherited(t, second)[0].value).toBe('unset');
	});

	it('a pinned start-state category change resets that schedule permission', async () => {
		const t = fixture();
		t.sqlite.exec(`INSERT INTO workflow
			(id, user_id, name, description, initial_state_id, created_at, updated_at)
			VALUES ('wf_custom', 'u1', 'Custom', '', 'state_a', ${now}, ${now});
			INSERT INTO workflow_state (id, workflow_id, name, category, position, created_at)
			VALUES ('state_a', 'wf_custom', 'A', 'active', 0, ${now}),
				('state_b', 'wf_custom', 'B', 'active', 1, ${now});`);
		const first = await createIssue(t.db, t.env, session, TEST_NOOP_DISPATCH_EFFECTS, 'prj_1', {
			title: 'Pinned {{count}}',
			workflow_id: 'wf_custom',
			state: 'B',
			allow_my_agents: false,
			schedule: { cron: '0 9 * * *', allow_my_agents_on_future_instances: true }
		});
		const second = await runScheduleNow(
			t.db,
			t.env,
			session,
			TEST_NOOP_DISPATCH_EFFECTS,
			first.schedule!.id
		);
		await updateWorkflow(t.db, t.env, session, TEST_NOOP_DISPATCH_EFFECTS, 'wf_custom', {
			states: [
				{ id: 'state_a', name: 'A', category: 'active' },
				{ id: 'state_b', name: 'B', category: 'done' }
			],
			transitions: []
		});
		expect(
			(await readScheduleConsent(t.db, 'u1', first.schedule!.id)).my_future_permission
		).toMatchObject({ value: 'on', epoch: 1 });
		expect(inherited(t, second)[0].value).toBe('unset');
	});

	it('moving future instances to another workflow resets schedule permission', async () => {
		const t = fixture();
		t.sqlite.exec(`INSERT INTO workflow
			(id, user_id, name, description, initial_state_id, created_at, updated_at)
			VALUES ('wf_other', 'u1', 'Other', '', 'state_other', ${now}, ${now});
			INSERT INTO workflow_state (id, workflow_id, name, category, position, created_at)
			VALUES ('state_other', 'wf_other', 'Start', 'active', 0, ${now});`);
		const first = await initial(t, true);
		const second = await runScheduleNow(
			t.db,
			t.env,
			session,
			TEST_NOOP_DISPATCH_EFFECTS,
			first.schedule!.id
		);
		await updateSchedule(t.db, t.env, session, first.schedule!.id, { workflow_id: 'wf_other' });
		expect(
			(await readScheduleConsent(t.db, 'u1', first.schedule!.id)).my_future_permission
		).toMatchObject({ value: 'on', epoch: 1 });
		expect(inherited(t, second)[0].value).toBe('unset');
	});

	it('saves off while archived without unarchiving or admitting work', async () => {
		const t = fixture();
		const first = await initial(t, true);
		t.sqlite.prepare(`UPDATE project SET archived_at = ? WHERE id = 'prj_1'`).run(now + 1);
		const receipt = await writeScheduleConsent(t.db, t.env, session, first.schedule!.id, {
			value: 'off',
			expected_revision: 1,
			permission_epoch: 0
		});
		expect(receipt).toMatchObject({
			readiness: 'archived',
			my_future_permission: { value: 'off' }
		});
		expect(t.all(`SELECT archived_at FROM project WHERE id = 'prj_1'`)).toEqual([
			{ archived_at: now + 1 }
		]);
	});

	it('a done initial issue receives no issue approval while future permission can be on', async () => {
		const t = fixture();
		const first = await createIssue(t.db, t.env, session, TEST_NOOP_DISPATCH_EFFECTS, 'prj_1', {
			title: 'Done first {{count}}',
			state: 'Closed',
			schedule: { cron: '0 9 * * *', allow_my_agents_on_future_instances: true }
		});
		expect(inherited(t, first.id)).toEqual([]);
		expect(
			(await readScheduleConsent(t.db, 'u1', first.schedule!.id)).my_future_permission.value
		).toBe('on');
	});

	it('projects only active members and intersects key reads with stored policy', async () => {
		const t = fixture();
		t.sqlite.exec(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
			VALUES ('u2', 'member', 'member@example.test', 1, ${now}, ${now}),
				('u3', 'outsider', 'outsider@example.test', 1, ${now}, ${now});
			INSERT INTO project_member (project_id, user_id, revision, joined_at, updated_at)
			VALUES ('prj_1', 'u2', 1, ${now}, ${now});`);
		const first = await initial(t);
		const scheduleId = first.schedule!.id;
		t.sqlite
			.prepare(
				`INSERT INTO schedule_personal_choice
			(schedule_id,user_id,value,revision,permission_epoch,membership_revision,updated_at)
			VALUES (?,'u2','on',1,0,1,?)`
			)
			.run(scheduleId, now);
		const memberActor = { ...session, userId: 'u2', userName: 'member' };
		const summary = await readSharedScheduleSummary(t.db, memberActor, scheduleId);
		expect(summary.my_future_permission).toMatchObject({ value: 'on', revision: 1 });
		expect(summary.roster.map((entry) => [entry.role, entry.user.id])).toEqual([
			['owner', 'u1'],
			['member', 'u2']
		]);
		await expect(
			readSharedScheduleSummary(
				t.db,
				{ ...memberActor, viaSession: false, apiKeyId: 'key_2' },
				scheduleId
			)
		).rejects.toMatchObject({ status: 404 });
		expect(
			(
				await readSharedScheduleSummary(
					t.db,
					{ ...memberActor, viaSession: false, apiKeyId: 'key_2' },
					scheduleId,
					async () => true
				)
			).my_future_permission.value
		).toBe('on');
		await expect(
			readSharedScheduleSummary(t.db, { ...session, userId: 'u3' }, scheduleId)
		).rejects.toMatchObject({ status: 404 });
		const second = await runScheduleNow(
			t.db,
			t.env,
			session,
			TEST_NOOP_DISPATCH_EFFECTS,
			scheduleId
		);
		expect(
			t.all(`SELECT user_id, source_kind FROM issue_personal_choice WHERE issue_id = ?`, second)
		).toEqual([{ user_id: 'u2', source_kind: 'schedule' }]);
		t.sqlite
			.prepare(
				`UPDATE project_member SET revoked_at = ?, revision = revision + 1
			WHERE project_id='prj_1' AND user_id='u2'`
			)
			.run(now + 1);
		const third = await runScheduleNow(
			t.db,
			t.env,
			session,
			TEST_NOOP_DISPATCH_EFFECTS,
			scheduleId
		);
		expect(inherited(t, third)).toEqual([]);
	});

	it('completion and reopen clear one instance without changing future permission', async () => {
		const t = fixture();
		const first = await initial(t, true);
		const second = await runScheduleNow(
			t.db,
			t.env,
			session,
			TEST_NOOP_DISPATCH_EFFECTS,
			first.schedule!.id
		);
		const receipt = await readIssueConsent(t.db, 'u1', second);
		await transitionIssue(t.db, t.env, session, TEST_NOOP_DISPATCH_EFFECTS, second, {
			transition_id: 'wft_std_open_closed',
			expected_state_id: receipt.issue_state.id,
			expected_decision_revision: receipt.issue_state.decision_revision,
			expected_workflow_revision: receipt.issue_state.workflow_revision,
			expected_consent_revision: receipt.my_agents.revision,
			expected_consent_epoch: receipt.my_agents.epoch
		});
		expect(inherited(t, second)[0]).toMatchObject({ value: 'unset', source_kind: null });
		expect(
			(await readScheduleConsent(t.db, 'u1', first.schedule!.id)).my_future_permission.value
		).toBe('on');
		await updateIssue(t.db, t.env, session, TEST_NOOP_DISPATCH_EFFECTS, second, {
			state: 'wfs_std_open'
		});
		expect(inherited(t, second)[0].value).toBe('unset');
		const third = await runScheduleNow(
			t.db,
			t.env,
			session,
			TEST_NOOP_DISPATCH_EFFECTS,
			first.schedule!.id
		);
		expect(inherited(t, third)[0]).toMatchObject({ value: 'on', source_kind: 'schedule' });
	});
});
