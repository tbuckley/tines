import type { APIRequestContext } from '@playwright/test';
import type {
	IssueConsentReceipt,
	IssueDetail,
	Project,
	RunnerTokenResponse,
	Schedule
} from '@tines/shared';
import { expect, test } from './fixtures';
import { ALICE, BOB, CAROL, BASE_URL, RUNROW, RUNROW_FAILED } from './constants.mjs';
import { d1, sqlLiteral } from './d1';
import {
	apiClient,
	body,
	clickUntil,
	errorBody,
	fireSweep,
	gotoHydrated,
	signIn,
	signedSessionCookie
} from './helpers';

const sessionHeaders = {
	cookie: `better-auth.session_token=${signedSessionCookie(ALICE.sessionToken)}`,
	origin: BASE_URL
};

test.describe('native D1 first sharing order', () => {
	test('a competing first invite converts once and the losing invite retries in shared mode', async ({
		request,
		uniqueName
	}) => {
		const api = apiClient(request, ALICE.apiKey);
		const project = await body<Project>(
			await api.post('/api/v1/projects', { name: uniqueName('conversion-race') })
		);
		const response = await request.post(`/api/v1/projects/${project.id}/invitations`, {
			headers: {
				authorization: `Bearer ${ALICE.apiKey}`,
				'x-tines-e2e-membership-race': 'preempt-conversion',
				'x-tines-e2e-other-email': CAROL.email
			},
			data: { email: BOB.email, confirm_sharing: true, expected_sharing_revision: 0 }
		});
		const bob = await body<{ id: string; delivery_status: string }>(response);
		expect(bob.delivery_status).toBe('sent');
		expect(
			d1<{ email: string }>(
				`SELECT email FROM project_invitation WHERE project_id=${sqlLiteral(project.id)} ORDER BY email`
			)
		).toEqual([{ email: BOB.email }, { email: CAROL.email }]);
		expect(
			d1<{ sharing_revision: number }>(
				`SELECT sharing_revision FROM project WHERE id=${sqlLiteral(project.id)}`
			)
		).toEqual([{ sharing_revision: 1 }]);
		expect(
			d1<{ n: number }>(
				`SELECT COUNT(*) AS n FROM event WHERE project_id=${sqlLiteral(project.id)} AND type='project.sharing_started'`
			)
		).toEqual([{ n: 1 }]);
	});

	test('a failed conversion commits no invitation or sharing side effects', async ({
		request,
		uniqueName
	}) => {
		const api = apiClient(request, ALICE.apiKey);
		const project = await body<Project>(
			await api.post('/api/v1/projects', { name: uniqueName('failed-conversion') })
		);
		const response = await request.post(`/api/v1/projects/${project.id}/invitations`, {
			headers: {
				authorization: `Bearer ${ALICE.apiKey}`,
				'x-tines-e2e-membership-race': 'stale-conversion'
			},
			data: { email: BOB.email, confirm_sharing: true, expected_sharing_revision: 0 }
		});
		expect(response.status()).toBe(409);
		expect(
			d1<{ shared_at: number | null }>(
				`SELECT shared_at FROM project WHERE id=${sqlLiteral(project.id)}`
			)
		).toEqual([{ shared_at: null }]);
		expect(
			d1<{ n: number }>(
				`SELECT COUNT(*) AS n FROM project_invitation WHERE project_id=${sqlLiteral(project.id)}`
			)
		).toEqual([{ n: 0 }]);
		expect(
			d1<{ n: number }>(
				`SELECT COUNT(*) AS n FROM event WHERE project_id=${sqlLiteral(project.id)} AND type='project.sharing_started'`
			)
		).toEqual([{ n: 0 }]);
	});

	test('creation before conversion is included in the reset; assigned work stops and admitted work drains', async ({
		request,
		uniqueName
	}) => {
		const api = apiClient(request, ALICE.apiKey);
		const project = await body<Project>(
			await api.post('/api/v1/projects', { name: uniqueName('create-convert') })
		);
		const existing = await body<IssueDetail>(
			await api.post(`/api/v1/projects/${project.id}/issues`, {
				title: 'Already queued'
			})
		);
		const now = Date.now();
		const assigned = `arun_convert_assigned_${now}`;
		const running = `arun_convert_running_${now}`;
		for (const [id, status, admitted] of [
			[assigned, 'assigned', 'NULL'],
			[running, 'running', String(now)]
		]) {
			d1(`INSERT INTO agent_run (id,user_id,issue_id,runner_id,status,tier,log,created_at,admitted_at,state_id_at_start)
				VALUES (${sqlLiteral(id)},${sqlLiteral(ALICE.id)},${sqlLiteral(existing.id)},${sqlLiteral(RUNROW_FAILED.runnerId)},
				${sqlLiteral(status)},'balanced','',${now},${admitted},${sqlLiteral(existing.state.id)})`);
		}
		const invite = await body<{ id: string }>(
			await request.post(`/api/v1/projects/${project.id}/invitations`, {
				headers: {
					authorization: `Bearer ${ALICE.apiKey}`,
					'x-tines-e2e-membership-race': 'create-before-conversion'
				},
				data: { email: BOB.email, confirm_sharing: true, expected_sharing_revision: 0 }
			})
		);
		expect(invite.id).toBeTruthy();
		const created = d1<{ id: string }>(
			`SELECT id FROM issue WHERE project_id=${sqlLiteral(project.id)} AND title='Created at conversion boundary'`
		);
		expect(created).toHaveLength(1);
		expect(
			d1<{ n: number }>(
				`SELECT COUNT(*) AS n FROM issue_personal_choice WHERE issue_id=${sqlLiteral(created[0].id)} AND value='on'`
			)
		).toEqual([{ n: 0 }]);
		expect(
			d1<{ status: string }>(`SELECT status FROM agent_run WHERE id=${sqlLiteral(assigned)}`)
		).toEqual([{ status: 'canceled' }]);
		expect(
			d1<{ status: string }>(`SELECT status FROM agent_run WHERE id=${sqlLiteral(running)}`)
		).toEqual([{ status: 'running' }]);
		expect(
			d1<{ attempt_count: number }>(
				`SELECT attempt_count FROM issue WHERE id=${sqlLiteral(existing.id)}`
			)
		).toEqual([{ attempt_count: 0 }]);
		const after = await body<IssueDetail>(
			await api.post(`/api/v1/projects/${project.id}/issues`, {
				title: 'Created after conversion'
			})
		);
		expect(
			d1<{ n: number }>(
				`SELECT COUNT(*) AS n FROM issue_personal_choice WHERE issue_id=${sqlLiteral(after.id)} AND value='on'`
			)
		).toEqual([{ n: 0 }]);
	});
});

