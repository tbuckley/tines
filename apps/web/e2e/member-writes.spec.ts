import { expect, test } from './fixtures';
import { ALICE, BOB, BASE_URL, RUNROW_FAILED } from './constants.mjs';
import { apiClient, body, clickToOpen, gotoHydrated, signIn } from './helpers';
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

test('a member files and edits issues in a shared project, and people stay the owner', async ({
	request,
	page,
	uniqueName
}) => {
	test.setTimeout(120_000);
	const owner = apiClient(request, ALICE.apiKey);
	const member = apiClient(request, BOB.apiKey);
	const project = await body<{ id: string; name: string }>(
		await owner.post('/api/v1/projects', { name: uniqueName('member-writes') })
	);
	const shared = await body<{ id: string; number: number }>(
		await owner.post(`/api/v1/projects/${project.id}/issues`, { title: 'Owner issue' })
	);
	// Bob has no workflow of this name: the CLI resolves it in Alice's library.
	const ownerWorkflow = await body<{ id: string; name: string }>(
		await owner.post('/api/v1/workflows', {
			name: uniqueName('member-writes-flow'),
			initial_state: 'Doing',
			states: [{ name: 'Doing', category: 'active' }],
			transitions: []
		})
	);
	const privateProject = await body<{ id: string }>(
		await owner.post('/api/v1/projects', { name: uniqueName('member-writes-private') })
	);
	const privateIssue = await body<{ id: string }>(
		await owner.post(`/api/v1/projects/${privateProject.id}/issues`, {
			title: 'PRIVATE_WRITE_CANARY'
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
	await signIn(page.context(), BOB.sessionToken);
	await gotoHydrated(page, new URL(sink.url).pathname);
	await expect(page.getByText(/This link expires/)).toBeVisible();
	await page.getByRole('button', { name: 'Join project' }).click();
	await expect(page.getByRole('link', { name: /Owner issue/ })).toBeVisible();

	// The owner's project page, without the owner-only controls.
	await gotoHydrated(page, `/projects/${project.id}`);
	await expect(page.getByText(`Shared by ${ALICE.name}`)).toBeVisible();
	await expect(page.getByRole('button', { name: 'Edit routing' })).toHaveCount(0);
	const dialog = page.getByRole('dialog', { name: `New issue in ${project.name}` });
	await clickToOpen(page.getByRole('button', { name: /New issue/ }), dialog);
	await dialog.getByLabel('Title').fill('Filed by the member');
	await dialog.getByRole('button', { name: 'Create issue' }).click();
	await expect(page).toHaveURL(new RegExp(`/issues/${project.id}/\\d+$`));
	await expect(page.getByRole('heading', { name: 'Filed by the member' })).toBeVisible();
	const filed = d1<{ id: string; actor_user_id: string }>(
		`SELECT i.id, e.actor_user_id FROM issue i JOIN event e ON e.issue_id = i.id AND e.type = 'issue.created'
		WHERE i.project_id = ${sqlLiteral(project.id)} AND i.title = 'Filed by the member'`
	);
	expect(filed).toEqual([{ id: expect.any(String), actor_user_id: BOB.id }]);
	// The owner's agents stay off a member's issue until the owner allows them.
	expect(
		d1<{ user_id: string; value: string }>(
			`SELECT user_id, value FROM issue_personal_choice WHERE issue_id = ${sqlLiteral(filed[0].id)} ORDER BY user_id = ${sqlLiteral(BOB.id)}`
		)
	).toEqual([
		{ user_id: ALICE.id, value: 'off' },
		{ user_id: BOB.id, value: 'on' }
	]);

	// API and CLI edits, attributed to the member.
	await body(await member.patch(`/api/v1/issues/${shared.id}`, { title: 'Retitled by member' }));
	await body(await member.post(`/api/v1/issues/${shared.id}/labels`, { labels: ['member-label'] }));
	await body(
		await member.put(`/api/v1/issues/${shared.id}/artifacts/member-notes`, {
			type: 'text',
			content: 'From the member',
			content_type: 'text/plain'
		})
	);
	expect(
		cli('issues', 'create', project.id, '-t', 'CLI member issue', '-w', ownerWorkflow.name)
	).toContain('CLI member issue');
	expect(
		d1<{ workflow_id: string }>(
			`SELECT workflow_id FROM issue WHERE project_id = ${sqlLiteral(project.id)} AND title = 'CLI member issue'`
		)
	).toEqual([{ workflow_id: ownerWorkflow.id }]);
	expect(
		d1<{ actor_user_id: string }>(
			`SELECT actor_user_id FROM event WHERE issue_id = ${sqlLiteral(shared.id)} AND type = 'issue.updated'`
		)
	).toEqual([{ actor_user_id: BOB.id }]);

	// Fenced: the owner's other projects, their machines, and their people.
	expect(
		(
			await member.post(`/api/v1/issues/${shared.id}/links`, {
				kind: 'blocked_by',
				issue_id: privateIssue.id
			})
		).status()
	).toBe(404);
	expect(
		(
			await member.patch(`/api/v1/issues/${shared.id}`, {
				pinned_runner_id: RUNROW_FAILED.runnerId
			})
		).status()
	).toBe(403);
	expect((await member.delete(`/api/v1/projects/${project.id}`)).status()).toBe(404);
	expect(
		(
			await member.post(`/api/v1/projects/${project.id}/invitations`, {
				email: 'someone@example.com',
				confirm_sharing: true,
				expected_sharing_revision: 1
			})
		).status()
	).toBe(403);
	await gotoHydrated(page, `/issues/${project.id}/${shared.number}`);
	await expect(page.getByRole('heading', { name: 'Retitled by member' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'View launch prompt' })).toHaveCount(0);
	expect(await page.content()).not.toContain('PRIVATE_WRITE_CANARY');
});
