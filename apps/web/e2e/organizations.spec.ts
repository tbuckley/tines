/**
 * Organizations (docs/organizations.md): Alice shares a personal project,
 * which creates a shared organization and moves the project into it; she
 * invites Bob from the organization's page; Bob joins and can open the
 * project; Alice's API key, which reached the project before, still does.
 */
import type { OrganizationDetail, Project } from '@tines/shared';
import { expect, test } from './fixtures';
import { ALICE, BOB } from './constants.mjs';
import { apiClient, body, gotoHydrated, signIn } from './helpers';

test('shares a project into a new organization and lets an invited person in', async ({
	page,
	context,
	browser,
	request,
	uniqueName
}) => {
	const alice = apiClient(request, ALICE.apiKey);
	const name = uniqueName('shared-app');
	const project = await body<Project>(await alice.post('/api/v1/projects', { name }));
	expect(project.organization?.kind).toBe('personal');

	await signIn(context, ALICE.sessionToken);
	await gotoHydrated(page, `/projects/${project.id}`);
	await page.getByRole('button', { name: 'Share', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: `Share ${name}` });
	await expect(dialog).toBeVisible();
	await dialog.getByRole('button', { name: 'Share', exact: true }).click();
	await expect(page.getByRole('link', { name })).toBeVisible();

	// Alice's key reached the project before sharing; it still does.
	const moved = await body<Project>(await alice.get(`/api/v1/projects/${project.id}`));
	expect(moved.organization).toMatchObject({ kind: 'shared', name });
	const orgId = moved.organization!.id;

	await gotoHydrated(page, `/organizations/${orgId}`);
	await page.getByLabel('Invite someone').fill(BOB.email);
	await page.getByRole('button', { name: 'Invite', exact: true }).click();
	await expect(page.getByText(BOB.email)).toBeVisible();
	const org = await body<OrganizationDetail>(await alice.get(`/api/v1/organizations/${orgId}`));
	const invite = org.invitations.find((i) => i.email === BOB.email)!;
	const { url } = await body<{ url: string }>(
		await request.get(`/api/v1/__e2e/invitation-email/${invite.id}`)
	);

	const bobContext = await browser.newContext();
	await signIn(bobContext, BOB.sessionToken);
	const bobPage = await bobContext.newPage();
	await gotoHydrated(bobPage, new URL(url).pathname);
	await bobPage.getByRole('button', { name: 'Join organization' }).click();
	await expect(bobPage).toHaveURL(new RegExp(`/organizations/${orgId}$`));
	await expect(bobPage.getByRole('link', { name })).toBeVisible();
	await gotoHydrated(bobPage, `/projects/${project.id}`);
	await expect(bobPage.getByRole('heading', { name })).toBeVisible();
	await bobContext.close();

	// Bob's key never named the organization, so it does not reach the project.
	const bobKey = apiClient(request, BOB.apiKey);
	expect((await bobKey.get(`/api/v1/projects/${project.id}`)).status()).toBe(404);
});