test('native D1 removal after member read work begins discards its response and cancels only that member', async ({
	request,
	uniqueName
}) => {
	const owner = apiClient(request, ALICE.apiKey);
	const project = await body<Project>(
		await owner.post('/api/v1/projects', { name: uniqueName('removal-race') })
	);
	const issue = await body<IssueDetail>(
		await owner.post(`/api/v1/projects/${project.id}/issues`, { title: 'Private after removal' })
	);
	const invite = await body<{ id: string }>(
		await owner.post(`/api/v1/projects/${project.id}/invitations`, {
			email: BOB.email,
			confirm_sharing: true,
			expected_sharing_revision: 0
		})
	);
	const url = (
		await body<{ url: string }>(await request.get(`/api/v1/__e2e/invitation-email/${invite.id}`))
	).url;
	await body(
		await request.post('/api/v1/invitations/accept', {
			headers: {
				cookie: `better-auth.session_token=${signedSessionCookie(BOB.sessionToken)}`,
				origin: BASE_URL
			},
			data: { token: url.split('/').at(-1) }
		})
	);
	const now = Date.now();
	const assigned = `arun_member_assigned_${now}`;
	const running = `arun_member_running_${now}`;
	for (const [id, status, admitted] of [
		[assigned, 'assigned', 'NULL'],
		[running, 'running', String(now)]
	]) {
		d1(`INSERT INTO agent_run (id,user_id,issue_id,runner_id,status,tier,log,created_at,admitted_at,state_id_at_start)
			VALUES (${sqlLiteral(id)},${sqlLiteral(BOB.id)},${sqlLiteral(issue.id)},${sqlLiteral(RUNROW_FAILED.runnerId)},
			${sqlLiteral(status)},'balanced','',${now},${admitted},${sqlLiteral(issue.state.id)})`);
	}
	const before = await request.get(`/api/v1/issues/${issue.id}`, {
		headers: { authorization: `Bearer ${BOB.apiKey}` }
	});
	expect(before.status()).toBe(200);
	const losingRead = await request.get(`/api/v1/issues/${issue.id}`, {
		headers: {
			authorization: `Bearer ${BOB.apiKey}`,
			'x-tines-e2e-membership-race': 'remove-before-return'
		}
	});
	expect(losingRead.status()).toBe(404);
	expect(
		(
			await request.get(`/api/v1/issues/${issue.id}`, {
				headers: { authorization: `Bearer ${BOB.apiKey}` }
			})
		).status()
	).toBe(404);
	expect(
		d1<{ revision: number; revoked_at: number | null }>(
			`SELECT revision,revoked_at FROM project_member WHERE project_id=${sqlLiteral(project.id)} AND user_id=${sqlLiteral(BOB.id)}`
		)
	).toMatchObject([{ revision: 2, revoked_at: expect.any(Number) }]);
	expect(
		d1<{ status: string }>(`SELECT status FROM agent_run WHERE id=${sqlLiteral(assigned)}`)
	).toEqual([{ status: 'canceled' }]);
	expect(
		d1<{ status: string; cancel_requested_at: number | null }>(
			`SELECT status,cancel_requested_at FROM agent_run WHERE id=${sqlLiteral(running)}`
		)
	).toMatchObject([{ status: 'running', cancel_requested_at: expect.any(Number) }]);
});

