import type { IssueDetail, Label, ListResponse, Project } from '@tines/shared';
import { expect, test } from './fixtures';
import { ALICE } from './constants.mjs';
import { body, clickToOpen, gotoHydrated, signedSessionCookie } from './helpers';

const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64'
);

let project: Project;
let recoveryLabel: Label;

async function openListDialog(page: import('@playwright/test').Page) {
	await gotoHydrated(page, '/issues');
	const dialog = page.getByRole('dialog', { name: 'New issue' });
	await clickToOpen(page.getByRole('button', { name: /New issue/ }), dialog);
	await dialog.getByLabel('Project', { exact: true }).selectOption(project.id);
	return dialog;
}

async function addTextFile(
	dialog: import('@playwright/test').Locator,
	name = 'reference.txt',
	contents = 'reference'
) {
	await dialog.getByLabel('Add attachment files').setInputFiles({
		name,
		mimeType: 'text/plain',
		buffer: Buffer.from(contents)
	});
}

async function selectRecoveryLabel(
	page: import('@playwright/test').Page,
	dialog: import('@playwright/test').Locator
) {
	await dialog.getByRole('button', { name: 'Add label' }).click();
	const option = page.getByRole('button', { name: recoveryLabel.name, exact: true });
	await option.press('Enter');
	await expect(option).toHaveAttribute('aria-pressed', 'true');
	await page.keyboard.press('Escape');
}

