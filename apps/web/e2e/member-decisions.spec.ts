import { expect, test } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { ALICE, BOB, BASE_URL, DANA, RUNROW } from './constants.mjs';
import { apiClient, body, clickToOpen, gotoHydrated, signIn, signedSessionCookie } from './helpers';
import { d1, sqlLiteral } from './d1';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI_DIR = fileURLToPath(new URL('../../../packages/cli/', import.meta.url));
function cli(...args: string[]) {
	return execFileSync('pnpm', ['exec', 'tsx', 'src/index.ts', ...args], {
		cwd: CLI_DIR,
		env: { ...process.env, TINES_API_URL: BASE_URL, TINES_API_KEY: BOB.apiKey },
		encoding: 'utf8'
	});
}

test('member phone and desktop decisions stay attributed, personal, and unavailable for execution', async ({
	request,
	page,
	browser,
	uniqueName
}, testInfo) => {
	const owner = apiClient(request, ALICE.apiKey);
	const project = await body<{ id: string; name: string }>(
		await owner.post('/api/v1/projects', { name: uniqueName('member-decisions') })
	);
	const workflow = await body<{ id: string; states: { id: string; name: string }[] }>(
		await owner.post('/api/v1/workflows', {
			name: uniqueName('member-workflow'),
			initial_state: 'Working',
			states: [
				{ name: 'Review', category: 'awaiting_human' },
				{ name: 'Working', category: 'active' }
			],
			transitions: [
				{ name: 'Review', from: 'Working', to: 'Review' },
				{ name: 'Start', from: 'Review', to: 'Working' }
			]
		})
	);
	const issue = await body<{ id: string; number: number }>(
		await owner.post(`/api/v1/projects/${project.id}/issues`, {
			title: 'Member decision journey',
			workflow_id: workflow.id
		})
	);
	await body(await owner.post(`/api/v1/issues/${issue.id}/transition`, { action: 'Review' }));
	const cliIssue = await body<{ id: string; number: number }>(
		await owner.post(`/api/v1/projects/${project.id}/issues`, {
			title: 'CLI member decision',
			workflow_id: workflow.id
		})
	);
	await body(await owner.post(`/api/v1/issues/${cliIssue.id}/transition`, { action: 'Review' }));
	const scheduleIssue = await body<{ schedule: { id: string } }>(
		await owner.post(`/api/v1/projects/${project.id}/issues`, {
			title: 'Future member work {{count}}',
			schedule: { preset: { kind: 'daily', time: '09:00' } }
		})
	);
	const invite = await body<{ id: string }>(
		await owner.post(`/api/v1/projects/${project.id}/invitations`, {
			email: BOB.email,
			confirm_sharing: true,
			expected_sharing_revision: 0
		})
	);
	const sink = await body<{ url: string }>(
		await request.get(`/api/v1/__e2e/invitation-email/${invite.id}`)
	);
	const memberHeaders = {
		cookie: `better-auth.session_token=${signedSessionCookie(BOB.sessionToken)}`,
		origin: BASE_URL
	};
	await body(
		await request.post('/api/v1/invitations/accept', {
			headers: memberHeaders,
			data: { token: sink.url.split('/').at(-1) }
		})
	);
	const otherOwner = apiClient(request, DANA.apiKey);
	const sameNameProject = await body<{ id: string }>(
		await otherOwner.post('/api/v1/projects', { name: project.name })
	);
	const sameNameInvite = await body<{ id: string }>(
		await otherOwner.post(`/api/v1/projects/${sameNameProject.id}/invitations`, {
			email: BOB.email,
			confirm_sharing: true,
			expected_sharing_revision: 0
		})
	);
	const sameNameSink = await body<{ url: string }>(
		await request.get(`/api/v1/__e2e/invitation-email/${sameNameInvite.id}`)
	);
	await body(
		await request.post('/api/v1/invitations/accept', {
			headers: memberHeaders,
			data: { token: sameNameSink.url.split('/').at(-1) }
		})
	);
	const scoped = await body<{ key: string }>(
		await request.post('/api/v1/api-keys', {
			headers: { authorization: `Bearer ${BOB.apiKey}` },
			data: {
				name: uniqueName('zero-scope-consent'),
				permissions: {
					version: 1,
					projects: { access: 'read', scope: [] },
					workspace: 'none',
					control_plane: 'none'
				}
			}
		})
	);
	for (const path of [
		`/api/v1/issues/${issue.id}/my-consent`,
		`/api/v1/schedules/${scheduleIssue.schedule.id}/my-consent`
	]) {
		expect(
			(await request.get(path, { headers: { authorization: `Bearer ${scoped.key}` } })).status()
		).toBe(403);
		expect(
			(await request.get(path, { headers: { authorization: `Bearer ${RUNROW.runKey}` } })).status()
		).toBe(403);
		expect(
			(await request.get(path, { headers: { authorization: `Bearer ${BOB.apiKey}` } })).status()
		).toBe(200);
	}
	const hiddenTime = Date.now() + 10_000;
	const hiddenEvents = Array.from(
		{ length: 101 },
		(_, index) =>
			`('evt_hidden_669_${index}_${project.id}', ${sqlLiteral(ALICE.id)}, 'runner.updated', ${sqlLiteral(ALICE.id)}, ${sqlLiteral(issue.id)}, ${sqlLiteral(project.id)}, '{"private":"SECRET_HISTORY_CANARY"}', ${hiddenTime + index})`
	);
	d1(
		`INSERT INTO event (id,user_id,type,actor_user_id,issue_id,project_id,payload,created_at) VALUES ${hiddenEvents.join(',')}`
	);
	const sharedHistory = await body<{
		history: { id: string; type: string; actor_name: string; payload: unknown }[];
	}>(await request.get(`/api/v1/issues/${issue.id}`, { headers: memberHeaders }));
	expect(
		sharedHistory.history.some(
			(event) => event.type === 'issue.created' && event.actor_name === ALICE.name
		)
	).toBe(true);
	expect(JSON.stringify(sharedHistory.history)).not.toContain('SECRET_HISTORY_CANARY');
	d1(
		`UPDATE event SET created_at=${Date.now() - 100_000} WHERE issue_id=${sqlLiteral(issue.id)} AND type='runner.updated' AND id LIKE 'evt_hidden_669_%'`
	);
	for (const value of ['on', 'off']) {
		const refused = await request.put(`/api/v1/issues/${issue.id}/my-consent`, {
			headers: { authorization: `Bearer ${BOB.apiKey}`, origin: BASE_URL },
			data: { value, expected_revision: 0, issue_epoch: 0, decision_revision: 1 }
		});
		expect(refused.status()).toBe(403);
	}
	expect(
		d1<{ n: number }>(
			`SELECT COUNT(*) AS n FROM issue_personal_choice WHERE issue_id=${sqlLiteral(issue.id)} AND user_id=${sqlLiteral(BOB.id)}`
		)
	).toEqual([{ n: 0 }]);
	expect(cli('issues', 'move', `${project.id}/${cliIssue.number}`, 'Start')).toContain(
		'Review → Working'
	);
	expect(
		d1<{ n: number }>(
			`SELECT COUNT(*) AS n FROM issue_personal_choice WHERE issue_id=${sqlLiteral(cliIssue.id)} AND user_id=${sqlLiteral(BOB.id)}`
		)
	).toEqual([{ n: 0 }]);
	await signIn(page.context(), BOB.sessionToken);
	await page.setViewportSize({ width: 390, height: 844 });
	await gotoHydrated(page, `/issues/${project.id}/${issue.number}`);
	await expect(page.getByRole('heading', { name: 'Member decision journey' })).toBeVisible();
	await expect(page.getByText(`${BOB.name} (You)`, { exact: false })).toBeVisible();
	await page.getByRole('textbox', { name: 'New comment' }).fill('Member note');
	await page.getByRole('button', { name: 'Post comment' }).click();
	await expect(page.getByText('Member note')).toBeVisible();
	await page.getByLabel('My agents on this issue').selectOption('on');
	await expect(page.getByRole('note', { name: 'First permission warning' })).toContainText(
		'including after member execution is released'
	);
	await page.getByRole('button', { name: 'Save permission' }).click();
	await expect(
		page.getByText('Permission saved. Member execution is not available in this release.')
	).toBeVisible();
	await expect(page.getByRole('note', { name: 'First permission warning' })).toHaveCount(0);
	await expect(page.getByText(/This evolving issue may use your agents/)).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('member-phone.png'), fullPage: true });
	await page.setViewportSize({ width: 390, height: 560 });
	await expect(page.getByRole('button', { name: 'Save permission' })).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('member-small-phone.png'), fullPage: true });
	await page.getByLabel('Transition').selectOption({ label: 'Start' });
	await page.getByRole('button', { name: 'Apply decision' }).click();
	await expect(page.getByText(/#\d+ · Working/)).toBeVisible();
	const decision = d1<{ id: string; created_at: number }>(
		`SELECT id,created_at FROM event WHERE issue_id=${sqlLiteral(issue.id)} AND type='issue.transitioned' AND actor_user_id=${sqlLiteral(BOB.id)} ORDER BY created_at DESC LIMIT 1`
	)[0];
	const decisionEvent = decision.id;
	await expect(page.locator(`[data-event-id="${decisionEvent}"]`)).toContainText(BOB.name);
	const allowedEvents = Array.from(
		{ length: 51 },
		(_, index) =>
			`('evt_allowed_669_${index}_${project.id}', ${sqlLiteral(ALICE.id)}, 'issue.updated', ${sqlLiteral(ALICE.id)}, ${sqlLiteral(issue.id)}, ${sqlLiteral(project.id)}, '{}', ${decision.created_at - 1_000 - index})`
	);
	d1(
		`INSERT INTO event (id,user_id,type,actor_user_id,issue_id,project_id,payload,created_at) VALUES ${allowedEvents.join(',')}`
	);
	await gotoHydrated(page, `/activity?project=${project.id}`);
	await expect(page.locator(`[data-event-id="${decisionEvent}"]`)).toContainText(BOB.name);
	await expect(
		page.locator(
			`[data-event-id="${decisionEvent}"] a[href="/issues/${project.id}/${issue.number}"]`
		)
	).toBeVisible();
	await expect(page.getByRole('button', { name: 'Load more' })).toBeVisible();
	await page.getByRole('button', { name: 'Load more' }).click();
	await expect(page.locator(`[data-event-id="evt_allowed_669_50_${project.id}"]`)).toBeVisible();
	await page.getByLabel('Filter by event type').selectOption('issue.transitioned');
	await expect(page.locator(`[data-event-id="${decisionEvent}"]`)).toBeVisible();
	await expect(page.locator(`[data-event-id="evt_allowed_669_0_${project.id}"]`)).toHaveCount(0);
	await page.setViewportSize({ width: 1440, height: 900 });
	await gotoHydrated(page, `/issues/${project.id}/${issue.number}`);
	await expect(page.getByText('Latest run')).toBeVisible();
	await expect(page.getByText('No run yet')).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('member-desktop.png'), fullPage: true });
	await gotoHydrated(page, `/projects/${project.id}`);
	d1(`DELETE FROM personal_disclosure WHERE user_id=${sqlLiteral(BOB.id)}`);
	await page.reload();
	d1(`CREATE TRIGGER trg_669_ack_failure BEFORE INSERT ON personal_disclosure
		WHEN NEW.user_id=${sqlLiteral(BOB.id)} BEGIN SELECT RAISE(ABORT, 'ack failure'); END`);
	try {
		const failed = await request.put(`/api/v1/schedules/${scheduleIssue.schedule.id}/my-consent`, {
			headers: memberHeaders,
			data: { value: 'on', expected_revision: 0, permission_epoch: 0, disclosure_version: 1 }
		});
		expect(failed.ok()).toBe(false);
		expect(
			d1<{ n: number }>(
				`SELECT COUNT(*) AS n FROM schedule_personal_choice WHERE schedule_id=${sqlLiteral(scheduleIssue.schedule.id)} AND user_id=${sqlLiteral(BOB.id)}`
			)
		).toEqual([{ n: 0 }]);
		expect(
			d1<{ n: number }>(
				`SELECT COUNT(*) AS n FROM personal_disclosure WHERE user_id=${sqlLiteral(BOB.id)}`
			)
		).toEqual([{ n: 0 }]);
	} finally {
		d1('DROP TRIGGER trg_669_ack_failure');
	}
	await page.getByLabel('My agents on future instances').selectOption('on');
	await expect(page.getByRole('note', { name: 'First permission warning' })).toContainText(
		'including after member execution is released'
	);
	await page.getByRole('button', { name: 'Save future permission' }).click();
	await expect(
		page.getByText('Future permission saved. Member execution is not available in this release.')
	).toBeVisible();
	expect(
		d1<{ version: number }>(
			`SELECT version FROM personal_disclosure WHERE user_id=${sqlLiteral(BOB.id)}`
		)
	).toEqual([{ version: 1 }]);
	await page.screenshot({ path: testInfo.outputPath('member-schedule.png'), fullPage: true });
	await gotoHydrated(page, '/agents');
	await expect(page.getByRole('link', { name: /Member decision journey/ })).toHaveCount(0);
	const ownerContext = await browser.newContext({
		viewport: { width: 390, height: 844 },
		baseURL: BASE_URL
	});
	try {
		await signIn(ownerContext, ALICE.sessionToken);
		const ownerPage = await ownerContext.newPage();
		await gotoHydrated(ownerPage, `/issues/${project.id}/${issue.number}`);
		await expect(ownerPage.getByText('Member note')).toBeVisible();
		await expect(ownerPage.getByLabel('Issue permission roster')).toContainText(ALICE.name);
		await expect(ownerPage.getByLabel('Issue permission roster')).toContainText(
			`${BOB.name} · member · on · member execution unavailable`
		);
		await expect(ownerPage.locator(`[data-event-id="${decisionEvent}"]`)).toContainText(BOB.name);
		await ownerPage.screenshot({ path: testInfo.outputPath('owner-phone.png'), fullPage: true });
		await ownerPage.setViewportSize({ width: 1440, height: 900 });
		await ownerPage.reload();
		await expect(ownerPage.getByText('Member note')).toBeVisible();
		await ownerPage.screenshot({ path: testInfo.outputPath('owner-desktop.png'), fullPage: true });
	} finally {
		await ownerContext.close();
	}
	const events = d1<{ id: string; user_id: string; actor_user_id: string }>(
		`SELECT id,user_id,actor_user_id FROM event WHERE issue_id=${sqlLiteral(issue.id)} AND actor_user_id=${sqlLiteral(BOB.id)}`
	);
	expect(events.length).toBeGreaterThan(0);
	expect(
		events.every((entry) => entry.user_id === ALICE.id && entry.actor_user_id === BOB.id)
	).toBe(true);
	expect(
		d1<{ n: number }>(`SELECT COUNT(*) AS n FROM agent_run WHERE issue_id=${sqlLiteral(issue.id)}`)
	).toEqual([{ n: 0 }]);
	expect(
		d1<{ value: string }>(
			`SELECT value FROM schedule_personal_choice WHERE schedule_id=${sqlLiteral(scheduleIssue.schedule.id)} AND user_id=${sqlLiteral(BOB.id)}`
		)
	).toEqual([{ value: 'on' }]);
	const roster = await body<{ members: { id: string; revision: number }[] }>(
		await owner.get(`/api/v1/projects/${project.id}/people`)
	);
	await body(
		await owner.delete(`/api/v1/projects/${project.id}/members/${BOB.id}`, {
			expected_revision: roster.members.find((person) => person.id === BOB.id)!.revision
		})
	);
	const otherRoster = await body<{ members: { id: string; revision: number }[] }>(
		await otherOwner.get(`/api/v1/projects/${sameNameProject.id}/people`)
	);
	await body(
		await otherOwner.delete(`/api/v1/projects/${sameNameProject.id}/members/${BOB.id}`, {
			expected_revision: otherRoster.members.find((person) => person.id === BOB.id)!.revision
		})
	);
	const eventCount = d1<{ n: number }>(
		`SELECT COUNT(*) AS n FROM event WHERE issue_id=${sqlLiteral(issue.id)}`
	)[0].n;
	expect(
		(
			await request.post(`/api/v1/issues/${issue.id}/comments`, {
				headers: memberHeaders,
				data: { body: 'after removal' }
			})
		).status()
	).toBe(404);
	expect(
		(
			await request.put(`/api/v1/issues/${issue.id}/my-consent`, {
				headers: memberHeaders,
				data: { value: 'off', expected_revision: 2, issue_epoch: 0, decision_revision: 2 }
			})
		).status()
	).toBe(404);
	expect(
		d1<{ n: number }>(`SELECT COUNT(*) AS n FROM event WHERE issue_id=${sqlLiteral(issue.id)}`)
	).toEqual([{ n: eventCount }]);
});

