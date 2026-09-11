import type { ContextItem, IssueDetail, ListResponse, Project } from '@tines/shared';
import { expect, test } from '@playwright/test';
import { ALICE } from './constants.mjs';
import { apiClient, body, DESKTOP, gotoHydrated, PHONE, runId, signIn } from './helpers';

test.describe.serial('literal long search', () => {
	const projectName = `literal-search-${runId}`;
	const ascii = 'a'.repeat(49) + 'needle' + 'b'.repeat(145);
	const japanese = 'あ'.repeat(49);
	let project: Project;
	let asciiIssue: IssueDetail;
	let japaneseIssue: IssueDetail;
	let literalIssue: IssueDetail;
	let asciiContext: ContextItem;
	let japaneseContext: ContextItem;
	let literalContext: ContextItem;

	test.beforeAll(async ({ playwright }) => {
		const request = await playwright.request.newContext({
			baseURL: test.info().project.use.baseURL
		});
		const api = apiClient(request, ALICE.apiKey);
		project = await body<Project>(await api.post('/api/v1/projects', { name: projectName }));
		asciiIssue = await body<IssueDetail>(
			await api.post(`/api/v1/projects/${project.id}/issues`, { title: ascii })
		);
		await body(
			await api.post(`/api/v1/projects/${project.id}/issues`, {
				title: `${ascii.slice(0, 48)}x`
			})
		);
		japaneseIssue = await body<IssueDetail>(
			await api.post(`/api/v1/projects/${project.id}/issues`, { title: japanese })
		);
		literalIssue = await body<IssueDetail>(
			await api.post(`/api/v1/projects/${project.id}/issues`, { title: `literal % _ \\ ${runId}` })
		);
		asciiContext = await body<ContextItem>(
			await api.post('/api/v1/context', {
				kind: 'prompt',
				name: `long-search-${runId}`,
				description: ascii,
				project_id: project.id,
				body: ''
			})
		);
		japaneseContext = await body<ContextItem>(
			await api.post('/api/v1/context', {
				kind: 'prompt',
				name: japanese,
				project_id: project.id,
				body: ''
			})
		);
		literalContext = await body<ContextItem>(
			await api.post('/api/v1/context', {
				kind: 'prompt',
				name: `literal-%-_-${runId}`,
				description: `literal % _ \\ ${runId}`,
				project_id: project.id,
				body: ''
			})
		);
		await request.dispose();
	});

	test('native D1 accepts the exact boundary, long and multibyte terms on every API', async ({
		request
	}) => {
		const api = apiClient(request, ALICE.apiKey);
		for (const q of [ascii.slice(0, 48), ascii.slice(0, 49), ascii, japanese]) {
			const expectedIssue = q === japanese ? japaneseIssue.id : asciiIssue.id;
			const expectedContext = q === japanese ? japaneseContext.id : asciiContext.id;
			for (const path of [
				`/api/v1/issues?project=${project.id}&q=${encodeURIComponent(q)}`,
				`/api/v1/projects/${project.id}/issues?q=${encodeURIComponent(q)}`
			]) {
				const res = await api.get(path);
				expect(res.status(), path).toBe(200);
				const ids = (await body<ListResponse<IssueDetail>>(res)).items.map((item) => item.id);
				expect(ids, path).toContain(expectedIssue);
			}
			const contextPath = `/api/v1/context?project=${project.id}&q=${encodeURIComponent(q)}`;
			const contextRes = await api.get(contextPath);
			expect(contextRes.status()).toBe(200);
			expect(
				(await body<ListResponse<ContextItem>>(contextRes)).items.map((item) => item.id)
			).toEqual([expectedContext]);
		}
	});

	test('native D1 treats LIKE metacharacters literally and returns normal empty lists', async ({
		request
	}) => {
		const api = apiClient(request, ALICE.apiKey);
		for (const q of ['%', '_', '\\']) {
			const issues = await body<ListResponse<IssueDetail>>(
				await api.get(`/api/v1/issues?project=${project.id}&q=${encodeURIComponent(q)}`)
			);
			expect(
				issues.items.map((item) => item.id),
				q
			).toEqual([literalIssue.id]);
			const context = await body<ListResponse<ContextItem>>(
				await api.get(`/api/v1/context?project=${project.id}&q=${encodeURIComponent(q)}`)
			);
			expect(
				context.items.map((item) => item.id),
				q
			).toEqual([literalContext.id]);
		}
		const none = encodeURIComponent(`nothing-${'z'.repeat(100)}`);
		expect(
			(await body<ListResponse<IssueDetail>>(await api.get(`/api/v1/issues?q=${none}`))).items
		).toEqual([]);
		expect(
			(await body<ListResponse<ContextItem>>(await api.get(`/api/v1/context?q=${none}`))).items
		).toEqual([]);
	});

	for (const [name, viewport] of [
		['desktop', DESKTOP],
		['mobile', PHONE]
	] as const) {
		test(`${name} issue and context pages preserve a long query through submit and reload`, async ({
			context,
			page,
			request
		}) => {
			await signIn(context, ALICE.sessionToken);
			await page.setViewportSize(viewport);
			await body(
				await apiClient(request, ALICE.apiKey).patch('/api/v1/preferences', {
					focused_project_id: project.id
				})
			);
			const q = ascii.slice(0, 60);
			await gotoHydrated(page, '/issues');
			const issueSearch = page.getByLabel('Search issues');
			if (name === 'mobile')
				await page.getByRole('button', { name: 'Search', exact: true }).click();
			await issueSearch.fill(q);
			await issueSearch.press('Enter');
			await expect(page).toHaveURL(new RegExp(`q=${q}`));
			await expect(page.getByRole('link', { name: ascii })).toBeVisible();
			await page.reload();
			await expect(page.getByRole('link', { name: ascii })).toBeVisible();

			await gotoHydrated(page, '/context');
			const search = page.getByPlaceholder('Search context…');
			await search.fill(q);
			await search.press('Enter');
			await expect(page).toHaveURL(new RegExp(`q=${q}`));
			await expect(page.getByText(asciiContext.name, { exact: true })).toBeVisible();
			await page.reload();
			await expect(page.getByText(asciiContext.name, { exact: true })).toBeVisible();
		});
	}
});
