import type { APIRequestContext } from '@playwright/test';
import type { IssueConsentReceipt, IssueDetail, Project } from '@tines/shared';
import { expect, test } from './fixtures';
import { ALICE, BASE_URL, RUNROW, RUNROW_FAILED } from './constants.mjs';
import { d1, sqlLiteral } from './d1';
import { apiClient, body, errorBody, gotoHydrated, signIn, signedSessionCookie } from './helpers';

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
});