test('owner create and transition show full first warning, then a shorter repeat reminder', async ({
	request,
	page,
	uniqueName
}) => {
	const owner = apiClient(request, ALICE.apiKey);
	const project = await body<{ id: string; name: string }>(
		await owner.post('/api/v1/projects', { name: uniqueName('disclosure-owner') })
	);
	const workflow = await body<{ id: string; states: { id: string; name: string }[] }>(
		await owner.post('/api/v1/workflows', {
			name: uniqueName('disclosure-flow'),
			initial_state: 'Working',
			states: [
				{ name: 'Working', category: 'active' },
				{ name: 'Review', category: 'awaiting_human' }
			],
			transitions: [
				{ name: 'Review', from: 'Working', to: 'Review' },
				{ name: 'Start', from: 'Review', to: 'Working' }
			]
		})
	);
	await body(
		await owner.post(`/api/v1/projects/${project.id}/invitations`, {
			email: BOB.email,
			confirm_sharing: true,
			expected_sharing_revision: 0
		})
	);
	d1(`DELETE FROM personal_disclosure WHERE user_id=${sqlLiteral(ALICE.id)}`);
	await signIn(page.context(), ALICE.sessionToken);
	await page.setViewportSize({ width: 390, height: 844 });
	await gotoHydrated(page, `/projects/${project.id}`);
	const dialog = page.getByRole('dialog', { name: `New issue in ${project.name}` });
	await clickToOpen(page.getByRole('button', { name: 'New issue' }), dialog);
	await dialog.getByLabel('Workflow', { exact: true }).selectOption(workflow.id);
	await dialog.getByLabel('Title', { exact: true }).fill('Owner disclosure');
	await expect(dialog.getByRole('note', { name: 'First permission warning' })).toContainText(
		'including after member execution is released'
	);
	await dialog.getByRole('button', { name: 'Create issue' }).click();
	await expect(page).toHaveURL(/\/issues\/.*\/\d+$/);
	expect(
		d1<{ version: number }>(
			`SELECT version FROM personal_disclosure WHERE user_id=${sqlLiteral(ALICE.id)}`
		)
	).toEqual([{ version: 1 }]);
	await gotoHydrated(page, `/projects/${project.id}`);
	await clickToOpen(page.getByRole('button', { name: 'New issue' }), dialog);
	await expect(dialog.getByRole('note', { name: 'First permission warning' })).toHaveCount(0);
	await expect(dialog.getByText(/This evolving issue may use your agents/)).toBeVisible();
	await dialog.getByRole('button', { name: 'Close' }).click();
	const reviewState = workflow.states.find((state) => state.name === 'Review')!;
	const reviewIssue = await body<{ id: string; number: number }>(
		await owner.post(`/api/v1/projects/${project.id}/issues`, {
			title: 'Owner transition disclosure',
			workflow_id: workflow.id,
			state: reviewState.id
		})
	);
	d1(`DELETE FROM personal_disclosure WHERE user_id=${sqlLiteral(ALICE.id)}`);
	await gotoHydrated(page, `/issues/${project.id}/${reviewIssue.number}`);
	await page.getByRole('button', { name: 'Start', exact: true }).click();
	const transition = page.getByRole('dialog', { name: 'Start → Working' });
	await expect(transition.getByRole('note', { name: 'First permission warning' })).toContainText(
		'including after member execution is released'
	);
});

