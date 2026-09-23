import { expect, test } from './fixtures';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ALICE, BOB, CAROL, BASE_URL } from './constants.mjs';
import { apiClient, body, gotoHydrated, signIn, signedSessionCookie } from './helpers';
import { d1, sqlLiteral } from './d1';

const CLI_DIR = fileURLToPath(new URL('../../../packages/cli/', import.meta.url));
function cli(key: string, ...args: string[]): string {
	return execFileSync('pnpm', ['exec', 'tsx', 'src/index.ts', ...args], {
		cwd: CLI_DIR,
		env: { ...process.env, TINES_API_URL: BASE_URL, TINES_API_KEY: key },
		encoding: 'utf8'
	});
}

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
	const workflow = await body<{ id: string; name: string }>(
		await owner.post('/api/v1/workflows', {
			name: uniqueName('Shared workflow'),
			initial_state: 'Working',
			states: [
				{ name: 'Working', category: 'active' },
				{ name: 'Review', category: 'awaiting_human' }
			],
			transitions: [{ name: 'review', from: 'Working', to: 'Review' }]
		})
	);
	const issue = await body<{ id: string; number: number }>(
		await owner.post(`/api/v1/projects/${project.id}/issues`, {
			title: 'Shared decision',
			description: 'Visible issue body',
			workflow_id: workflow.id
		})
	);
	const recurring = await body<{ schedule: { id: string } }>(
		await owner.post(`/api/v1/projects/${project.id}/issues`, {
			title: 'Shared recurrence {{count}}',
			schedule: { preset: { kind: 'daily', time: '09:00' } }
		})
	);
	const recurringSecond = await body<{ schedule: { id: string } }>(
		await owner.post(`/api/v1/projects/${project.id}/issues`, {
			title: 'Second recurrence {{count}}',
			schedule: { preset: { kind: 'daily', time: '10:00' } }
		})
	);
	const linked = await body<{ id: string; number: number }>(
		await owner.post(`/api/v1/projects/${project.id}/issues`, { title: 'Visible linked work' })
	);
	await body(
		await owner.post(`/api/v1/issues/${issue.id}/links`, {
			kind: 'blocks',
			issue_id: linked.id
		})
	);
	const privateProject = await body<{ id: string }>(
		await owner.post('/api/v1/projects', { name: uniqueName('private-link') })
	);
	const privateIssue = await body<{ id: string }>(
		await owner.post(`/api/v1/projects/${privateProject.id}/issues`, {
			title: 'FOREIGN_LINK_CANARY'
		})
	);
	await body(
		await owner.post(`/api/v1/issues/${privateIssue.id}/links`, {
			kind: 'blocks',
			issue_id: issue.id
		})
	);
	await body(
		await owner.put(`/api/v1/issues/${issue.id}/artifacts/notes`, {
			type: 'text',
			content: 'First shared version',
			content_type: 'text/plain'
		})
	);
	await body(
		await owner.put(`/api/v1/issues/${issue.id}/artifacts/notes`, {
			type: 'text',
			content: 'Second shared version',
			content_type: 'text/plain'
		})
	);
	await body(
		await owner.put(`/api/v1/issues/${issue.id}/artifacts/site`, {
			type: 'text',
			content: '<h1>Shared HTML</h1>',
			content_type: 'text/html'
		})
	);
	const privateContextId = `ctx_private_${Date.now()}`;
	const now = Date.now();
	d1(`INSERT INTO context_item (id,user_id,kind,name,description,project_id,workflow_state_id,issue_id,label_id,body,position,version,created_at,updated_at)
		VALUES (${sqlLiteral(privateContextId)},${sqlLiteral(ALICE.id)},'prompt','private-canary','',NULL,NULL,
		${sqlLiteral(issue.id)},NULL,'SECRET_CONTEXT_CANARY',0,1,${now},${now})`);
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
	await page.getByRole('button', { name: 'Sign in to continue' }).click();
	await page.getByPlaceholder('you@example.com').fill(BOB.email);
	await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
	await expect(page.getByText('Check your email')).toBeVisible();
	const invitePath = new URL(sink.url).pathname;
	await page.goto(
		`/api/auth/magic-link/verify?token=${encodeURIComponent(`e2e-magic-link-${BOB.email}`)}&callbackURL=${encodeURIComponent(invitePath)}&errorCallbackURL=${encodeURIComponent(`${invitePath}?error=signin`)}`
	);
	await expect(page).toHaveURL(sink.url);
	await expect(page.getByRole('button', { name: 'Join project' })).toBeVisible();
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
		expect(await bobPage.content()).not.toContain('SECRET_CONTEXT_CANARY');
		await expect(bobPage.getByRole('link', { name: /Visible linked work/ })).toBeVisible();
		await expect(bobPage.getByText('Blocked by another issue.')).toBeVisible();
		expect(await bobPage.content()).not.toContain('FOREIGN_LINK_CANARY');
		await bobPage.setViewportSize({ width: 1440, height: 900 });
		await bobPage.reload();
		await expect(bobPage.getByRole('heading', { name: 'Shared decision' })).toBeVisible();
		expect(await bobPage.content()).not.toContain('SECRET_CONTEXT_CANARY');
		const detail = await body<Record<string, unknown>>(
			await request.get(`/api/v1/issues/${issue.id}`, {
				headers: { authorization: `Bearer ${BOB.apiKey}` }
			})
		);
		expect(detail).toMatchObject({ title: 'Shared decision', viewer_role: 'member' });
		expect(JSON.stringify(detail)).not.toContain('github_pat');
		expect(JSON.stringify(detail)).not.toContain('routingRules');
		expect(JSON.stringify(detail)).not.toContain('SECRET_CONTEXT_CANARY');
		expect(JSON.stringify(detail)).not.toContain('FOREIGN_LINK_CANARY');
		expect(JSON.stringify(detail)).not.toContain(privateIssue.id);
		const sharedWorkflow = await body<{ id: string; states: { name: string }[] }>(
			await request.get(`/api/v1/workflows/${workflow.id}`, {
				headers: { authorization: `Bearer ${BOB.apiKey}` }
			})
		);
		expect(sharedWorkflow).toMatchObject({
			id: workflow.id,
			states: [{ name: 'Working' }, { name: 'Review' }]
		});
		expect(
			(
				await body<{ items: { id: string }[] }>(
					await request.get('/api/v1/workflows', {
						headers: { authorization: `Bearer ${BOB.apiKey}` }
					})
				)
			).items.map((item) => item.id)
		).toContain(workflow.id);
		expect(
			(
				await request.get(`/api/v1/context/${privateContextId}`, {
					headers: { authorization: `Bearer ${BOB.apiKey}` }
				})
			).status()
		).toBe(404);
		expect(
			(
				await request.get(`/api/v1/issues/${issue.id}/context`, {
					headers: { authorization: `Bearer ${BOB.apiKey}` }
				})
			).status()
		).toBe(404);
		expect(
			(
				await request.post(`/api/v1/issues/${issue.id}/artifacts/site/site-link`, {
					headers: { authorization: `Bearer ${BOB.apiKey}` },
					data: {}
				})
			).status()
		).toBe(404);
		const html = await request.get(`/api/v1/issues/${issue.id}/artifacts/site/content?inline=1`, {
			headers: { authorization: `Bearer ${BOB.apiKey}` }
		});
		expect(html.headers()['content-disposition']).toContain('attachment');
		const global = await body<{ items: { id: string; project_name: string }[] }>(
			await request.get(
				`/api/v1/issues?project=${project.id}&q=decision&workflow=${encodeURIComponent(workflow.name)}&limit=1`,
				{
					headers: { authorization: `Bearer ${BOB.apiKey}` }
				}
			)
		);
		expect(global.items).toMatchObject([{ id: issue.id }]);
		expect(global.items[0].project_name).toContain('join-read');
		const pageOne = await body<{ items: { id: string }[]; next_cursor: string | null }>(
			await request.get(`/api/v1/projects/${project.id}/issues?limit=1`, {
				headers: { authorization: `Bearer ${BOB.apiKey}` }
			})
		);
		const pageTwo = await body<{ items: { id: string }[] }>(
			await request.get(
				`/api/v1/projects/${project.id}/issues?limit=1&cursor=${encodeURIComponent(pageOne.next_cursor!)}`,
				{
					headers: { authorization: `Bearer ${BOB.apiKey}` }
				}
			)
		);
		expect(pageOne.next_cursor).toBeTruthy();
		expect(pageTwo.items[0].id).not.toBe(pageOne.items[0].id);
		await gotoHydrated(bobPage, `/issues?project=${project.id}`);
		await expect(bobPage.getByRole('option', { name: 'All (4)' })).toBeAttached();
		await gotoHydrated(bobPage, `/issues/${project.id}/${issue.number}`);
		await expect(bobPage.getByRole('heading', { name: 'Shared decision' })).toBeVisible();
		const artifact = await body<{ version_count: number; versions: { version: number }[] }>(
			await request.get(`/api/v1/issues/${issue.id}/artifacts/notes`, {
				headers: { authorization: `Bearer ${BOB.apiKey}` }
			})
		);
		expect(artifact.version_count).toBe(2);
		expect(artifact.versions.map((entry) => entry.version)).toEqual([1, 2]);
		const oldContent = await request.get(
			`/api/v1/issues/${issue.id}/artifacts/notes/content?version=1`,
			{
				headers: { authorization: `Bearer ${BOB.apiKey}` }
			}
		);
		expect(await oldContent.text()).toBe('First shared version');
		const schedules = await body<{
			items: { id: string; project: { id: string } }[];
			next_cursor: string | null;
		}>(
			await request.get(`/api/v1/schedules?project=${project.id}&limit=1`, {
				headers: { authorization: `Bearer ${BOB.apiKey}` }
			})
		);
		expect(schedules.items).toHaveLength(1);
		expect(schedules.next_cursor).toBeTruthy();
		const nextSchedules = await body<{ items: { id: string }[] }>(
			await request.get(
				`/api/v1/schedules?project=${project.id}&limit=1&cursor=${encodeURIComponent(schedules.next_cursor!)}`,
				{
					headers: { authorization: `Bearer ${BOB.apiKey}` }
				}
			)
		);
		expect([schedules.items[0].id, nextSchedules.items[0].id].sort()).toEqual(
			[recurring.schedule.id, recurringSecond.schedule.id].sort()
		);
		expect(schedules.items[0].project.id).toBe(project.id);
		expect(JSON.stringify(schedules)).not.toContain('routingRules');
		const history = await body<{ items: { type: string; payload: Record<string, unknown> }[] }>(
			await request.get(`/api/v1/events?project=${project.id}`, {
				headers: { authorization: `Bearer ${BOB.apiKey}` }
			})
		);
		expect(history.items.some((event) => event.type === 'issue.created')).toBe(true);
		expect(history.items.every((event) => Object.keys(event.payload).length === 0)).toBe(true);
		expect(
			JSON.parse(cli(BOB.apiKey, 'issues', 'list', '--project', project.id, '--json')).items
		).toEqual(expect.arrayContaining([expect.objectContaining({ id: issue.id })]));
		expect(cli(BOB.apiKey, 'issues', 'show', `${project.id}/${issue.number}`)).toContain(
			'This shared issue is read only'
		);
		expect(
			cli(BOB.apiKey, 'issues', 'artifacts', 'show', `${project.id}/${issue.number}`, 'notes')
		).toContain('v2');
		expect(cli(BOB.apiKey, 'schedules', 'list', '--project', project.id)).toContain(
			'Shared recurrence'
		);
		expect(
			cli(BOB.apiKey, 'schedules', 'show', `${project.id}/${recurring.schedule.id}`)
		).toContain('This shared schedule is read only');
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

