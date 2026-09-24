import { expect, test } from './fixtures';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ALICE, BOB, BASE_URL } from './constants.mjs';
import { apiClient, body, gotoHydrated, signIn } from './helpers';

// A quiet, readable fixture for reviewing the member UI. Unlike the mutation
// journey, it never injects bulk history or captures a page mid-interaction.
test('shared project pages use the app UI at desktop, phone, and 320px', async ({
	request,
	browser
}) => {
	test.setTimeout(120_000);
	const owner = apiClient(request, ALICE.apiKey);
	const project = await body<{ id: string }>(
		await owner.post('/api/v1/projects', {
			name: 'Shared release plan',
			description: 'Coordinate the next release together.'
		})
	);
	const workflow = await body<{ id: string }>(
		await owner.post('/api/v1/workflows', {
			name: 'Release review',
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
			title: 'Approve the release checklist',
			description:
				'Review the **release checklist** and decide whether the team can start.\n\n- Confirm the changelog\n- Check the rollout plan',
			workflow_id: workflow.id
		})
	);
	await body(
		await owner.post(`/api/v1/issues/${issue.id}/comments`, {
			body: '**The checklist** is ready for review.'
		})
	);
	await body(await owner.post(`/api/v1/issues/${issue.id}/transition`, { action: 'Review' }));
	await body(
		await owner.post(`/api/v1/projects/${project.id}/issues`, {
			title: 'Daily release follow-up',
			schedule: { preset: { kind: 'daily', time: '09:00' } }
		})
	);
	const invite = await body<{ id: string }>(
		await owner.post(`/api/v1/projects/${project.id}/invitations`, {
			email: BOB.email,
			confirm_sharing: true,
			expected_sharing_revision: 0,
			landing_issue_id: issue.id
		})
	);
	const sink = await body<{ url: string }>(
		await request.get(`/api/v1/__e2e/invitation-email/${invite.id}`)
	);
	const captureDir = process.env.CAPTURE_REVIEW_DIR;
	if (captureDir) mkdirSync(captureDir, { recursive: true });
	async function capture(page: import('@playwright/test').Page, name: string) {
		if (captureDir) await page.screenshot({ path: join(captureDir, `${name}.png`) });
	}
	const memberContext = await browser.newContext({
		baseURL: BASE_URL,
		viewport: { width: 1280, height: 900 }
	});
	const ownerContext = await browser.newContext({
		baseURL: BASE_URL,
		viewport: { width: 1280, height: 900 }
	});
	try {
		await signIn(memberContext, BOB.sessionToken);
		await signIn(ownerContext, ALICE.sessionToken);
		const memberPage = await memberContext.newPage();
		const ownerPage = await ownerContext.newPage();
		await gotoHydrated(memberPage, sink.url);
		await expect(
			memberPage.getByRole('heading', { name: 'Join Shared release plan' })
		).toBeVisible();
		await capture(memberPage, 'invitation-desktop');
		await memberPage.setViewportSize({ width: 390, height: 844 });
		await capture(memberPage, 'invitation-phone');
		await memberPage.getByRole('button', { name: 'Join project' }).click();
		await expect(
			memberPage.getByRole('heading', { name: 'Approve the release checklist' })
		).toBeVisible();
		await memberPage.setViewportSize({ width: 1280, height: 900 });
		await gotoHydrated(memberPage, `/issues/${project.id}/${issue.number}`);
		await memberPage.getByLabel('My agents on this issue').selectOption('on');
		await memberPage.getByRole('button', { name: 'Save permission' }).click();
		await expect(
			memberPage.getByText('Permission saved. Member execution is not available in this release.')
		).toBeVisible();
		await memberPage.reload();
		await expect(memberPage.getByText('The checklist is ready for review.')).toBeVisible();
		await expect(memberPage.locator('.markdown strong').getByText('The checklist')).toBeVisible();
		await expect(
			memberPage.locator('[data-event-id]').filter({ hasText: 'allowed their agents' })
		).toHaveCount(1);
		await capture(memberPage, 'issue-member-desktop');
		await memberPage.setViewportSize({ width: 390, height: 844 });
		await memberPage.evaluate(() => window.scrollTo(0, 0));
		await capture(memberPage, 'issue-member-phone-top');
		await memberPage
			.getByRole('heading', { name: 'People and permission' })
			.scrollIntoViewIfNeeded();
		await memberPage.evaluate(() => {
			const heading = document.getElementById('people-heading');
			if (heading) window.scrollBy(0, heading.getBoundingClientRect().top - 90);
		});
		await capture(memberPage, 'issue-member-phone-permission');
		await memberPage.setViewportSize({ width: 320, height: 700 });
		await memberPage.evaluate(() => window.scrollTo(0, 0));
		await expect
			.poll(() =>
				memberPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
			)
			.toBe(true);
		await capture(memberPage, 'issue-member-320');
		await memberPage.setViewportSize({ width: 1280, height: 900 });
		await gotoHydrated(memberPage, `/projects/${project.id}`);
		await expect(memberPage.getByRole('heading', { name: 'Shared release plan' })).toBeVisible();
		await capture(memberPage, 'project-member-desktop');
		if (captureDir)
			await memberPage
				.locator('[aria-labelledby="schedules-heading"]')
				.screenshot({ path: join(captureDir, 'schedule-permission-desktop.png') });
		await gotoHydrated(memberPage, `/projects/${project.id}/people`);
		await capture(memberPage, 'people-member-desktop');
		await gotoHydrated(memberPage, '/issues');
		await capture(memberPage, 'issues-member-desktop');
		await gotoHydrated(memberPage, '/activity');
		await expect(memberPage.getByText('allowed their agents on', { exact: false })).toBeVisible();
		await capture(memberPage, 'activity-member-desktop');
		await gotoHydrated(ownerPage, `/projects/${project.id}/people`);
		await capture(ownerPage, 'people-owner-desktop');
		await gotoHydrated(ownerPage, `/issues/${project.id}/${issue.number}`);
		await expect(ownerPage.getByText('The checklist is ready for review.')).toBeVisible();
		await capture(ownerPage, 'issue-owner-desktop');
		const agentCard = ownerPage.getByRole('heading', { name: 'Agent activity' }).locator('..');
		await expect(agentCard).not.toContainText('Member agents cannot run');
		await agentCard.scrollIntoViewIfNeeded();
		await ownerPage.evaluate(() => {
			const heading = Array.from(document.querySelectorAll('h2')).find(
				(node) => node.textContent?.trim() === 'Agent activity'
			);
			if (heading) window.scrollBy(0, heading.getBoundingClientRect().top - 90);
		});
		await capture(ownerPage, 'agent-activity-owner-desktop');
		await gotoHydrated(ownerPage, `/activity?project=${project.id}`);
		await expect(ownerPage.getByText('allowed their agents on', { exact: false })).toBeVisible();
		await capture(ownerPage, 'activity-owner-desktop');
		await gotoHydrated(ownerPage, `/issues/${project.id}/${issue.number}`);
		await ownerPage.setViewportSize({ width: 390, height: 844 });
		await ownerPage.evaluate(() => window.scrollTo(0, 0));
		await capture(ownerPage, 'issue-owner-phone-top');
	} finally {
		await memberContext.close();
		await ownerContext.close();
	}
});