test('native D1 removal wins after member choice preparation without a grant or event', async ({
	request,
	uniqueName
}) => {
	const owner = apiClient(request, ALICE.apiKey);
	const project = await body<{ id: string }>(
		await owner.post('/api/v1/projects', { name: uniqueName('member-choice-race') })
	);
	const issue = await body<{ id: string }>(
		await owner.post(`/api/v1/projects/${project.id}/issues`, { title: 'Race target' })
	);
	const invite = await body<{ id: string }>(
		await owner.post(`/api/v1/projects/${project.id}/invitations`, {
			email: BOB.email,
			confirm_sharing: true,
			expected_sharing_revision: 0
		})
	);
	const sink = await body<{ url: string }>(
		await request.get(`/api/v1/__e2e/invitation-email/${invite.id}`)
	);
	const headers = {
		cookie: `better-auth.session_token=${signedSessionCookie(BOB.sessionToken)}`,
		origin: BASE_URL
	};
	await body(
		await request.post('/api/v1/invitations/accept', {
			headers,
			data: { token: sink.url.split('/').at(-1) }
		})
	);
	const before = d1<{ n: number }>(
		`SELECT COUNT(*) AS n FROM event WHERE issue_id=${sqlLiteral(issue.id)}`
	)[0].n;
	d1(`DELETE FROM personal_disclosure WHERE user_id=${sqlLiteral(BOB.id)}`);
	const response = await request.put(`/api/v1/issues/${issue.id}/my-consent`, {
		headers: { ...headers, 'x-tines-e2e-member-race': 'revoke-before-choice' },
		data: {
			value: 'on',
			expected_revision: 0,
			issue_epoch: 0,
			decision_revision: 0,
			disclosure_version: 1
		}
	});
	expect(response.status()).toBe(409);
	expect(
		d1<{ n: number }>(
			`SELECT COUNT(*) AS n FROM issue_personal_choice WHERE issue_id=${sqlLiteral(issue.id)} AND user_id=${sqlLiteral(BOB.id)}`
		)
	).toEqual([{ n: 0 }]);
	expect(
		d1<{ n: number }>(`SELECT COUNT(*) AS n FROM event WHERE issue_id=${sqlLiteral(issue.id)}`)
	).toEqual([{ n: before }]);
	expect((await request.get(`/api/v1/issues/${issue.id}`, { headers })).status()).toBe(404);
	expect(
		d1<{ n: number }>(
			`SELECT COUNT(*) AS n FROM personal_disclosure WHERE user_id=${sqlLiteral(BOB.id)}`
		)
	).toEqual([{ n: 0 }]);
});