test('magic-link sign-in returns to the invitation before acceptance', async ({
	request,
	page,
	uniqueName
}) => {
	const owner = apiClient(request, ALICE.apiKey);
	const project = await body<{ id: string }>(
		await owner.post('/api/v1/projects', { name: uniqueName('sign-in-return') })
	);
	const invite = await body<{ id: string }>(
		await owner.post(`/api/v1/projects/${project.id}/invitations`, {
			email: BOB.email,
			confirm_sharing: true,
			expected_sharing_revision: 0
		})
	);
	const url = (
		await body<{ url: string }>(await request.get(`/api/v1/__e2e/invitation-email/${invite.id}`))
	).url;
	const invitePath = new URL(url).pathname;
	await gotoHydrated(page, invitePath);
	await page.getByRole('button', { name: 'Sign in to continue' }).click();
	await page.getByPlaceholder('you@example.com').fill(BOB.email);
	await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
	await expect(page.getByText('Check your email')).toBeVisible();
	await page.goto(
		`/api/auth/magic-link/verify?token=${encodeURIComponent(`e2e-magic-link-${BOB.email}`)}&callbackURL=${encodeURIComponent(invitePath)}&errorCallbackURL=${encodeURIComponent(`${invitePath}?error=signin`)}`
	);
	await expect(page).toHaveURL(url);
	await expect(page.getByRole('button', { name: 'Join project' })).toBeVisible();
	await page.getByRole('button', { name: 'Join project' }).click();
	await expect(page.getByText('No issues match this view.')).toBeVisible();
});

