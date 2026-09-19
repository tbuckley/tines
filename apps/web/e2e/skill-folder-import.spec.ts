import path from 'node:path';
import type { ContextItem, ListResponse } from '@tines/shared';
import { expect, test } from '@playwright/test';
import { ALICE } from './constants.mjs';
import { apiClient, body, gotoHydrated, runId, signIn } from './helpers';

test('imports a nested skill folder, reviews it, and saves only retained files', async ({
	page,
	context,
	request
}) => {
	const name = `folder-skill-${runId}`;
	await signIn(context, ALICE.sessionToken);
	await gotoHydrated(page, '/context');
	await page.getByRole('button', { name: 'New item' }).click();
	await page.getByText('Skill — text files seeded into the workspace', { exact: true }).click();
	await page.getByLabel('Name').fill(name);

	const mutations: string[] = [];
	page.on('request', (req) => {
		if (req.url().includes('/api/v1/context') && ['POST', 'PATCH'].includes(req.method())) {
			mutations.push(req.method());
		}
	});

	const chooserPromise = page.waitForEvent('filechooser');
	await page.getByRole('button', { name: 'Add from folder' }).click();
	const chooser = await chooserPromise;
	await chooser.setFiles(path.join(import.meta.dirname, 'fixtures/skill-folder'));

	await expect(page.getByText('Added 3 files; replaced 0; skipped 0 ignored files.')).toBeVisible();
	await expect(page.getByLabel('File 1 path')).toHaveValue('SKILL.md');
	await expect(page.getByLabel('File 2 path')).toHaveValue('nested/readme.txt');
	await expect(page.getByLabel('File 3 path')).toHaveValue('notes/remove-me.txt');
	await expect(page.getByLabel('File nested/readme.txt content')).toHaveValue('Nested content.\n');
	await expect.poll(() => mutations).toEqual([]);

	await page.getByRole('button', { name: 'Remove file notes/remove-me.txt' }).click();
	const saveResponse = page.waitForResponse(
		(response) =>
			response.url().endsWith('/api/v1/context') && response.request().method() === 'POST'
	);
	await page.getByRole('button', { name: 'Create' }).click();
	await expect((await saveResponse).status()).toBe(201);

	const api = apiClient(request, ALICE.apiKey);
	const listed = await body<ListResponse<ContextItem>>(
		await api.get(`/api/v1/context?q=${encodeURIComponent(name)}`)
	);
	const saved = await body<ContextItem>(await api.get(`/api/v1/context/${listed.items[0].id}`));
	await expect(saved.files).toEqual([
		{
			path: 'SKILL.md',
			content:
				'---\nname: folder-fixture\ndescription: Imported by the folder picker acceptance test.\n---\n\n# Folder fixture\n\nKeep this root file.\n'
		},
		{ path: 'nested/readme.txt', content: 'Nested content.\n' }
	]);
});

test('unsupported directory picking leaves manual skill editing available', async ({
	page,
	context
}) => {
	await page.addInitScript(() => {
		delete (HTMLInputElement.prototype as Partial<HTMLInputElement>).webkitdirectory;
	});
	await signIn(context, ALICE.sessionToken);
	await gotoHydrated(page, '/context');
	await page.getByRole('button', { name: 'New item' }).click();
	await page.getByText('Skill — text files seeded into the workspace', { exact: true }).click();
	await expect(page.getByRole('button', { name: 'Add from folder' })).toBeDisabled();
	await expect(
		page.getByText('Folder selection is not supported by this browser; add files individually.')
	).toBeVisible();
	await page.getByRole('button', { name: 'Add file' }).click();
	await page.getByLabel('File 1 path').fill('legacy.txt');
	await page.getByLabel('File legacy.txt content').fill('manual content');
	await expect(page.getByLabel('File legacy.txt content')).toHaveValue('manual content');
});