async function memberWriteFixture(request: APIRequestContext, name: string) {
	const owner = apiClient(request, ALICE.apiKey);
	const project = await body<{ id: string }>(await owner.post('/api/v1/projects', { name }));
	const destination = await body<{ id: string }>(
		await owner.post('/api/v1/projects', { name: `${name}-destination` })
	);
	const workflow = await body<{ id: string }>(
		await owner.post('/api/v1/workflows', {
			name: `${name}-workflow`,
			initial_state: 'Working',
			states: [
				{ name: 'Review', category: 'awaiting_human' },
				{ name: 'Working', category: 'active' }
			],
			transitions: [
				{ name: 'Review', from: 'Working', to: 'Review' },
				{ name: 'Start', from: 'Review', to: 'Working' }
			]
		})
	);
	const issue = await body<{ id: string }>(
		await owner.post(`/api/v1/projects/${project.id}/issues`, {
			title: 'Member race target',
			workflow_id: workflow.id
		})
	);
	await body(await owner.post(`/api/v1/issues/${issue.id}/transition`, { action: 'Review' }));
	const invite = await body<{ id: string }>(
		await owner.post(`/api/v1/projects/${project.id}/invitations`, {
			email: BOB.email,
			confirm_sharing: true,
			expected_sharing_revision: 0
		})
	);
	const sink = await body<{ url: string }>(
		await request.get(`/api/v1/__e2e/invitation-email/${invite.id}`)
	);
	const headers = {
		cookie: `better-auth.session_token=${signedSessionCookie(BOB.sessionToken)}`,
		origin: BASE_URL
	};
	await body(
		await request.post('/api/v1/invitations/accept', {
			headers,
			data: { token: sink.url.split('/').at(-1) }
		})
	);
	return { owner, project, destination, workflow, issue, headers };
}