test('duplicate project names disclose only readable IDs and require immutable addressing', async ({
	request,
	uniqueName
}) => {
	const name = uniqueName('same-name');
	const alice = apiClient(request, ALICE.apiKey);
	const bob = apiClient(request, BOB.apiKey);
	const carol = apiClient(request, CAROL.apiKey);
	const shared = await body<{ id: string }>(await alice.post('/api/v1/projects', { name }));
	const mine = await body<{ id: string }>(await bob.post('/api/v1/projects', { name }));
	const hidden = await body<{ id: string }>(await carol.post('/api/v1/projects', { name }));
	const invite = await body<{ id: string }>(
		await alice.post(`/api/v1/projects/${shared.id}/invitations`, {
			email: BOB.email,
			confirm_sharing: true,
			expected_sharing_revision: 0
		})
	);
	const url = (
		await body<{ url: string }>(await request.get(`/api/v1/__e2e/invitation-email/${invite.id}`))
	).url;
	await body(
		await request.post('/api/v1/invitations/accept', {
			headers: {
				cookie: `better-auth.session_token=${signedSessionCookie(BOB.sessionToken)}`,
				origin: BASE_URL
			},
			data: { token: url.split('/').at(-1) }
		})
	);
	const ambiguous = await bob.get(`/api/v1/issues?project=${encodeURIComponent(name)}`);
	expect(ambiguous.status()).toBe(409);
	const result = (await ambiguous.json()) as { error: { details: { choices: { id: string }[] } } };
	expect(result.error.details.choices.map((choice) => choice.id).sort()).toEqual(
		[shared.id, mine.id].sort()
	);
	expect(result.error.details.choices.map((choice) => choice.id)).not.toContain(hidden.id);
	expect((await bob.get(`/api/v1/projects/${shared.id}`)).status()).toBe(200);
	expect((await bob.get(`/api/v1/projects/${hidden.id}`)).status()).toBe(404);
	for (const collection of ['issues', 'schedules', 'events']) {
		const hiddenList = await body<{ items: unknown[] }>(
			await bob.get(`/api/v1/${collection}?project=${hidden.id}`)
		);
		expect(hiddenList.items).toEqual([]);
	}
});

