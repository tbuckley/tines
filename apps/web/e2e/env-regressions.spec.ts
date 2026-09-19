import type {
	ContextItem,
	IssueDetail,
	Project,
	WorkflowResponse,
	ListResponse,
	TinesEvent
} from '@tines/shared';
import { expect, test } from './fixtures';
import { ALICE, RUNROW } from './constants.mjs';
import { apiClient, body, errorBody, gotoHydrated, issuePath, readSettled } from './helpers';

test.use({ signedIn: ALICE });

for (const operation of ['project', 'workflow', 'state'] as const) {
	for (const actor of ['run-env', 'run-prompt', 'key-env', 'session-env'] as const) {
		test(`env cascade ${operation}: ${actor}`, async ({ request, context, uniqueName }) => {
			const owner = apiClient(request, ALICE.apiKey);
			const run = apiClient(request, RUNROW.runKey);
			const workflow = await body<WorkflowResponse>(
				await owner.post('/api/v1/workflows', {
					name: uniqueName('env-cascade'),
					initial_state: 'Keep',
					states: [
						{ name: 'Keep', category: 'backlog' },
						{ name: 'Remove', category: 'done' }
					],
					transitions: []
				})
			);
			const project =
				operation === 'project'
					? await body<Project>(
							await owner.post('/api/v1/projects', { name: uniqueName('env-cascade') })
						)
					: null;
			const scope = project
				? { project_id: project.id }
				: { workflow_state_id: workflow.states.find((s) => s.name === 'Remove')!.id };
			const item = await body<ContextItem>(
				await owner.post('/api/v1/context', {
					...scope,
					...(actor === 'run-prompt'
						? { kind: 'prompt', name: 'ordinary', body: 'allowed' }
						: { kind: 'env', name: 'CREDENTIAL', value: 'test secret', secret: true })
				})
			);
			// Include ordinary context in the rejected batch to prove all-or-nothing behavior.
			const sibling = await body<ContextItem>(
				await owner.post('/api/v1/context', {
					...scope,
					kind: 'prompt',
					name: 'sibling',
					body: 'must survive a rejected cascade'
				})
			);
			const route = project ? `/api/v1/projects/${project.id}` : `/api/v1/workflows/${workflow.id}`;
			const beforeScope = await body(await owner.get(route));
			const relevantEvents = async () => {
				const events = await body<ListResponse<TinesEvent>>(
					await owner.get('/api/v1/events?limit=200')
				);
				return events.items.filter((e) =>
					[project?.id, workflow.id, item.id, sibling.id]
						.filter(Boolean)
						.some((id) => JSON.stringify(e).includes(id!))
				);
			};
			const beforeEvents = await relevantEvents();
			const payload =
				operation === 'state'
					? {
							force_delete_context: true,
							initial_state: 'Keep',
							states: [
								{
									id: workflow.states.find((s) => s.name === 'Keep')!.id,
									name: 'Keep',
									category: 'backlog'
								}
							],
							transitions: []
						}
					: { force_delete_context: true };
			const writer = actor.startsWith('run-') ? run : owner;
			const response =
				actor === 'session-env'
					? await context.request.fetch(route, {
							method: operation === 'state' ? 'PATCH' : 'DELETE',
							data: payload
						})
					: operation === 'state'
						? await writer.patch(route, payload)
						: await writer.delete(route, payload);
			if (actor === 'run-env') {
				expect(response.status(), 'run keys cannot delete env through a scope cascade').toBe(403);
				expect((await errorBody(response)).error.code).toBe('run_key_forbidden');
				expect(await body(await owner.get(route)), 'rejected cascade preserves its scope').toEqual(
					beforeScope
				);
				expect(await body(await owner.get(`/api/v1/context/${item.id}`))).toEqual(item);
				expect(await body(await owner.get(`/api/v1/context/${sibling.id}`))).toEqual(sibling);
				expect(await relevantEvents(), 'rejected cascade emits no events').toEqual(beforeEvents);
			} else {
				expect(
					response.status(),
					'human env and run-key ordinary-context cascades stay authorized'
				).toBe(200);
				expect((await owner.get(`/api/v1/context/${item.id}`)).status()).toBe(404);
				expect((await owner.get(`/api/v1/context/${sibling.id}`)).status()).toBe(404);
				if (operation === 'state') {
					expect(
						(await body<WorkflowResponse>(await owner.get(route))).states.map((s) => s.name)
					).toEqual(['Keep']);
				} else expect((await owner.get(route)).status()).toBe(404);
			}
			// Remove test-owned anchors after assertions; never leave global context behind.
			if (project)
				await owner.delete(`/api/v1/projects/${project.id}`, { force_delete_context: true });
			await owner.delete(`/api/v1/workflows/${workflow.id}`, { force_delete_context: true });
		});
	}
}