type MemberDecisionWitness = {
	state: { id: string };
	decision_revision: number;
	workflow_revision: number;
	my_choice: { revision: number; epoch: number };
	workflow: { transitions: { id: string }[] };
};

test('native D1 member writes obey current access and exact decisions in both winner orders', async ({
	request,
	uniqueName
}) => {
	test.setTimeout(180_000);
	for (const kind of ['comment', 'decision'] as const) {
		for (const action of ['remove', 'archive', 'transfer', 'workflow-reset'] as const) {
			if (kind === 'comment' && action === 'workflow-reset') continue;
			for (const winner of ['predicate', 'write'] as const) {
				const f = await memberWriteFixture(request, uniqueName(`${kind}-${action}-${winner}`));
				const before = d1<{ n: number }>(
					`SELECT COUNT(*) AS n FROM event WHERE issue_id=${sqlLiteral(f.issue.id)}`
				)[0].n;
				const witness = await body<MemberDecisionWitness>(
					await request.get(`/api/v1/issues/${f.issue.id}`, { headers: f.headers })
				);
				const requestHeaders = {
					...f.headers,
					...(winner === 'predicate'
						? {
								'x-tines-e2e-member-write-race': action,
								'x-tines-e2e-member-race-target': f.destination.id
							}
						: {})
				};
				const write = () =>
					kind === 'comment'
						? request.post(`/api/v1/issues/${f.issue.id}/comments`, {
								headers: requestHeaders,
								data: { body: `Race comment ${winner}` }
							})
						: request.post(`/api/v1/issues/${f.issue.id}/transition`, {
								headers: requestHeaders,
								data: {
									transition_id: witness.workflow.transitions[0].id,
									expected_state_id: witness.state.id,
									expected_decision_revision: witness.decision_revision,
									expected_consent_revision: witness.my_choice.revision,
									expected_consent_epoch: witness.my_choice.epoch,
									expected_workflow_revision: witness.workflow_revision
								}
							});
				const response = await write();
				if (winner === 'predicate') {
					expect(response.status(), `${kind}/${action} lost`).toBe(kind === 'comment' ? 404 : 409);
					expect(
						d1<{ n: number }>(
							`SELECT COUNT(*) AS n FROM event WHERE issue_id=${sqlLiteral(f.issue.id)}`
						)[0].n
					).toBe(before);
					expect(
						d1<{ n: number }>(
							`SELECT COUNT(*) AS n FROM comment WHERE issue_id=${sqlLiteral(f.issue.id)} AND body LIKE 'Race comment%'`
						)[0].n
					).toBe(0);
					if (kind === 'decision') {
						expect(
							d1<{ id: string }>(
								`SELECT state_id AS id FROM issue WHERE id=${sqlLiteral(f.issue.id)}`
							)[0].id
						).toBe(witness.state.id);
					}
				} else {
					expect(response.ok(), `${kind}/${action} won`).toBe(true);
					expect(
						d1<{ n: number }>(
							`SELECT COUNT(*) AS n FROM event WHERE issue_id=${sqlLiteral(f.issue.id)}`
						)[0].n
					).toBeGreaterThan(before);
					const target = sqlLiteral(f.issue.id);
					switch (action) {
						case 'remove':
							d1(
								`UPDATE project_member SET revoked_at=${Date.now()}, revision=revision+1 WHERE project_id=${sqlLiteral(f.project.id)} AND user_id=${sqlLiteral(BOB.id)}`
							);
							break;
						case 'archive':
							d1(
								`UPDATE project SET archived_at=${Date.now()} WHERE id=${sqlLiteral(f.project.id)}`
							);
							break;
						case 'transfer':
							d1(
								`UPDATE issue SET project_id=${sqlLiteral(f.destination.id)}, decision_revision=decision_revision+1 WHERE id=${target}`
							);
							break;
						case 'workflow-reset':
							d1(
								`UPDATE workflow SET decision_revision=decision_revision+1 WHERE id=${sqlLiteral(f.workflow.id)}`
							);
							break;
					}
				}
			}
		}
	}
});