async function setup(request: APIRequestContext, name: string) {
	const key = apiClient(request, ALICE.apiKey);
	const project = await body<Project>(await key.post('/api/v1/projects', { name }));
	d1(
		`UPDATE project SET shared_at = ${Date.now()}, sharing_revision = 1 WHERE id = ${sqlLiteral(project.id)}`
	);
	const create = (title: string) =>
		request.post(`/api/v1/projects/${project.id}/issues`, {
			headers: sessionHeaders,
			data: { title }
		});
	return { key, project, create };
}

function choice(issueId: string) {
	return d1<{ value: string; revision: number; issue_epoch: number }>(
		`SELECT value, revision, issue_epoch FROM issue_personal_choice WHERE issue_id = ${sqlLiteral(issueId)}`
	)[0];
}

async function recurringFixture(request: APIRequestContext, name: string) {
	const fixture = await setup(request, name);
	const initial = await body<IssueDetail & { schedule: Schedule }>(
		await request.post(`/api/v1/projects/${fixture.project.id}/issues`, {
			headers: sessionHeaders,
			data: {
				title: `${name} {{count}}`,
				allow_my_agents: false,
				schedule: {
					preset: { kind: 'daily', time: '09:00' },
					allow_my_agents_on_future_instances: true
				}
			}
		})
	);
	return { ...fixture, initial, schedule: initial.schedule };
}

function instanceChoice(issueId: string) {
	return d1<{ value: string; source_kind: string | null; source_grant_revision: number | null }>(
		`SELECT value, source_kind, source_grant_revision FROM issue_personal_choice
		WHERE issue_id=${sqlLiteral(issueId)}`
	)[0];
}