for (const width of [1440, 768, 390, 320]) {
	test(`long env name stays within effective section at ${width}px`, async ({
		page,
		apiFor,
		uniqueName
	}, testInfo) => {
		const api = apiFor(ALICE);
		const project = await body<Project>(
			await api.post('/api/v1/projects', { name: uniqueName('env-width') })
		);
		const issue = await body<IssueDetail>(
			await api.post(`/api/v1/projects/${project.id}/issues`, { title: 'Long variable' })
		);
		const name = 'CREDENTIAL_' + 'A'.repeat(89);
		const created = await api.post('/api/v1/context', {
			kind: 'env',
			name,
			value: 'value',
			project_id: project.id
		});
		expect(created.status()).toBe(201);
		await page.setViewportSize({ width, height: 900 });
		await gotoHydrated(page, issuePath(project.name, issue.number));
		if (width < 640) await page.getByRole('button', { name: /^Context / }).click();
		await page.locator('summary').filter({ hasText: 'Effective context' }).click();
		const section = page.getByRole('heading', { name: 'Environment', exact: true }).locator('..');
		const variable = section.getByText(name, { exact: true });
		await expect(variable).toBeVisible();
		const bounds = await readSettled(async () => ({
			name: await variable.boundingBox(),
			section: await section.boundingBox(),
			document: await page.evaluate(() => ({
				width: document.documentElement.scrollWidth,
				viewport: innerWidth
			}))
		}));
		expect(bounds.name!.x, 'full variable name starts within its section').toBeGreaterThanOrEqual(
			bounds.section!.x
		);
		expect(
			bounds.name!.x + bounds.name!.width,
			'full variable name ends within its section'
		).toBeLessThanOrEqual(bounds.section!.x + bounds.section!.width + 1);
		expect(bounds.document.width, 'env name does not widen the page').toBeLessThanOrEqual(
			bounds.document.viewport
		);
		await expect(variable).toHaveText(name);
		expect(
			await variable.evaluate((el) => ({
				clipped: el.scrollWidth > el.clientWidth,
				overflow: getComputedStyle(el).overflow
			}))
		).toEqual({ clipped: false, overflow: 'visible' });
		await page.screenshot({ path: testInfo.outputPath(`env-${width}.png`), fullPage: true });
	});
}

for (const width of [1440, 390]) {
	for (const kind of ['none', 'env', 'mixed'] as const) {
		test(`context summary ${kind} at ${width}px`, async ({ page, apiFor, uniqueName }) => {
			const api = apiFor(ALICE);
			const project = await body<Project>(
				await api.post('/api/v1/projects', { name: uniqueName('env-summary') })
			);
			const issue = await body<IssueDetail>(
				await api.post(`/api/v1/projects/${project.id}/issues`, { title: 'Summary target' })
			);
			if (kind !== 'none') {
				for (const name of ['FIRST', 'SECOND'])
					expect(
						(
							await api.post('/api/v1/context', {
								kind: 'env',
								name,
								value: 'set',
								project_id: project.id
							})
						).status()
					).toBe(201);
			}
			if (kind === 'mixed')
				expect(
					(
						await api.post('/api/v1/context', {
							kind: 'prompt',
							name: 'instructions',
							body: 'instructions',
							project_id: project.id
						})
					).status()
				).toBe(201);
			await page.setViewportSize({ width, height: 900 });
			await gotoHydrated(page, issuePath(project.name, issue.number));
			const summary = kind === 'none' ? 'none' : kind === 'env' ? '2 envs' : '1 prompt, 2 envs';
			if (width < 640) {
				const fold = page.getByRole('button', { name: `Context ${summary}`, exact: true });
				await expect(fold).toBeVisible();
				await expect(fold).toHaveAttribute('aria-expanded', 'false');
			} else {
				await expect(
					page.getByRole('heading', {
						name: kind === 'none' ? 'Context' : `Context (${summary})`,
						exact: true
					})
				).toBeVisible();
			}
		});
	}
}
