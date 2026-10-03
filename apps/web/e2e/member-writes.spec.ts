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
	// Members pick from the owner's whole library, so they can read a workflow
	// before any issue in the project uses it.
	expect(
		await body<{ id: string }>(await member.get(`/api/v1/workflows/${ownerWorkflow.id}`))
	).toMatchObject({ id: ownerWorkflow.id, name: ownerWorkflow.name });
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
	// The owner's workflow page opens read-only for the member.
	await page.goto(`/workflows/${ownerWorkflow.id}`);
	await expect(page.getByRole('heading', { name: ownerWorkflow.name })).toBeVisible();
	await expect(page.getByText(/read-only/)).toBeVisible();
	await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);
	await expect(page.getByText('Context by state')).toHaveCount(0);
});

test('a member sees the shared project context they can create, in the list API and on the Context page', async ({
	request,
	page,
	uniqueName
}) => {
	test.setTimeout(120_000);
	const owner = apiClient(request, ALICE.apiKey);
	const member = apiClient(request, BOB.apiKey);
	const project = await body<{ id: string; name: string }>(
		await owner.post('/api/v1/projects', { name: uniqueName('member-context') })
	);
	const issue = await body<{ id: string; number: number }>(
		await owner.post(`/api/v1/projects/${project.id}/issues`, { title: 'Context owner issue' })
	);
	const privateProject = await body<{ id: string }>(
		await owner.post('/api/v1/projects', { name: uniqueName('member-context-private') })
	);
	const names = {
		ownerPrompt: uniqueName('ctx-owner-prompt'),
		memberPrompt: uniqueName('ctx-member-prompt'),
		globalCanary: uniqueName('ctx-global-canary'),
		privateCanary: uniqueName('ctx-private-canary')
	};
	const prompt = (name: string, scope: Record<string, string> = {}) =>
		owner.post('/api/v1/context', { kind: 'prompt', name, body: `${name} body`, ...scope });
	// A global item under the shared owner account would reach other specs'
	// effective context: it is deleted in the `finally` below.
	const globalCanary = await body<{ id: string }>(await prompt(names.globalCanary));
	try {
		await body(await prompt(names.privateCanary, { project_id: privateProject.id }));
		await body(await prompt(names.ownerPrompt, { project_id: project.id }));
		await body(
			await owner.post('/api/v1/context', {
				kind: 'env',
				name: 'MEMBER_CONTEXT_TOKEN',
				value: 'CTX_ENV_VALUE_CANARY',
				project_id: project.id
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
		await page.getByRole('button', { name: 'Join project' }).click();
		await expect(page.getByRole('link', { name: /Context owner issue/ })).toBeVisible();

		// The reported repro: the member creates a project prompt, then lists.
		const created = await member.post('/api/v1/context', {
			kind: 'prompt',
			name: names.memberPrompt,
			project_id: project.id,
			body: 'x'
		});
		expect(created.status()).toBe(201);
		const listed = await body<{ items: { name: string; kind: string; value?: string }[] }>(
			await member.get('/api/v1/context?limit=200')
		);
		const listedNames = listed.items.map((item) => item.name);
		expect(listedNames).toContain(names.memberPrompt);
		expect(listedNames).toContain(names.ownerPrompt);
		expect(listedNames).not.toContain(names.globalCanary);
		expect(listedNames).not.toContain(names.privateCanary);
		expect(JSON.stringify(listed)).not.toContain('CTX_ENV_VALUE_CANARY');
		const byName = await body<{ items: { name: string }[] }>(
			await member.get(`/api/v1/context?project=${encodeURIComponent(project.name)}`)
		);
		expect(byName.items.map((item) => item.name).sort()).toEqual(
			['MEMBER_CONTEXT_TOKEN', names.memberPrompt, names.ownerPrompt].sort()
		);

		// The Context page, focused on the shared project, at both reported sizes.
		await body(await member.patch('/api/v1/preferences', { focused_project_id: project.id }));
		for (const viewport of [
			{ width: 1440, height: 900 },
			{ width: 390, height: 844 }
		]) {
			await page.setViewportSize(viewport);
			await gotoHydrated(page, '/context');
			for (const name of [names.memberPrompt, names.ownerPrompt, 'MEMBER_CONTEXT_TOKEN'])
				await expect(
					page.getByRole('button', { name: new RegExp(name) }),
					`${name} at ${viewport.width}px`
				).toBeVisible();
			await expect(page.getByTestId('member-context-note')).toContainText(
				`shared by ${ALICE.name}`
			);
			await expect(page.getByText(/shared items? \(global and state-scoped\)/)).toHaveCount(0);
			await expect(page.getByText('Add the starter agent guidance')).toHaveCount(0);
			const html = await page.content();
			for (const canary of [names.globalCanary, names.privateCanary, 'CTX_ENV_VALUE_CANARY'])
				expect(html).not.toContain(canary);
		}

		// The member edits their own item from the list.
		await page.setViewportSize({ width: 1440, height: 900 });
		const editor = page.getByRole('dialog');
		await clickToOpen(page.getByRole('button', { name: new RegExp(names.memberPrompt) }), editor);
		await editor.getByLabel('Description').fill('Edited by the member');
		await editor.getByRole('button', { name: 'Save' }).click();
		await expect(editor).toHaveCount(0);
		await expect(
			page.getByRole('button', { name: new RegExp(names.memberPrompt) })
		).toContainText('Edited by the member');

		// The issue page counts what the member can see, and links to it.
		await gotoHydrated(page, `/issues/${project.id}/${issue.number}`);
		await expect(page.getByRole('heading', { name: /^Context/ })).toContainText(
			'(2 prompts, 1 env)'
		);
		await expect(page.getByRole('link', { name: 'View project context' })).toHaveAttribute(
			'href',
			`/projects/${project.id}`
		);
	} finally {
		await owner.delete(`/api/v1/context/${globalCanary.id}`).catch(() => undefined);
		await member.patch('/api/v1/preferences', { focused_project_id: null }).catch(() => undefined);
	}
});
