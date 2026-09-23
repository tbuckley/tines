import { expect, test } from './fixtures';
import { ALICE, BOB, BASE_URL } from './constants.mjs';
import { apiClient, body, gotoHydrated, signIn, signedSessionCookie } from './helpers';
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
	const project = await body<{ id: string }>(
		await owner.post('/api/v1/projects', { name: uniqueName('member-decisions') })
	);
	const workflow = await body<{ id: string }>(
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
	await page.getByRole('button', { name: 'Save permission' }).click();
	await expect(
		page.getByText('Permission saved. Member execution is not available in this release.')
	).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('member-phone.png'), fullPage: true });
	await page.setViewportSize({ width: 390, height: 560 });
	await expect(page.getByRole('button', { name: 'Save permission' })).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('member-small-phone.png'), fullPage: true });
	await page.getByLabel('Transition').selectOption({ label: 'Start' });
	await page.getByRole('button', { name: 'Apply decision' }).click();
	await expect(page.getByText(/#\d+ · Working/)).toBeVisible();
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.reload();
	await expect(page.getByText('Latest run')).toBeVisible();
	await expect(page.getByText('No run yet')).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('member-desktop.png'), fullPage: true });
	await gotoHydrated(page, `/projects/${project.id}`);
	await page.getByLabel('My agents on future instances').selectOption('on');
	await page.getByRole('button', { name: 'Save future permission' }).click();
	await expect(
		page.getByText('Future permission saved. Member execution is not available in this release.')
	).toBeVisible();
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
	const response = await request.put(`/api/v1/issues/${issue.id}/my-consent`, {
		headers: { ...headers, 'x-tines-e2e-member-race': 'revoke-before-choice' },
		data: { value: 'on', expected_revision: 0, issue_epoch: 0, decision_revision: 0 }
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
});