test.beforeAll(async ({ apiFor, uniqueName }) => {
	const api = apiFor(ALICE);
	project = await body<Project>(
		await api.post('/api/v1/projects', { name: uniqueName('create-files') })
	);
	recoveryLabel = await body<Label>(
		await api.post('/api/v1/labels', { name: uniqueName('attachment-recovery'), color: 'blue' })
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

test('puts indexed server validation on the affected row and preserves the draft', async ({
	page
}) => {
	const dialog = await openListDialog(page);
	await dialog.getByLabel('Title').fill('Keep this title');
	await dialog.getByLabel('Description (Markdown)').fill('Keep this description');
	await dialog.getByLabel('Add attachment files').setInputFiles([
		{ name: 'first.txt', mimeType: 'text/plain', buffer: Buffer.from('first') },
		{ name: 'second.txt', mimeType: 'text/plain', buffer: Buffer.from('second') }
	]);
	await selectRecoveryLabel(page, dialog);
	await dialog.getByRole('button', { name: 'Edit name for first.txt' }).click();
	await dialog.getByLabel('Artifact name').fill('kept-definite-name');
	await page.route('**/api/v1/projects/*/issues', async (route) => {
		if (route.request().method() !== 'POST') return route.continue();
		await route.fulfill({
			status: 422,
			contentType: 'application/json',
			body: JSON.stringify({
				error: {
					code: 'invalid_field',
					message: 'The second filename is invalid',
					details: { attachment_index: 1, field: 'attachments[1].filename' }
				}
			})
		});
	});
	await dialog.getByRole('button', { name: 'Create issue' }).click();
	const secondRow = dialog.getByRole('listitem').filter({ hasText: 'second.txt' });
	await expect(secondRow.getByText('The second filename is invalid')).toBeVisible();
	await expect(secondRow).toBeFocused();
	await expect(secondRow.getByLabel('Artifact name')).toHaveCount(0);
	await expect(dialog.getByLabel('Title')).toHaveValue('Keep this title');
	await expect(dialog.getByLabel('Description (Markdown)')).toHaveValue('Keep this description');
	await expect(dialog.getByText(recoveryLabel.name, { exact: true })).toBeVisible();
	await expect(dialog.getByLabel('Artifact name')).toHaveValue('kept-definite-name');
	await expect(dialog.getByRole('listitem')).toHaveCount(2);
});

test('classifies network, 5xx, and malformed success responses as uncertain without retry', async ({
	page
}) => {
	for (const mode of ['network', 'server', 'malformed'] as const) {
		const dialog = await openListDialog(page);
		await dialog.getByLabel('Title').fill(`Uncertain ${mode}`);
		await dialog.getByLabel('Description (Markdown)').fill(`description ${mode}`);
		await addTextFile(dialog, `${mode}.txt`);
		await selectRecoveryLabel(page, dialog);
		await dialog.getByRole('button', { name: `Edit name for ${mode}.txt` }).click();
		await dialog.getByLabel('Artifact name').fill(`kept-${mode}-name`);
		await dialog.getByRole('button', { name: 'Repeat' }).click();
		await dialog.getByLabel('Repeat', { exact: true }).selectOption('daily');
		await expect(
			dialog.getByText(
				'Attachments are added to this issue only. Future repeats won’t include them.'
			)
		).toBeVisible();

		let attempts = 0;
		await page.route('**/api/v1/projects/*/issues', async (route) => {
			if (route.request().method() !== 'POST') return route.continue();
			attempts++;
			if (mode === 'network') return route.abort('connectionfailed');
			if (mode === 'server') {
				return route.fulfill({
					status: 503,
					contentType: 'application/json',
					body: JSON.stringify({ error: { code: 'unavailable', message: 'Unavailable' } })
				});
			}
			return route.fulfill({ status: 201, contentType: 'application/json', body: '{' });
		});
		await dialog.getByRole('button', { name: 'Create issue + schedule' }).click();
		await expect(
			dialog.getByText(
				'We couldn’t confirm whether the issue was created. Check the project’s issues before submitting again.'
			)
		).toBeVisible();
		await expect(dialog.getByRole('link', { name: 'Check project issues' })).toHaveAttribute(
			'href',
			`/projects/${project.id}`
		);
		await expect(dialog.getByLabel('Title')).toHaveValue(`Uncertain ${mode}`);
		await expect(dialog.getByLabel('Description (Markdown)')).toHaveValue(`description ${mode}`);
		await expect(dialog.getByText(`${mode}.txt`, { exact: true })).toBeVisible();
		await expect(dialog.getByText(recoveryLabel.name, { exact: true })).toBeVisible();
		await expect(dialog.getByLabel('Artifact name')).toHaveValue(`kept-${mode}-name`);
		await expect(dialog.getByLabel('Repeat', { exact: true })).toHaveValue('daily');
		await page.waitForTimeout(100);
		expect(attempts).toBe(1);
		await page.unroute('**/api/v1/projects/*/issues');
		await dialog.getByRole('button', { name: 'Cancel' }).click();
	}
});

test('a navigation failure after 201 offers only the created-issue recovery link', async ({
	page
}) => {
	const dialog = await openListDialog(page);
	await dialog.getByLabel('Title').fill('Created but navigation failed');
	await addTextFile(dialog);
	await page.evaluate(() => {
		history.pushState = () => {
			throw new Error('injected navigation failure');
		};
	});
	await dialog.getByRole('button', { name: 'Create issue' }).click();
	await expect(
		dialog.getByText('The issue was created, but this page could not open it.')
	).toBeVisible();
	await expect(dialog.getByRole('link', { name: 'Open created issue' })).toHaveAttribute(
		'href',
		new RegExp(`/issues/${project.name}/\\d+$`)
	);
	await expect(dialog.getByRole('link', { name: 'Check project issues' })).toHaveCount(0);
});

test('keyboard add, edit, remove, and invalid batches leave existing rows intact', async ({
	page
}) => {
	const dialog = await openListDialog(page);
	const chooserPromise = page.waitForEvent('filechooser');
	await dialog.getByRole('button', { name: 'Add files' }).press('Enter');
	const chooser = await chooserPromise;
	await chooser.setFiles({
		name: 'keyboard.txt',
		mimeType: 'text/plain',
		buffer: Buffer.from('x')
	});
	await dialog.getByRole('button', { name: 'Edit name for keyboard.txt' }).press('Enter');
	await expect(dialog.getByLabel('Artifact name')).toBeFocused();
	await dialog.getByLabel('Artifact name').fill('keyboard-edited');

	await dialog.getByLabel('Add attachment files').setInputFiles(
		Array.from({ length: 10 }, (_, index) => ({
			name: `extra-${index}.txt`,
			mimeType: 'text/plain',
			buffer: Buffer.from(String(index))
		}))
	);
	await expect(dialog.getByText('Choose at most 10 files.')).toBeVisible();
	await expect(dialog.getByRole('listitem')).toHaveCount(1);
	await expect(dialog.getByLabel('Artifact name')).toHaveValue('keyboard-edited');

	await dialog.getByRole('button', { name: 'Remove keyboard.txt' }).press('Enter');
	await expect(dialog.getByRole('listitem')).toHaveCount(0);
	await addTextFile(dialog, 'keyboard.txt');
	await expect(dialog.getByText('keyboard', { exact: true })).toBeVisible();
});

test('rejects a directory drop without disturbing an existing attachment', async ({ page }) => {
	const dialog = await openListDialog(page);
	await addTextFile(dialog, 'kept.txt');
	const dropArea = dialog.getByRole('group', { name: 'Attachment drop area' });
	await dropArea.evaluate((element) => {
		const event = new Event('drop', { bubbles: true, cancelable: true });
		Object.defineProperty(event, 'dataTransfer', {
			value: {
				items: [{ webkitGetAsEntry: () => ({ isDirectory: true }) }],
				files: []
			}
		});
		element.dispatchEvent(event);
	});
	await expect(dialog.getByText('Choose files inside the folder.')).toBeVisible();
	await expect(dialog.getByRole('listitem')).toHaveCount(1);
	await expect(dialog.getByText('kept.txt', { exact: true })).toBeVisible();
});

test('future repeats created by the native Worker do not copy browser attachments', async ({
	page,
	apiFor
}) => {
	const dialog = await openListDialog(page);
	await dialog.getByLabel('Title').fill('Browser recurring attachment');
	await addTextFile(dialog, 'first-instance.txt');
	await dialog.getByRole('button', { name: 'Repeat' }).click();
	await dialog.getByLabel('Repeat', { exact: true }).selectOption('daily');
	await dialog.getByRole('button', { name: 'Create issue + schedule' }).click();
	await expect(page).toHaveURL(new RegExp(`/issues/${project.name}/\\d+$`));

	const api = apiFor(ALICE);
	const number = Number(new URL(page.url()).pathname.split('/').at(-1));
	const first = await body<IssueDetail>(
		await api.get(`/api/v1/projects/${project.id}/issues/${number}`)
	);
	expect(first.scheduled_task_id).not.toBeNull();
	const firstArtifacts = await body<ListResponse<unknown>>(
		await api.get(`/api/v1/issues/${first.id}/artifacts`)
	);
	expect(firstArtifacts.items).toHaveLength(1);

	const repeated = await body<IssueDetail>(
		await api.post(`/api/v1/schedules/${first.scheduled_task_id}/run`)
	);
	const repeatedArtifacts = await body<ListResponse<unknown>>(
		await api.get(`/api/v1/issues/${repeated.id}/artifacts`)
	);
	expect(repeatedArtifacts.items).toEqual([]);
});

test('the issues list and project page expose the shared attachment picker', async ({ page }) => {
	const listDialog = await openListDialog(page);
	await expect(listDialog.getByLabel('Add attachment files')).toBeAttached();
	await listDialog.getByRole('button', { name: 'Cancel' }).click();

	await gotoHydrated(page, `/projects/${project.id}`);
	const projectDialog = page.getByRole('dialog', { name: `New issue in ${project.name}` });
	await clickToOpen(page.getByRole('button', { name: 'New issue' }), projectDialog);
	await expect(projectDialog.getByLabel('Add attachment files')).toBeAttached();
	await expect(projectDialog.getByLabel('Project', { exact: true })).toHaveCount(0);
});

test('native Worker accepts the exact aggregate limit with bearer auth and rejects one byte over', async ({
	workerRequest
}) => {
	const chunk = Buffer.alloc(25 * 1024 * 1024, 7);
	const metadata = (count: number) =>
		JSON.stringify({
			issue: { title: `Native boundary ${count}` },
			attachments: Array.from({ length: count }, (_, index) => ({
				part: `file-${index}`,
				name: `native-${index}`,
				filename: `native-${index}.bin`
			}))
		});
	const exact = await workerRequest.post(`/api/v1/projects/${project.id}/issues`, {
		headers: { authorization: `Bearer ${ALICE.apiKey}` },
		multipart: {
			metadata: metadata(2),
			'file-0': { name: 'zero.bin', mimeType: 'application/octet-stream', buffer: chunk },
			'file-1': { name: 'one.bin', mimeType: 'application/octet-stream', buffer: chunk }
		}
	});
	expect(exact.status()).toBe(201);

	const over = await workerRequest.post(`/api/v1/projects/${project.id}/issues`, {
		headers: { authorization: `Bearer ${ALICE.apiKey}` },
		multipart: {
			metadata: metadata(3),
			'file-0': { name: 'zero.bin', mimeType: 'application/octet-stream', buffer: chunk },
			'file-1': { name: 'one.bin', mimeType: 'application/octet-stream', buffer: chunk },
			'file-2': {
				name: 'extra.bin',
				mimeType: 'application/octet-stream',
				buffer: Buffer.from([1])
			}
		}
	});
	expect(over.status()).toBe(422);
	expect((await over.json()).error.code).toBe('artifact_too_large');
});

test('native Worker cookie-origin protection rejects cross-origin multipart creation', async ({
	workerRequest
}) => {
	const response = await workerRequest.post(`/api/v1/projects/${project.id}/issues`, {
		headers: {
			cookie: `better-auth.session_token=${signedSessionCookie(ALICE.sessionToken)}`,
			origin: 'https://attacker.example'
		},
		multipart: {
			metadata: JSON.stringify({
				issue: { title: 'Must not exist' },
				attachments: [{ part: 'file-0', name: 'blocked', filename: 'blocked.txt' }]
			}),
			'file-0': { name: 'blocked.txt', mimeType: 'text/plain', buffer: Buffer.from('blocked') }
		}
	});
	expect(response.status()).toBe(403);
});
