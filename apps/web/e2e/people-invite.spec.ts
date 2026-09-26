import { expect, test } from './fixtures';
import type { Page, Request } from '@playwright/test';
import { ALICE } from './constants.mjs';
import { apiClient, body, gotoHydrated, signIn } from './helpers';

const invitePost = (projectId: string) => (r: Request) =>
	r.method() === 'POST' && r.url().endsWith(`/api/v1/projects/${projectId}/invitations`);

async function setup(page: Page, request: Parameters<typeof apiClient>[0], name: string) {
	const owner = apiClient(request, ALICE.apiKey);
	const project = await body<{ id: string }>(await owner.post('/api/v1/projects', { name }));
	const workflow = await body<{ id: string }>(
		await owner.post('/api/v1/workflows', {
			name: `${name} flow`,
			initial_state: 'Working',
			states: [
				{ name: 'Working', category: 'active' },
				{ name: 'Done', category: 'done' }
			],
			transitions: [{ name: 'Finish', from: 'Working', to: 'Done' }]
		})
	);
	const create = (title: string) =>
		owner
			.post(`/api/v1/projects/${project.id}/issues`, { title, workflow_id: workflow.id })
			.then((r) => body<{ id: string; number: number }>(r));
	const issue1 = await create('Launch checklist');
	const issue2 = await create('Pricing page copy');
	const issue3 = await create('Old retro');
	await body(await owner.post(`/api/v1/issues/${issue3.id}/transition`, { action: 'Finish' }));
	await signIn(page.context(), ALICE.sessionToken);
	await gotoHydrated(page, `/projects/${project.id}/people`);
	return { project, issue1, issue2, issue3 };
}

test('the invite landing issue is picked by number or title, and errors sit under their fields', async ({
	page,
	request,
	uniqueName
}) => {
	const { project, issue1, issue2, issue3 } = await setup(
		page,
		request,
		uniqueName('people-invite')
	);
	const landing = page.getByRole('combobox', { name: 'Landing issue (optional)' });
	const email = page.getByLabel('Verified email');
	const listbox = page.getByRole('listbox');
	const send = page.getByRole('button', { name: 'Send invitation' });

	await test.step('empty focus lists the newest open issues, not done ones', async () => {
		await landing.focus();
		await expect(listbox.getByRole('option')).toHaveText([
			`#${issue2.number} Pricing page copy`,
			`#${issue1.number} Launch checklist`
		]);
	});

	await test.step('pick by title sends that issue id, then resets', async () => {
		await email.fill('invitee-767-title@example.com');
		await landing.fill('pricing');
		await listbox.getByRole('option', { name: /Pricing page copy/ }).click();
		await expect(landing).toHaveValue(`#${issue2.number} Pricing page copy`);
		await page.getByRole('checkbox').check();
		const posted = page.waitForRequest(invitePost(project.id));
		await send.click();
		expect((await posted).postDataJSON().landing_issue_id).toBe(issue2.id);
		await expect(page.getByRole('status')).toHaveText('Invitation sent.');
		await expect(landing).toHaveValue('');
	});

	await test.step('pick by number with Enter', async () => {
		await email.fill('invitee-767-number@example.com');
		await landing.fill(`#${issue1.number}`);
		await expect(listbox.getByRole('option').first()).toContainText('Launch checklist');
		await landing.press('Enter');
		await expect(landing).toHaveValue(`#${issue1.number} Launch checklist`);
		const posted = page.waitForRequest(invitePost(project.id));
		await send.click();
		expect((await posted).postDataJSON().landing_issue_id).toBe(issue1.id);
		await expect(landing).toHaveValue('');
	});

	await test.step('a done issue is not offered by number', async () => {
		await landing.fill(`#${issue3.number}`);
		await expect(listbox).toContainText('No open issues match');
		await page.getByRole('button', { name: 'Clear landing issue' }).click();
		await expect(landing).toHaveValue('');
	});

	await test.step('an empty field sends no landing issue', async () => {
		await email.fill('invitee-767-empty@example.com');
		const posted = page.waitForRequest(invitePost(project.id));
		await send.click();
		expect((await posted).postDataJSON()).not.toHaveProperty('landing_issue_id');
		await expect(page.getByRole('status')).toHaveText('Invitation sent.');
	});

	await test.step('unpicked text is blocked before any request', async () => {
		let posts = 0;
		page.on('request', (r) => {
			if (invitePost(project.id)(r)) posts++;
		});
		await email.fill('invitee-767-blocked@example.com');
		await landing.fill('xyz');
		await expect(listbox).toContainText('No open issues match');
		await send.click();
		await expect(page.locator('#invite-landing-error')).toHaveText(
			'Choose an issue from the list, or clear this field.'
		);
		await expect(landing).toHaveAttribute('aria-invalid', 'true');
		await expect(landing).toBeFocused();
		await page.waitForTimeout(300);
		expect(posts).toBe(0);
		await page.getByRole('button', { name: 'Clear landing issue' }).click();
		await expect(page.locator('#invite-landing-error')).toHaveCount(0);
	});

	await test.step('an email error sits under the email field', async () => {
		await email.fill('invitee-767-empty@example.com');
		await send.click();
		await expect(page.locator('#invite-email-error')).toContainText('pending');
		await expect(email).toHaveAttribute('aria-invalid', 'true');
		await expect(page.getByRole('status')).toHaveCount(0);
		await email.fill('invitee-767-other@example.com');
		await expect(page.locator('#invite-email-error')).toHaveCount(0);
	});

	await test.step('a landing error from the server sits under the landing field', async () => {
		await page.route(`**/api/v1/projects/${project.id}/invitations`, (route) =>
			route.fulfill({
				status: 422,
				contentType: 'application/json',
				body: JSON.stringify({
					error: {
						code: 'invalid_landing_issue',
						message: 'Landing issue must belong to this project'
					}
				})
			})
		);
		await landing.fill('launch');
		await listbox.getByRole('option', { name: /Launch checklist/ }).click();
		await send.click();
		await expect(page.locator('#invite-landing-error')).toHaveText(
			'That issue is no longer in this project. Pick another, or clear the field.'
		);
		await expect(page.getByRole('alert')).toHaveCount(0);
		await page.unroute(`**/api/v1/projects/${project.id}/invitations`);
	});
});

test('the landing issue list fits a phone screen', async ({ page, request, uniqueName }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await setup(page, request, uniqueName('people-invite-phone'));
	await page.getByRole('combobox', { name: 'Landing issue (optional)' }).focus();
	const listbox = page.getByRole('listbox');
	await expect(listbox.getByRole('option')).toHaveCount(2);
	const box = await listbox.boundingBox();
	expect(box).not.toBeNull();
	expect(box!.x).toBeGreaterThanOrEqual(0);
	expect(box!.x + box!.width).toBeLessThanOrEqual(390);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
		true
	);
});