test('native D1 owner hold does not rewrite a member decision or admit their agents', async ({
	request,
	uniqueName
}) => {
	const f = await memberWriteFixture(request, uniqueName('member-hold'));
	const before = await body<MemberDecisionWitness>(
		await request.get(`/api/v1/issues/${f.issue.id}`, { headers: f.headers })
	);
	const decision = await request.post(`/api/v1/issues/${f.issue.id}/transition`, {
		headers: { ...f.headers, 'x-tines-e2e-member-write-race': 'hold' },
		data: {
			transition_id: before.workflow.transitions[0].id,
			expected_state_id: before.state.id,
			expected_decision_revision: before.decision_revision,
			expected_consent_revision: before.my_choice.revision,
			expected_consent_epoch: before.my_choice.epoch,
			expected_workflow_revision: before.workflow_revision
		}
	});
	expect(decision.ok()).toBe(true);
	expect(
		d1<{ agent_hold: number }>(`SELECT agent_hold FROM issue WHERE id=${sqlLiteral(f.issue.id)}`)
	).toEqual([{ agent_hold: 1 }]);
	expect(
		d1<{ n: number }>(
			`SELECT COUNT(*) AS n FROM agent_run WHERE issue_id=${sqlLiteral(f.issue.id)}`
		)
	).toEqual([{ n: 0 }]);
	expect(
		(
			await request.post(`/api/v1/issues/${f.issue.id}/comments`, {
				headers: { ...f.headers, 'x-tines-e2e-member-write-race': 'workflow-reset' },
				data: { body: 'Comment after workflow revision' }
			})
		).status()
	).toBe(201);
	const second = await memberWriteFixture(request, uniqueName('member-decision-before-hold'));
	const witness = await body<MemberDecisionWitness>(
		await request.get(`/api/v1/issues/${second.issue.id}`, { headers: second.headers })
	);
	expect(
		(
			await request.post(`/api/v1/issues/${second.issue.id}/transition`, {
				headers: second.headers,
				data: {
					transition_id: witness.workflow.transitions[0].id,
					expected_state_id: witness.state.id,
					expected_decision_revision: witness.decision_revision,
					expected_consent_revision: witness.my_choice.revision,
					expected_consent_epoch: witness.my_choice.epoch,
					expected_workflow_revision: witness.workflow_revision
				}
			})
		).ok()
	).toBe(true);
	expect(
		(
			await second.owner.put(`/api/v1/issues/${second.issue.id}/agent-hold`, {
				held: true,
				expected_revision: 0
			})
		).ok()
	).toBe(true);
	expect(
		d1<{ n: number }>(
			`SELECT COUNT(*) AS n FROM agent_run WHERE issue_id=${sqlLiteral(second.issue.id)}`
		)
	).toEqual([{ n: 0 }]);
});