test.describe.serial('native D1 future schedule permission ordering', () => {
	test('phone browser keeps initial and future controls separate, then saves the future switch', async ({
		request,
		page,
		uniqueName
	}) => {
		const f = await setup(request, uniqueName('future-phone'));
		await signIn(page.context(), ALICE.sessionToken);
		await page.setViewportSize({ width: 390, height: 844 });
		await gotoHydrated(page, `/projects/${f.project.id}`);
		const dialog = page.getByRole('dialog', { name: /New issue/ });
		await clickUntil(page.getByRole('button', { name: 'New issue' }), async () => {
			await expect(dialog).toBeVisible({ timeout: 2_000 });
		});
		await dialog.getByLabel('Title', { exact: true }).fill('Phone recurring {{count}}');
		await dialog.getByRole('button', { name: 'Repeat' }).click();
		await dialog.locator('#issue-repeat-kind').selectOption('daily');
		await expect(dialog.getByLabel('Allow my agents on this issue')).toBeChecked();
		const future = dialog.getByLabel('Allow my agents on future issues from this schedule');
		// The owner's future permission defaults on (owner default, 2026-09-24).
		await expect(future).toBeChecked();
		await dialog.getByRole('button', { name: 'Create issue + schedule' }).click();
		await expect(dialog).toBeHidden();
		await expect(page.getByTestId('schedule-origin')).toContainText('Phone recurring {{count}}');
		const row = d1<{ id: string }>(
			`SELECT id FROM scheduled_task WHERE project_id=${sqlLiteral(f.project.id)}`
		)[0];
		await gotoHydrated(page, `/projects/${f.project.id}`);
		const toggle = page.getByRole('switch', {
			name: 'Allow my agents on future issues from Phone recurring {{count}}'
		});
		await expect(toggle).toBeChecked();
		// A click rather than uncheck(): the switch shows the saved value, so it
		// reads checked again while the save is in flight.
		await toggle.click();
		await expect(toggle).not.toBeChecked();
		await expect(toggle).toBeEnabled();
		expect(
			d1<{ value: string }>(
				`SELECT value FROM schedule_personal_choice WHERE schedule_id=${sqlLiteral(row.id)}`
			)
		).toEqual([{ value: 'off' }]);
	});

	test('creation first inherits a live grant; later off revokes only inherited issues', async ({
		request,
		uniqueName
	}) => {
		const f = await recurringFixture(request, uniqueName('future-create-first'));
		expect(instanceChoice(f.initial.id).source_kind).toBe('explicit_issue');
		const next = await body<IssueDetail>(
			await f.key.post(`/api/v1/schedules/${f.schedule.id}/run`)
		);
		expect(instanceChoice(next.id)).toMatchObject({
			value: 'on',
			source_kind: 'schedule',
			source_grant_revision: 1
		});
		const off = await request.put(`/api/v1/schedules/${f.schedule.id}/my-consent`, {
			headers: sessionHeaders,
			data: { value: 'off', expected_revision: 1, permission_epoch: 0 }
		});
		expect(off.ok()).toBe(true);
		// The owner's inherited on becomes an explicit off; unset would mean the owner default.
		expect(instanceChoice(next.id)).toMatchObject({ value: 'off', source_kind: null });
		expect(instanceChoice(f.initial.id)).toMatchObject({
			value: 'off',
			source_kind: 'explicit_issue'
		});
	});

	test('cron reads the current grant without treating its event actor as consent', async ({
		request,
		uniqueName
	}) => {
		const f = await recurringFixture(request, uniqueName('future-cron'));
		const due = () =>
			d1(`UPDATE scheduled_task SET next_run_at=${Date.now() - 60_000}
			WHERE id=${sqlLiteral(f.schedule.id)}`);
		due();
		await fireSweep(request);
		const instances = () =>
			d1<{ id: string }>(
				`SELECT id FROM issue WHERE scheduled_task_id=${sqlLiteral(f.schedule.id)} ORDER BY number`
			);
		expect(instances()).toHaveLength(2);
		expect(instanceChoice(instances()[1].id)).toMatchObject({
			value: 'on',
			source_kind: 'schedule'
		});
		const off = await request.put(`/api/v1/schedules/${f.schedule.id}/my-consent`, {
			headers: sessionHeaders,
			data: { value: 'off', expected_revision: 1, permission_epoch: 0 }
		});
		expect(off.ok()).toBe(true);
		due();
		await fireSweep(request);
		expect(instances()).toHaveLength(3);
		expect(instanceChoice(instances()[2].id)).toMatchObject({
			value: 'off',
			source_kind: 'schedule'
		});
	});

	test('source off releases only assigned inherited work without a strike', async ({
		request,
		uniqueName
	}) => {
		const f = await recurringFixture(request, uniqueName('future-assigned'));
		const next = await body<IssueDetail>(
			await f.key.post(`/api/v1/schedules/${f.schedule.id}/run`)
		);
		const now = Date.now();
		const assigned = `arun_future_assigned_${now}`;
		const admitted = `arun_future_admitted_${now}`;
		for (const [id, status, admittedAt] of [
			[assigned, 'assigned', 'NULL'],
			[admitted, 'running', String(now)]
		]) {
			d1(`INSERT INTO agent_run
				(id,user_id,issue_id,runner_id,status,tier,log,created_at,admitted_at,state_id_at_start)
				VALUES (${sqlLiteral(id)},${sqlLiteral(ALICE.id)},${sqlLiteral(next.id)},
					${sqlLiteral(RUNROW_FAILED.runnerId)},${sqlLiteral(status)},'balanced','',
					${now},${admittedAt},${sqlLiteral(next.state.id)})`);
		}
		const off = await request.put(`/api/v1/schedules/${f.schedule.id}/my-consent`, {
			headers: sessionHeaders,
			data: { value: 'off', expected_revision: 1, permission_epoch: 0 }
		});
		expect(off.ok()).toBe(true);
		expect(
			d1<{ status: string }>(`SELECT status FROM agent_run WHERE id=${sqlLiteral(assigned)}`)
		).toEqual([{ status: 'canceled' }]);
		expect(
			d1<{ status: string }>(`SELECT status FROM agent_run WHERE id=${sqlLiteral(admitted)}`)
		).toEqual([{ status: 'running' }]);
		expect(
			d1<{ attempt_count: number }>(
				`SELECT attempt_count FROM issue WHERE id=${sqlLiteral(next.id)}`
			)
		).toEqual([{ attempt_count: 0 }]);
	});

	test('off committed after preparation but before creation selects no grant', async ({
		request,
		uniqueName
	}) => {
		const f = await recurringFixture(request, uniqueName('future-off-first'));
		const running = request.post(`/api/v1/schedules/${f.schedule.id}/run`, {
			headers: {
				authorization: `Bearer ${ALICE.apiKey}`,
				'x-tines-e2e-schedule-race': 'wait-for-off'
			}
		});
		const off = await request.put(`/api/v1/schedules/${f.schedule.id}/my-consent`, {
			headers: { ...sessionHeaders, 'x-tines-e2e-schedule-race': 'release-run-now' },
			data: { value: 'off', expected_revision: 1, permission_epoch: 0 }
		});
		expect(off.ok()).toBe(true);
		const created = await body<IssueDetail>(await running);
		expect(instanceChoice(created.id)).toMatchObject({ value: 'off', source_kind: 'schedule' });
		expect(
			d1<{ schedule_id: string }>(
				`SELECT schedule_id FROM issue_schedule_origin WHERE issue_id=${sqlLiteral(created.id)}`
			)
		).toEqual([{ schedule_id: f.schedule.id }]);
	});

	for (const action of ['delete', 'meaningful-change'] as const) {
		test(`${action} committed after preparation rejects stale creation`, async ({
			request,
			uniqueName
		}) => {
			const f = await recurringFixture(request, uniqueName(`future-${action}-first`));
			const before = d1<{ n: number }>(
				`SELECT COUNT(*) AS n FROM issue WHERE project_id=${sqlLiteral(f.project.id)}`
			)[0].n;
			const response = await request.post(`/api/v1/schedules/${f.schedule.id}/run`, {
				headers: { authorization: `Bearer ${ALICE.apiKey}`, 'x-tines-e2e-schedule-race': action }
			});
			expect(response.status()).toBe(action === 'delete' ? 404 : 409);
			expect(
				d1<{ n: number }>(
					`SELECT COUNT(*) AS n FROM issue WHERE project_id=${sqlLiteral(f.project.id)}`
				)[0].n
			).toBe(before);
		});
	}
});

