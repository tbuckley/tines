import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

	await page.getByText(name, { exact: true }).click();
	await expect(page.getByLabel('File 1 path')).toHaveValue('SKILL.md');
	await page.getByRole('button', { name: 'Add file' }).click();
	await page.getByLabel('File 3 path').fill('manual.txt');
	await page.getByLabel('File manual.txt content').fill('unsaved manual edit');
	await page.getByLabel('File nested/readme.txt content').fill('replace me');
	const mutationsBeforeImport = mutations.length;
	await page
		.getByLabel('Skill folder')
		.setInputFiles(path.join(import.meta.dirname, 'fixtures/skill-folder'));
	await expect(page.getByText('Added 1 file; replaced 2; skipped 0 ignored files.')).toBeVisible();
	await expect(page.getByLabel('File nested/readme.txt content')).toHaveValue('Nested content.\n');
	await expect(page.getByLabel('File manual.txt content')).toHaveValue('unsaved manual edit');
	await expect(page.getByLabel(/^File \d+ path$/)).toHaveCount(4);
	await expect.poll(() => mutations.length).toBe(mutationsBeforeImport);

	const updateResponse = page.waitForResponse(
		(response) =>
			response.url().endsWith(`/api/v1/context/${saved.id}`) &&
			response.request().method() === 'PATCH'
	);
	await page.getByRole('button', { name: 'Save' }).click();
	await expect((await updateResponse).status()).toBe(200);
	const updated = await body<ContextItem>(await api.get(`/api/v1/context/${saved.id}`));
	await expect(updated.files).toEqual([
		{
			path: 'SKILL.md',
			content:
				'---\nname: folder-fixture\ndescription: Imported by the folder picker acceptance test.\n---\n\n# Folder fixture\n\nKeep this root file.\n'
		},
		{ path: 'manual.txt', content: 'unsaved manual edit' },
		{ path: 'nested/readme.txt', content: 'Nested content.\n' },
		{ path: 'notes/remove-me.txt', content: 'This row is removed before save.\n' }
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

test('folder errors preserve the draft and an over-limit import remains removable', async ({
	page,
	context
}) => {
	const temp = await mkdtemp(path.join(tmpdir(), 'tines-skill-folder-'));
	const missingRoot = path.join(temp, 'missing-root');
	const malformed = path.join(temp, 'malformed');
	const tooMany = path.join(temp, 'too-many');
	try {
		await mkdir(missingRoot);
		await writeFile(path.join(missingRoot, 'README.md'), 'not a skill');
		await mkdir(malformed);
		await writeFile(path.join(malformed, 'SKILL.md'), '# Valid root');
		await writeFile(path.join(malformed, 'bad.bin'), Buffer.from([0xff]));
		await mkdir(tooMany);
		await writeFile(path.join(tooMany, 'SKILL.md'), '# Big skill');
		await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				writeFile(path.join(tooMany, `file-${i.toString().padStart(2, '0')}.txt`), `${i}`)
			)
		);

		await signIn(context, ALICE.sessionToken);
		await gotoHydrated(page, '/context');
		await page.getByRole('button', { name: 'New item' }).click();
		await page.getByText('Skill — text files seeded into the workspace', { exact: true }).click();
		await page.getByLabel('Name').fill(`folder-validation-${runId}`);
		await page.getByRole('button', { name: 'Add file' }).click();
		await page.getByLabel('File 1 path').fill('draft.txt');
		await page.getByLabel('File draft.txt content').fill('keep me');

		await page.getByLabel('Skill folder').setInputFiles(missingRoot);
		await expect(page.getByRole('alert')).toContainText('must contain SKILL.md at its root');
		await expect(page.getByLabel('File draft.txt content')).toHaveValue('keep me');

		await page.getByLabel('Skill folder').setInputFiles(malformed);
		await expect(page.getByRole('alert')).toContainText('bad.bin');
		await expect(page.getByLabel('File draft.txt content')).toHaveValue('keep me');

		await page.getByLabel('Skill folder').setInputFiles(tooMany);
		await expect(
			page.getByText('Added 21 files; replaced 0; skipped 0 ignored files.')
		).toBeVisible();
		await expect(page.getByText(/22 \/ 20 files/)).toBeVisible();
		await expect(page.getByRole('button', { name: 'Create' })).toBeDisabled();
		await page.getByRole('button', { name: 'Remove file draft.txt' }).click();
		await page.getByRole('button', { name: 'Remove file file-19.txt' }).click();
		await expect(page.getByText(/20 \/ 20 files/)).toBeVisible();
		await expect(page.getByRole('button', { name: 'Create' })).toBeEnabled();

		await page.getByRole('button', { name: 'Remove file SKILL.md' }).click();
		await expect(page.getByRole('alert')).toContainText('Restore SKILL.md');
		await expect(page.getByRole('button', { name: 'Create' })).toBeDisabled();
		await page.getByLabel('File 1 path').fill('SKILL.md');
		await expect(page.getByRole('button', { name: 'Create' })).toBeEnabled();
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});