test('CLI invite, rotation, cancel, self-leave and owner removal use the same guarded lifecycle', async ({
	request,
	uniqueName
}) => {
	const owner = apiClient(request, ALICE.apiKey);
	const project = await body<{ id: string }>(
		await owner.post('/api/v1/projects', { name: uniqueName('cli-people') })
	);
	expect(() => cli(ALICE.apiKey, 'projects', 'invite', project.id, BOB.email)).toThrow();
	expect(
		d1<{ shared_at: number | null }>(
			`SELECT shared_at FROM project WHERE id=${sqlLiteral(project.id)}`
		)
	).toEqual([{ shared_at: null }]);
	expect(
		cli(ALICE.apiKey, 'projects', 'invite', project.id, BOB.email, '--confirm-sharing')
	).toContain('Invited');
	const first = await body<{ items: { id: string }[] }>(
		await owner.get(`/api/v1/projects/${project.id}/invitations`)
	);
	const inviteId = first.items[0].id;
	const oldUrl = (
		await body<{ url: string }>(await request.get(`/api/v1/__e2e/invitation-email/${inviteId}`))
	).url;
	expect(cli(ALICE.apiKey, 'projects', 'invite-resend', project.id, inviteId)).toContain('rotated');
	const rotatedUrl = (
		await body<{ url: string }>(await request.get(`/api/v1/__e2e/invitation-email/${inviteId}`))
	).url;
	expect(rotatedUrl).not.toBe(oldUrl);
	expect(cli(ALICE.apiKey, 'projects', 'invite-cancel', project.id, inviteId)).toContain(
		'Canceled'
	);
	expect((await request.get(new URL(rotatedUrl).pathname)).status()).toBe(404);
	cli(ALICE.apiKey, 'projects', 'invite', project.id, BOB.email);
	const inventory = await body<{ items: { id: string; canceled_at: number | null }[] }>(
		await owner.get(`/api/v1/projects/${project.id}/invitations`)
	);
	const currentId = inventory.items.find((item) => item.canceled_at === null)!.id;
	const currentUrl = (
		await body<{ url: string }>(await request.get(`/api/v1/__e2e/invitation-email/${currentId}`))
	).url;
	const accept = () =>
		request.post('/api/v1/invitations/accept', {
			headers: {
				cookie: `better-auth.session_token=${signedSessionCookie(BOB.sessionToken)}`,
				origin: BASE_URL
			},
			data: { token: currentUrl.split('/').at(-1) }
		});
	await body(await accept());
	expect(cli(BOB.apiKey, 'projects', 'people', project.id)).toContain(BOB.name);
	expect(cli(BOB.apiKey, 'projects', 'leave', project.id)).toContain('Left');
	expect(
		(await apiClient(request, BOB.apiKey).get(`/api/v1/projects/${project.id}`)).status()
	).toBe(404);
	cli(ALICE.apiKey, 'projects', 'invite', project.id, BOB.email);
	const next = await body<{ items: { id: string; canceled_at: number | null }[] }>(
		await owner.get(`/api/v1/projects/${project.id}/invitations`)
	);
	const nextId = next.items.find((item) => item.canceled_at === null && item.id !== currentId)!.id;
	const nextUrl = (
		await body<{ url: string }>(await request.get(`/api/v1/__e2e/invitation-email/${nextId}`))
	).url;
	await body(
		await request.post('/api/v1/invitations/accept', {
			headers: {
				cookie: `better-auth.session_token=${signedSessionCookie(BOB.sessionToken)}`,
				origin: BASE_URL
			},
			data: { token: nextUrl.split('/').at(-1) }
		})
	);
	expect(cli(ALICE.apiKey, 'projects', 'remove-member', project.id, BOB.id)).toContain('Removed');
	expect(
		(await apiClient(request, BOB.apiKey).get(`/api/v1/projects/${project.id}`)).status()
	).toBe(404);
});