test.describe.serial('native D1 owner permission', () => {
	test('browser agent activity saves a choice and an owner hold', async ({
		request,
		page,
		uniqueName
	}) => {
		const fixture = await setup(request, uniqueName('consent-browser'));
		const issue = await body<IssueDetail>(await fixture.create('browser controls'));
		await signIn(page.context(), ALICE.sessionToken);
		await page.setViewportSize({ width: 1440, height: 900 });
		await gotoHydrated(page, `/issues/${encodeURIComponent(fixture.project.name)}/${issue.number}`);
		const mine = page.getByRole('switch', { name: 'Allow my agents', exact: true });
		await expect(mine).toBeChecked();
		await mine.click();
		await expect(mine).not.toBeChecked();
		await page.getByRole('button', { name: 'Hold new work' }).click();
		await expect(page.getByRole('button', { name: 'Release hold' })).toBeVisible();
	});

	test('session creation grants only its owner; key input never writes', async ({
		request,
		uniqueName
	}) => {
		const fixture = await setup(request, uniqueName('consent-create'));
		const before = d1<{ n: number }>(
			`SELECT count(*) AS n FROM issue WHERE project_id = ${sqlLiteral(fixture.project.id)}`
		)[0].n;
		for (const allow_my_agents of [true, false]) {
			const refused = await fixture.key.post(`/api/v1/projects/${fixture.project.id}/issues`, {
				title: 'key refused',
				allow_my_agents
			});
			expect(refused.status()).toBe(403);
			expect((await errorBody(refused)).error.code).toBe('consent_browser_required');
		}
		expect(
			d1<{ n: number }>(
				`SELECT count(*) AS n FROM issue WHERE project_id = ${sqlLiteral(fixture.project.id)}`
			)[0].n
		).toBe(before);
		const created = await body<IssueDetail>(await fixture.create('session owner'));
		expect(choice(created.id)).toMatchObject({ value: 'on', revision: 1, issue_epoch: 0 });
		const keyCreated = await body<IssueDetail>(
			await fixture.key.post(`/api/v1/projects/${fixture.project.id}/issues`, {
				title: 'key omission'
			})
		);
		expect(choice(keyCreated.id)).toBeUndefined();
	});

	test('stale off and structural reset cannot restore permission', async ({
		request,
		uniqueName
	}) => {
		const fixture = await setup(request, uniqueName('consent-reset'));
		const created = await body<IssueDetail>(await fixture.create('reset race'));
		const initial = await body<IssueConsentReceipt>(
			await request.get(`/api/v1/issues/${created.id}/my-consent`, { headers: sessionHeaders })
		);
		const off = () =>
			request.put(`/api/v1/issues/${created.id}/my-consent`, {
				headers: sessionHeaders,
				data: {
					value: 'off',
					expected_revision: initial.my_agents.revision,
					issue_epoch: initial.my_agents.epoch,
					decision_revision: initial.issue_state.decision_revision
				}
			});
		const [a, b] = await Promise.all([off(), off()]);
		expect([a.status(), b.status()].sort()).toEqual([200, 409]);
		expect(choice(created.id)).toMatchObject({ value: 'off', revision: 2 });
		const forced = await fixture.key.patch(`/api/v1/issues/${created.id}`, { state: 'Closed' });
		expect(forced.ok()).toBe(true);
		const after = await body<IssueConsentReceipt>(
			await request.get(`/api/v1/issues/${created.id}/my-consent`, { headers: sessionHeaders })
		);
		expect(after.my_agents.value).toBe('unset');
		expect(after.my_agents.epoch).toBe(1);
		const stale = await off();
		expect(stale.status()).toBe(422);
		expect(choice(created.id)).toMatchObject({ value: 'unset', revision: 3, issue_epoch: 1 });
	});

	test('hold releases assigned without a strike; cancellation keeps admitted slot', async ({
		request,
		uniqueName
	}) => {
		const fixture = await setup(request, uniqueName('consent-run'));
		const issue = await body<IssueDetail>(await fixture.create('run controls'));
		const now = Date.now();
		const assigned = `arun_test_assigned_${now}`;
		const running = `arun_test_running_${now}`;
		for (const [id, runner, status, admitted] of [
			[assigned, RUNROW_FAILED.runnerId, 'assigned', 'NULL'],
			[running, RUNROW.runnerId, 'running', String(now)]
		]) {
			d1(`INSERT INTO agent_run (id,user_id,issue_id,runner_id,status,tier,log,created_at,admitted_at,state_id_at_start)
				VALUES (${sqlLiteral(id)},${sqlLiteral(ALICE.id)},${sqlLiteral(issue.id)},${sqlLiteral(runner)},${sqlLiteral(status)},'balanced','',${now},${admitted},${sqlLiteral(issue.state.id)})`);
		}
		const held = await body<{ released_assigned: number }>(
			await request.put(`/api/v1/issues/${issue.id}/agent-hold`, {
				headers: sessionHeaders,
				data: { held: true, expected_revision: 0 }
			})
		);
		expect(held.released_assigned).toBe(1);
		expect(
			d1<{ status: string }>(`SELECT status FROM agent_run WHERE id = ${sqlLiteral(assigned)}`)[0]
				.status
		).toBe('canceled');
		expect(
			d1<{ attempt_count: number }>(
				`SELECT attempt_count FROM issue WHERE id = ${sqlLiteral(issue.id)}`
			)[0].attempt_count
		).toBe(0);
		const canceled = await fixture.key.post(
			`/api/v1/issues/${issue.id}/runs/${running}/cancel`,
			{}
		);
		expect(canceled.ok()).toBe(true);
		expect(
			d1<{ status: string; cancel_requested_at: number | null }>(
				`SELECT status,cancel_requested_at FROM agent_run WHERE id = ${sqlLiteral(running)}`
			)[0]
		).toMatchObject({ status: 'running', cancel_requested_at: expect.any(Number) });
	});

	test('native claim loses to off before delivery; admitted work keeps its slot until cleanup acknowledgement', async ({
		request,
		uniqueName
	}) => {
		const fixture = await setup(request, uniqueName('consent-admission'));
		const registered = await body<RunnerTokenResponse>(
			await fixture.key.post('/api/v1/runners/register', {
				name: uniqueName('consent-runner'),
				harness: 'custom',
				command: 'true'
			})
		);
		const runner = registered.runner;
		const poll = (data: object) =>
			request.post(`/api/v1/runners/${runner.id}/poll`, {
				headers: { authorization: `Bearer ${registered.runner_token}` },
				data: {
					max_concurrent: 1,
					concurrency_control: { version: 1, allow_remote: false, ceiling: 1 },
					...data
				}
			});
		const boot = `consent_${runner.id}`;
		const rule = await fixture.key.post('/api/v1/routing-rules', {
			project_id: fixture.project.id,
			targets: [{ runner_id: runner.id }]
		});
		expect(rule.status()).toBe(201);
		try {
			expect((await poll({ instance_id: boot, owned_runs: [] })).ok()).toBe(true);
			expect((await fixture.key.put('/api/v1/supervisor/settings', { enabled: true })).ok()).toBe(
				true
			);
			const beforeDelivery = await body<IssueDetail>(await fixture.create('off wins'));
			await fireSweep(request);
			const assigned = d1<{ id: string; status: string }>(
				`SELECT id,status FROM agent_run WHERE issue_id = ${sqlLiteral(beforeDelivery.id)}`
			)[0];
			expect(assigned?.status).toBe('assigned');
			const beforeReceipt = await body<IssueConsentReceipt>(
				await request.get(`/api/v1/issues/${beforeDelivery.id}/my-consent`, {
					headers: sessionHeaders
				})
			);
			expect(
				(
					await request.put(`/api/v1/issues/${beforeDelivery.id}/my-consent`, {
						headers: sessionHeaders,
						data: {
							value: 'off',
							expected_revision: beforeReceipt.my_agents.revision,
							issue_epoch: beforeReceipt.my_agents.epoch,
							decision_revision: beforeReceipt.issue_state.decision_revision
						}
					})
				).ok()
			).toBe(true);
			expect(
				d1<{ status: string }>(
					`SELECT status FROM agent_run WHERE id = ${sqlLiteral(assigned.id)}`
				)[0].status
			).toBe('canceled');
			const stalePoll = await body<{ assignments: unknown[] }>(
				await poll({ instance_id: boot, owned_runs: [] })
			);
			expect(stalePoll.assignments).toEqual([]);
			const admittedIssue = await body<IssueDetail>(await fixture.create('delivery wins'));
			await fireSweep(request);
			const delivered = await body<{ assignments: { run: { id: string } }[] }>(
				await poll({ instance_id: boot, owned_runs: [] })
			);
			expect(delivered.assignments).toHaveLength(1);
			const admittedRun = delivered.assignments[0].run.id;
			const admitted = d1<{
				status: string;
				admitted_at: number | null;
				admission_evidence: string | null;
			}>(
				`SELECT status,admitted_at,admission_evidence FROM agent_run WHERE id = ${sqlLiteral(admittedRun)}`
			)[0];
			expect(admitted.status).toBe('launching');
			expect(admitted.admitted_at).toEqual(expect.any(Number));
			expect(admitted.admission_evidence).toBeTruthy();
			const admittedReceipt = await body<IssueConsentReceipt>(
				await request.get(`/api/v1/issues/${admittedIssue.id}/my-consent`, {
					headers: sessionHeaders
				})
			);
			await request.put(`/api/v1/issues/${admittedIssue.id}/my-consent`, {
				headers: sessionHeaders,
				data: {
					value: 'off',
					expected_revision: admittedReceipt.my_agents.revision,
					issue_epoch: admittedReceipt.my_agents.epoch,
					decision_revision: admittedReceipt.issue_state.decision_revision
				}
			});
			expect(
				d1<{ status: string }>(
					`SELECT status FROM agent_run WHERE id = ${sqlLiteral(admittedRun)}`
				)[0].status
			).toBe('launching');
			expect(
				(
					await fixture.key.post(
						`/api/v1/issues/${admittedIssue.id}/runs/${admittedRun}/cancel`,
						{}
					)
				).ok()
			).toBe(true);
			const requestPoll = await body<{
				cancel_requests?: { run_id: string; token: string }[];
			}>(await poll({ instance_id: boot, owned_runs: [admittedRun] }));
			const cancellation = requestPoll.cancel_requests?.find((item) => item.run_id === admittedRun);
			expect(cancellation?.token).toBeTruthy();
			const beforeAck = d1<{
				status: string;
				admitted_daemon_instance_id: string | null;
				cancellation_token: string | null;
				cancel_requested_at: number | null;
			}>(
				`SELECT status,admitted_daemon_instance_id,cancellation_token,cancel_requested_at FROM agent_run WHERE id = ${sqlLiteral(admittedRun)}`
			)[0];
			expect(beforeAck).toMatchObject({
				status: 'launching',
				admitted_daemon_instance_id: boot,
				cancellation_token: cancellation?.token,
				cancel_requested_at: expect.any(Number)
			});
			const ack = await body<{ cancellation_acks?: { run_id: string; token: string }[] }>(
				await poll({
					instance_id: boot,
					owned_runs: [],
					cancellation_acks: [cancellation]
				})
			);
			expect(ack.cancellation_acks).toContainEqual(cancellation);
			expect(
				d1<{ status: string }>(
					`SELECT status FROM agent_run WHERE id = ${sqlLiteral(admittedRun)}`
				)[0].status
			).toBe('canceled');
		} finally {
			await fixture.key.put('/api/v1/supervisor/settings', { enabled: false });
			await fixture.key.delete(`/api/v1/routing-rules/${(await body<{ id: string }>(rule)).id}`);
			await fixture.key.delete(`/api/v1/runners/${runner.id}`);
		}
	});
});
