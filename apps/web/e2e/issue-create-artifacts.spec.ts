import type { IssueDetail, Project } from '@tines/shared';
import { expect, test } from './fixtures';
import { ALICE } from './constants.mjs';
import { body, clickToOpen, gotoHydrated } from './helpers';

const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64'
);

let project: Project;

test.beforeAll(async ({ apiFor, uniqueName }) => {
	project = await body<Project>(
		await apiFor(ALICE).post('/api/v1/projects', { name: uniqueName('create-files') })
	);
});

test.use({ signedIn: ALICE });

test('creates an issue with generated, editable file artifact names', async ({
	page,
	apiFor,
	workerRequest
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await gotoHydrated(page, '/issues');
	const dialog = page.getByRole('dialog', { name: 'New issue' });
	await clickToOpen(page.getByRole('button', { name: /New issue/ }), dialog);
	await dialog.getByLabel('Project', { exact: true }).selectOption(project.id);
	await dialog.getByLabel('Title').fill('Created with references');
	await dialog.getByLabel('Add attachment files').setInputFiles([
		{ name: 'Screenshot 2026-09-19.png', mimeType: 'image/png', buffer: PNG },
		{ name: 'Screenshot 2026-09-19.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') }
	]);
	await expect(dialog.getByText('screenshot-2026-09-19', { exact: true })).toBeVisible();
	await expect(dialog.getByText('screenshot-2026-09-19-2', { exact: true })).toBeVisible();
	await dialog.getByRole('button', { name: 'Edit name for Screenshot 2026-09-19.txt' }).click();
	await dialog.getByLabel('Artifact name').fill('reference-notes');
	await expect
		.poll(() =>
			page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth
			)
		)
		.toBe(0);
	let releaseCreate!: () => void;
	const heldCreate = new Promise<void>((resolve) => (releaseCreate = resolve));
	await page.route('**/api/v1/projects/*/issues', async (route) => {
		if (route.request().method() !== 'POST') return route.continue();
		await heldCreate;
		await route.continue();
	});
	await dialog.getByRole('button', { name: 'Create issue' }).click();
	await expect(dialog.getByRole('button', { name: 'Creating and attaching…' })).toBeDisabled();
	await expect(dialog.getByLabel('Title')).toBeDisabled();
	await expect(dialog.getByRole('button', { name: 'Close' })).toBeDisabled();
	await page.keyboard.press('Escape');
	await expect(dialog).toBeVisible();
	releaseCreate();

	await expect(page).toHaveURL(new RegExp(`/issues/${project.name}/\\d+$`));
	await expect(page.getByRole('heading', { name: 'Created with references' })).toBeVisible();
	const artifactsFold = page.getByRole('button', { name: /^Artifacts/ });
	if (await artifactsFold.isVisible()) await artifactsFold.click();
	await expect(
		page.getByRole('button', { name: 'screenshot-2026-09-19', exact: true })
	).toBeVisible();
	await expect(page.getByRole('button', { name: 'reference-notes', exact: true })).toBeVisible();
	await expect(page.getByRole('img', { name: 'screenshot-2026-09-19' })).toBeVisible();
	await expect(page.getByText('Screenshot 2026-09-19.png', { exact: true })).toBeVisible();

	const number = Number(new URL(page.url()).pathname.split('/').at(-1));
	const issue = await body<IssueDetail>(
		await apiFor(ALICE).get(`/api/v1/projects/${project.id}/issues/${number}`)
	);
	const download = await workerRequest.get(
		`/api/v1/issues/${issue.id}/artifacts/screenshot-2026-09-19/content`,
		{ headers: { authorization: `Bearer ${ALICE.apiKey}` } }
	);
	expect(download.ok()).toBe(true);
	expect(Buffer.from(await download.body())).toEqual(PNG);
});
