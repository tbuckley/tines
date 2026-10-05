import { expect, test } from './fixtures';
import type { Page, Request } from '@playwright/test';
import { ALICE } from './constants.mjs';
import { apiClient, body, gotoHydrated, signIn } from './helpers';

const invitePost = (projectId: string) => (r: Request) =>
	r.method() === 'POST' && r.url().endsWith(`/api/v1/projects/${projectId}/invitations`);

async function setup(
	page: Page,
	request: Parameters<typeof apiClient>[0],
	name: string,
	extraOpen = 0
) {
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
	for (let i = 1; i <= extraOpen; i++) await create(`Filler issue ${i}`);
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
		// Enter with nothing to pick is not intercepted, so it submits the form.
		await landing.press('Enter');
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

test('a search that answers after new typing cannot be picked', async ({
	page,
	request,
	uniqueName
}) => {
	// A fake clock holds the 200 ms debounce shut, so the stale answer deterministically lands
	// while the new text is still waiting to be searched.
	await page.clock.install();
	const { project } = await setup(page, request, uniqueName('people-invite-stale'));
	await page.clock.pauseAt(Date.now() + 60_000);
	const landing = page.getByRole('combobox', { name: 'Landing issue (optional)' });
	const listbox = page.getByRole('listbox');

	let releasePri!: () => Promise<void>;
	const priHeld = new Promise<void>((resolve) => {
		void page.route(
			(url) =>
				url.pathname === `/api/v1/projects/${project.id}/issues` &&
				url.searchParams.get('q') === 'pri',
			async (route) => {
				const response = await route.fetch();
				releasePri = () => route.fulfill({ response });
				resolve();
			}
		);
	});

	await landing.fill('pri');
	await page.clock.runFor(250);
	await priHeld;
	await landing.fill('launch');
	await releasePri();
	// Real time passes for the stale answer to render; the paused clock keeps "launch" unsearched.
	await page.waitForTimeout(300);
	await expect(listbox).toHaveText('Searching…');
	await landing.press('Enter');
	await expect(landing).toHaveValue('launch');
});

test('the landing issue list fits a phone screen', async ({ page, request, uniqueName }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	// Eight options: tall enough to run under the tab bar if the field stayed where it was.
	await setup(page, request, uniqueName('people-invite-phone'), 6);
	const landing = page.getByRole('combobox', { name: 'Landing issue (optional)' });
	const listbox = page.getByRole('listbox');
	const options = listbox.getByRole('option');
	const tabBar = page.locator('nav[aria-label="Primary"]');
	const top = async (l: typeof landing) => (await l.boundingBox())!.y;
	const bottom = async (l: typeof landing) => {
		const b = (await l.boundingBox())!;
		return b.y + b.height;
	};
	const lastOptionFits = async () => {
		await options.last().scrollIntoViewIfNeeded();
		const barTop = await top(tabBar);
		expect(await bottom(options.last())).toBeLessThanOrEqual(barTop);
		expect(await bottom(options.last())).toBeLessThanOrEqual((await bottom(listbox)) + 0.5);
	};

	const underHeader = async () => {
		const t = await top(landing);
		return t >= 56 && t <= 120;
	};
	// A tall viewport can run out of page before the field reaches the header (how much page sits
	// below the field depends on the platform's text wrapping), so there the scroll may stop at the
	// page's end instead. The short viewport below always has room, and pins the header clearance.
	const underHeaderOrAtPageEnd = async () =>
		(await underHeader()) ||
		(await page.evaluate(
			() =>
				window.scrollY > 0 &&
				window.scrollY >= document.documentElement.scrollHeight - window.innerHeight - 1
		));
	// Start each open from the top of the page, so the field has to scroll up to reach the header.
	const scrollToTop = () => page.evaluate(() => window.scrollTo(0, 0));

	await scrollToTop();
	await landing.focus();
	await expect(options).toHaveCount(8);
	const box = (await listbox.boundingBox())!;
	expect(box.x).toBeGreaterThanOrEqual(0);
	expect(box.x + box.width).toBeLessThanOrEqual(390);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
		true
	);
	// The field scrolls up under the header, and the list ends above the tab bar.
	await expect.poll(underHeaderOrAtPageEnd).toBe(true);
	await expect.poll(async () => (await bottom(listbox)) <= (await top(tabBar))).toBe(true);
	// Re-measured after the scroll: all eight fit without scrolling inside the list.
	await expect.poll(() => listbox.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
	await lastOptionFits();

	// Keyboard stand-in: the viewport shrinks while the list is open, and the cap follows it.
	// The new height leaves room for about four rows under the field wherever the first scroll
	// left it (under the header, or lower at the page's end): enough for the list's minimum
	// height, too little for all eight rows, so the cap has to move for the list to fit.
	const barHeight = (await tabBar.boundingBox())!.height;
	const shrunk = Math.ceil((await bottom(landing)) + 8 + 120 + barHeight);
	await page.setViewportSize({ width: 390, height: shrunk });
	await expect(options).toHaveCount(8);
	await expect.poll(async () => (await bottom(listbox)) <= (await top(tabBar))).toBe(true);
	expect(await listbox.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
	await page.setViewportSize({ width: 390, height: 844 });

	// Little room left: the list caps its height and scrolls inside itself.
	await landing.blur();
	await expect(listbox).toHaveCount(0);
	await page.setViewportSize({ width: 390, height: 360 });
	await scrollToTop();
	await landing.focus();
	await expect(options).toHaveCount(8);
	await expect.poll(underHeader).toBe(true);
	await expect.poll(async () => (await bottom(listbox)) <= (await top(tabBar))).toBe(true);
	expect(await listbox.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
	await lastOptionFits();
});

test('focusing the landing issue on desktop does not scroll the page', async ({
	page,
	request,
	uniqueName
}) => {
	await page.setViewportSize({ width: 1280, height: 720 });
	await setup(page, request, uniqueName('people-invite-desktop'));
	const landing = page.getByRole('combobox', { name: 'Landing issue (optional)' });
	await landing.scrollIntoViewIfNeeded();
	const before = await page.evaluate(() => window.scrollY);
	await landing.focus();
	await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(2);
	// Give a scroll scheduled for the next frame the chance to happen.
	await page.evaluate(
		() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
	);
	expect(await page.evaluate(() => window.scrollY)).toBe(before);
});

test('the People page uses the layout main landmark, not a second nested one', async ({
	page,
	request,
	uniqueName
}) => {
	await setup(page, request, uniqueName('people-landmark'));
	const main = page.getByRole('main');
	await expect(main).toHaveCount(1);
	await expect(main.getByRole('button', { name: 'Send invitation' })).toBeVisible();
	expect(await page.evaluate(() => document.querySelectorAll('main').length)).toBe(1);
});
