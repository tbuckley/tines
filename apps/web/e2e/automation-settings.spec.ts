import { expect, test } from '@playwright/test';
import type { IssueDetail, Project } from '@tines/shared';
import { MANAGED_SETTINGS, STOPPED_FIRST_RUN } from './constants.mjs';
import { apiClient, body, gotoHydrated, runId, signIn } from './helpers';

test('a saved pre-first-run stop is preserved and Resume is the sole action on both surfaces', async ({
	context,
	page,
	request
}) => {
	const api = apiClient(request, STOPPED_FIRST_RUN.apiKey);
	await api.put('/api/v1/supervisor/settings', { attempt_limit: 5 });
	expect(
		await body<{ enabled: boolean }>(await api.get('/api/v1/supervisor/settings'))
	).toMatchObject({
		enabled: false
	});
	const project = await body<Project>(
		await api.post('/api/v1/projects', { name: `stopped-first-run-${runId}` })
	);
	const issue = await body<IssueDetail>(
		await api.post(`/api/v1/projects/${project.id}/issues`, { title: 'Title only while stopped' })
	);

	await signIn(context, STOPPED_FIRST_RUN.sessionToken);
	await gotoHydrated(page, '/agents');
	let checklist = page.getByRole('region', { name: 'First run checklist' });
	await expect(checklist.getByRole('button', { name: 'Resume automation' })).toBeVisible();
	await expect(checklist.locator('button, a[href]')).toHaveCount(1);

	await gotoHydrated(page, `/issues/${encodeURIComponent(project.name)}/${issue.number}`);
	checklist = page.getByRole('region', { name: 'First run checklist' });
	await expect(checklist.getByRole('button', { name: 'Resume automation' })).toBeVisible();
	await expect(checklist.locator('button, a[href]')).toHaveCount(1);
	await checklist.getByRole('button', { name: 'Resume automation' }).click();
	await expect(checklist.getByText('Automation is on.')).toBeVisible();
	expect(
		await body<{ enabled: boolean }>(await api.get('/api/v1/supervisor/settings'))
	).toMatchObject({
		enabled: true
	});
});

test('managed PAT writes inherit the default and preserve a saved stop', async ({ request }) => {
	const api = apiClient(request, MANAGED_SETTINGS.apiKey);
	expect(
		await body<{ enabled: boolean }>(await api.get('/api/v1/supervisor/settings'))
	).toMatchObject({
		enabled: true
	});
	const pat = 'github_pat_11AAAA0abcdefghijklmn';
	let settings = await body<{ enabled: boolean; github_pat_hint: string | null }>(
		await api.put('/api/v1/supervisor/settings', { github_pat: pat })
	);
	expect(settings).toMatchObject({ enabled: true, github_pat_hint: 'github_p…klmn' });

	await api.put('/api/v1/supervisor/settings', { enabled: false });
	settings = await body<{ enabled: boolean; github_pat_hint: string | null }>(
		await api.put('/api/v1/supervisor/settings', {
			github_pat: 'github_pat_11BBBB0abcdefghij'
		})
	);
	expect(settings).toMatchObject({ enabled: false, github_pat_hint: 'github_p…ghij' });
});
