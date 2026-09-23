import type { APIRequestContext } from '@playwright/test';
import type { IssueConsentReceipt, IssueDetail, Project, RunnerTokenResponse } from '@tines/shared';
import { expect, test } from './fixtures';
import { ALICE, BASE_URL, RUNROW, RUNROW_FAILED } from './constants.mjs';
import { d1, sqlLiteral } from './d1';
import {
	apiClient,
	body,
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
		await expect(page.getByText('My agent permission: on')).toBeVisible();
		await page.getByRole('button', { name: 'Turn off' }).click();
		await expect(page.getByText('My agent permission: off')).toBeVisible();
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
