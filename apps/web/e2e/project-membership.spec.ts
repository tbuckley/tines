import { expect, test } from './fixtures';
import { ALICE, BOB, CAROL, BASE_URL } from './constants.mjs';
import { apiClient, body, gotoHydrated, signIn, signedSessionCookie } from './helpers';
import { d1, sqlLiteral } from './d1';

test('two accounts join and read without owner-private payloads, then removal revokes access', async ({
	request,
	page,
	browser,
	uniqueName
}) => {
	const owner = apiClient(request, ALICE.apiKey);
	const project = await body<{ id: string; sharing_revision: number }>(
		await owner.post('/api/v1/projects', { name: uniqueName('join-read') })
	);
	const issue = await body<{ id: string; number: number }>(
		await owner.post(`/api/v1/projects/${project.id}/issues`, {
			title: 'Shared decision',
			description: 'Visible issue body'
		})
	);
	const invite = await body<{ id: string }>(
		await owner.post(`/api/v1/projects/${project.id}/invitations`, {
			email: BOB.email,
			landing_issue_id: issue.id,
			confirm_sharing: true,
			expected_sharing_revision: 0
		})
	);
	const sink = await body<{ url: string }>(
		await request.get(`/api/v1/__e2e/invitation-email/${invite.id}`)
	);
	const token = sink.url.split('/').at(-1)!;
	await signIn(page.context(), CAROL.sessionToken);
	await gotoHydrated(page, `/invites/${token}`);
	await expect(page.getByText('Switch to the verified account')).toBeVisible();
	await expect(page.getByText(BOB.email)).toHaveCount(0);
	await page.getByRole('button', { name: 'Switch account' }).click();
	await expect(page.getByRole('button', { name: 'Sign in to continue' })).toBeVisible();
	const bobContext = await browser.newContext({
		viewport: { width: 390, height: 844 },
		baseURL: BASE_URL
	});
	try {
		await signIn(bobContext, BOB.sessionToken);
		const bobPage = await bobContext.newPage();
		await gotoHydrated(bobPage, `/invites/${token}`);
		await expect(bobPage.getByRole('button', { name: 'Join project' })).toBeVisible();
		await bobPage.getByRole('button', { name: 'Join project' }).click();
		await expect(bobPage.getByRole('heading', { name: 'Shared decision' })).toBeVisible();
		const detail = await body<Record<string, unknown>>(
			await request.get(`/api/v1/issues/${issue.id}`, {
				headers: { authorization: `Bearer ${BOB.apiKey}` }
			})
		);
		expect(detail).toMatchObject({ title: 'Shared decision', viewer_role: 'member' });
		expect(JSON.stringify(detail)).not.toContain('github_pat');
		expect(JSON.stringify(detail)).not.toContain('routingRules');
		const roster = await body<{ members: { id: string; revision: number }[] }>(
			await request.get(`/api/v1/projects/${project.id}/people`, {
				headers: { authorization: `Bearer ${BOB.apiKey}` }
			})
		);
		const revision = roster.members.find((person) => person.id === BOB.id)!.revision;
		await body(
			await owner.delete(`/api/v1/projects/${project.id}/members/${BOB.id}`, {
				expected_revision: revision
			})
		);
		const revoked = await request.get(`/api/v1/issues/${issue.id}`, {
			headers: { authorization: `Bearer ${BOB.apiKey}` }
		});
		expect(revoked.status()).toBe(404);
		await bobPage.reload();
		await expect(bobPage.getByRole('heading', { name: 'Shared decision' })).toHaveCount(0);
	} finally {
		await bobContext.close();
	}
});

test('resend replaces the old link and expiry blocks acceptance', async ({
	request,
	page,
	uniqueName
}) => {
	const owner = apiClient(request, ALICE.apiKey);
	const project = await body<{ id: string }>(
		await owner.post('/api/v1/projects', { name: uniqueName('invite-rotation') })
	);
	const first = await body<{ id: string }>(
		await owner.post(`/api/v1/projects/${project.id}/invitations`, {
			email: BOB.email,
			confirm_sharing: true,
			expected_sharing_revision: 0
		})
	);
	const oldUrl = (
		await body<{ url: string }>(await request.get(`/api/v1/__e2e/invitation-email/${first.id}`))
	).url;
	const rotated = await body<{ generation: number }>(
		await owner.post(`/api/v1/projects/${project.id}/invitations/${first.id}/resend`, {
			expected_generation: 1
		})
	);
	const currentUrl = (
		await body<{ url: string }>(await request.get(`/api/v1/__e2e/invitation-email/${first.id}`))
	).url;
	const bobHeaders = {
		cookie: `better-auth.session_token=${signedSessionCookie(BOB.sessionToken)}`,
		origin: BASE_URL
	};
	const old = await request.post('/api/v1/invitations/accept', {
		headers: bobHeaders,
		data: { token: oldUrl.split('/').at(-1) }
	});
	expect(old.status()).toBe(404);
	const oldLanding = await request.get(new URL(oldUrl).pathname);
	expect(oldLanding.status()).toBe(404);
	expect(currentUrl).not.toBe(oldUrl);
	d1(`UPDATE project_invitation SET expires_at = 1 WHERE id = ${sqlLiteral(first.id)}`);
	const expired = await request.post('/api/v1/invitations/accept', {
		headers: bobHeaders,
		data: { token: currentUrl.split('/').at(-1) }
	});
	expect(expired.status()).toBe(410);
	const again = await body<{ generation: number }>(
		await owner.post(`/api/v1/projects/${project.id}/invitations/${first.id}/resend`, {
			expected_generation: rotated.generation
		})
	);
	expect(again.generation).toBe(3);
	const latestUrl = (
		await body<{ url: string }>(await request.get(`/api/v1/__e2e/invitation-email/${first.id}`))
	).url;
	await signIn(page.context(), BOB.sessionToken);
	await gotoHydrated(page, new URL(latestUrl).pathname);
	await page.getByRole('button', { name: 'Join project' }).click();
	await expect(page.getByText('No issues match this view.')).toBeVisible();
	await expect(page.getByRole('link', { name: 'View all project issues' })).toBeVisible();
	await page.getByRole('link', { name: 'View all project issues' }).click();
	await expect(page.getByRole('heading', { name: 'Issues' })).toBeVisible();
});
