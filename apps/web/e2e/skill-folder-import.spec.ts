import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { ContextItem, ListResponse } from '@tines/shared';
import { ALICE } from './constants.mjs';
import { apiClient, body, DESKTOP, gotoHydrated, PHONE, runId, signIn } from './helpers';
import { expect, test } from './fixtures';

function barrier() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => (release = resolve));
	return { promise, release };
}

type DelayedFolderReadWindow = Window & {
	__folderReadStarted?: boolean;
	__releaseFolderRead?: () => Promise<void>;
};

test('imports declared metadata, reviews files, and persists only retained files', async ({
	page,
	context,
	request,
	uniqueName
}) => {
	const temp = await mkdtemp(path.join(tmpdir(), 'tines-skill-prefill-'));
	const folder = path.join(temp, 'skill');
	const name = uniqueName('folder-skill');
	const description = 'Imported by the folder picker acceptance test.';
	const rootContent = `---\nname: ${name}\ndescription: ${description}\n---\n\n# Folder fixture\n\nKeep this root file.\n`;
	let savedId: string | undefined;
	const api = apiClient(request, ALICE.apiKey);
	try {
		await mkdir(path.join(folder, 'nested'), { recursive: true });
		await mkdir(path.join(folder, 'notes'));
		await writeFile(path.join(folder, 'SKILL.md'), rootContent);
		await writeFile(path.join(folder, 'nested/readme.txt'), 'Nested content.\n');
		await writeFile(path.join(folder, 'notes/remove-me.txt'), 'Remove this file.\n');

		await signIn(context, ALICE.sessionToken);
		await gotoHydrated(page, '/context');
		await page.getByRole('button', { name: 'New item' }).click();
		await page.getByText('Skill — text files seeded into the workspace', { exact: true }).click();
		const originalProject = await page.getByLabel('Project', { exact: true }).inputValue();

		const mutations: string[] = [];
		page.on('request', (req) => {
			if (req.url().includes('/api/v1/context') && ['POST', 'PATCH'].includes(req.method())) {
				mutations.push(req.method());
			}
		});

		const chooserPromise = page.waitForEvent('filechooser');
		await page.getByRole('button', { name: 'Add from folder' }).click();
		const chooser = await chooserPromise;
		await chooser.setFiles(folder);

		await expect(
			page.getByText('Added 3 files; replaced 0; skipped 0 ignored files.')
		).toBeVisible();
		await expect(page.getByLabel('Name')).toHaveValue(name);
		await expect(page.getByLabel('Description')).toHaveValue(description);
		await expect(page.getByText('From SKILL.md')).toHaveCount(2);
		await expect(page.getByLabel('Name')).toHaveAttribute(
			'aria-describedby',
			/ctx-name-override ctx-name-skill-source/
		);
		await expect(page.getByLabel('Description')).toHaveAttribute(
			'aria-describedby',
			'ctx-description-skill-source'
		);
		expect(await page.getByLabel('Project', { exact: true }).inputValue()).toBe(originalProject);
		await expect(page.getByRole('button', { name: 'Create' })).toBeEnabled();
		await expect(page.getByLabel('File 1 path')).toHaveValue('SKILL.md');
		await expect(page.getByLabel('File 2 path')).toHaveValue('nested/readme.txt');
		await expect(page.getByLabel('File 3 path')).toHaveValue('notes/remove-me.txt');
		await expect(page.getByLabel('File nested/readme.txt content')).toHaveValue(
			'Nested content.\n'
		);
		await expect.poll(() => mutations).toEqual([]);

		await page.getByRole('button', { name: 'Remove file notes/remove-me.txt' }).click();
		const saveResponse = page.waitForResponse(
			(response) =>
				response.url().endsWith('/api/v1/context') && response.request().method() === 'POST'
		);
		await page.getByRole('button', { name: 'Create' }).click();
		await expect((await saveResponse).status()).toBe(201);

		const listed = await body<ListResponse<ContextItem>>(
			await api.get(`/api/v1/context?q=${encodeURIComponent(name)}`)
		);
		const saved = await body<ContextItem>(await api.get(`/api/v1/context/${listed.items[0].id}`));
		savedId = saved.id;
		expect(saved).toMatchObject({ name, description });
		expect(saved.files).toEqual([
			{ path: 'SKILL.md', content: rootContent },
			{ path: 'nested/readme.txt', content: 'Nested content.\n' }
		]);

		await page.getByText(name, { exact: true }).click();
		await expect(page.getByLabel('Name')).toHaveValue(name);
		await expect(page.getByLabel('Description')).toHaveValue(description);
		await expect(page.getByText('From SKILL.md')).toHaveCount(0);
		await expect(page.getByLabel('File 1 path')).toHaveValue('SKILL.md');
		await page.getByRole('button', { name: 'Add file' }).click();
		await page.getByLabel('File 3 path').fill('manual.txt');
		await page.getByLabel('File manual.txt content').fill('unsaved manual edit');
		await page.getByLabel('File nested/readme.txt content').fill('replace me');
		const mutationsBeforeImport = mutations.length;
		await page.getByLabel('Skill folder').setInputFiles(folder);
		await expect(
			page.getByText('Added 1 file; replaced 2; skipped 0 ignored files.')
		).toBeVisible();
		await expect(page.getByLabel('File nested/readme.txt content')).toHaveValue(
			'Nested content.\n'
		);
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
		expect(updated).toMatchObject({ name, description });
		expect(updated.files).toEqual([
			{ path: 'SKILL.md', content: rootContent },
			{ path: 'manual.txt', content: 'unsaved manual edit' },
			{ path: 'nested/readme.txt', content: 'Nested content.\n' },
			{ path: 'notes/remove-me.txt', content: 'Remove this file.\n' }
		]);
	} finally {
		if (savedId) expect((await api.delete(`/api/v1/context/${savedId}`)).status()).toBe(204);
		await rm(temp, { recursive: true, force: true });
	}
});

test('a completed folder read cannot enter a reopened draft', async ({ page, context }) => {
	await page.addInitScript(() => {
		const state = window as DelayedFolderReadWindow;
		const originalArrayBuffer = File.prototype.arrayBuffer;
		let held = false;
		File.prototype.arrayBuffer = function () {
			if (held) return originalArrayBuffer.call(this);
			held = true;
			return new Promise<ArrayBuffer>((resolve, reject) => {
				state.__folderReadStarted = true;
				state.__releaseFolderRead = async () => {
					try {
						resolve(await originalArrayBuffer.call(this));
					} catch (error) {
						reject(error);
					}
				};
			});
		};
	});

	await signIn(context, ALICE.sessionToken);
	await gotoHydrated(page, '/context');
	await page.getByRole('button', { name: 'New item' }).click();
	await page.getByText('Skill — text files seeded into the workspace', { exact: true }).click();
	await page
		.getByLabel('Skill folder')
		.setInputFiles(path.join(import.meta.dirname, 'fixtures/skill-folder'));
	await expect(page.locator('[aria-live="polite"]', { hasText: 'Reading folder…' })).toBeVisible();
	await expect
		.poll(() =>
			page.evaluate(() => Boolean((window as DelayedFolderReadWindow).__folderReadStarted))
		)
		.toBe(true);
	await page.getByRole('button', { name: 'Cancel' }).click();

	await page.getByRole('button', { name: 'New item' }).click();
	await page.getByText('Skill — text files seeded into the workspace', { exact: true }).click();
	await page.getByLabel('Name').fill(`current-folder-draft-${runId}`);
	await page.getByRole('button', { name: 'Add file' }).click();
	await page.getByLabel('File 1 path').fill('current.txt');
	await page.getByLabel('File current.txt content').fill('current draft');

	await page.evaluate(() => (window as DelayedFolderReadWindow).__releaseFolderRead?.());
	await expect(page.getByLabel('Name')).toHaveValue(`current-folder-draft-${runId}`);
	await expect(page.getByLabel('Description')).toHaveValue('');
	await expect(page.getByText('From SKILL.md')).toHaveCount(0);
	await expect(page.getByLabel('File current.txt content')).toHaveValue('current draft');
	await expect(page.getByLabel(/^File \d+ path$/)).toHaveCount(1);
	await expect(page.getByText(/Added \d+ files?/)).toHaveCount(0);
	await expect(page.getByRole('alert')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Add file' })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Create' })).toBeEnabled();
});

test('typing and clearing metadata during a folder read keeps user ownership', async ({
	page,
	context
}) => {
	await page.addInitScript(() => {
		const state = window as DelayedFolderReadWindow;
		const originalArrayBuffer = File.prototype.arrayBuffer;
		let held = false;
		File.prototype.arrayBuffer = function () {
			if (held) return originalArrayBuffer.call(this);
			held = true;
			return new Promise<ArrayBuffer>((resolve, reject) => {
				state.__folderReadStarted = true;
				state.__releaseFolderRead = async () => {
					try {
						resolve(await originalArrayBuffer.call(this));
					} catch (error) {
						reject(error);
					}
				};
			});
		};
	});

	await signIn(context, ALICE.sessionToken);
	await gotoHydrated(page, '/context');
	await page.getByRole('button', { name: 'New item' }).click();
	await page.getByText('Skill — text files seeded into the workspace', { exact: true }).click();
	await page
		.getByLabel('Skill folder')
		.setInputFiles(path.join(import.meta.dirname, 'fixtures/skill-folder'));
	await expect
		.poll(() =>
			page.evaluate(() => Boolean((window as DelayedFolderReadWindow).__folderReadStarted))
		)
		.toBe(true);
	await page.getByLabel('Name').fill('typed-during-read');
	await page.getByLabel('Description').fill('then cleared');
	await page.getByLabel('Description').fill('');

	await page.evaluate(() => (window as DelayedFolderReadWindow).__releaseFolderRead?.());
	await expect(page.getByText('Added 3 files; replaced 0; skipped 0 ignored files.')).toBeVisible();
	await expect(page.getByLabel('Name')).toHaveValue('typed-during-read');
	await expect(page.getByLabel('Description')).toHaveValue('');
	await expect(page.getByText('From SKILL.md')).toHaveCount(0);
});

test('preserves user-owned metadata and ignores later folder metadata', async ({
	page,
	context,
	uniqueName
}) => {
	const temp = await mkdtemp(path.join(tmpdir(), 'tines-skill-ownership-'));
	const first = path.join(temp, 'first');
	const second = path.join(temp, 'second');
	const firstName = uniqueName('first-skill');
	const secondName = uniqueName('second-skill');
	try {
		await mkdir(first);
		await mkdir(second);
		await writeFile(
			path.join(first, 'SKILL.md'),
			`---\nname: ${firstName}\ndescription: First imported description\n---\n# First\n`
		);
		await writeFile(
			path.join(second, 'SKILL.md'),
			`---\nname: ${secondName}\ndescription: Second imported description\n---\n# Second\n`
		);

		await signIn(context, ALICE.sessionToken);
		await gotoHydrated(page, '/context');
		await page.getByRole('button', { name: 'New item' }).click();
		await page.getByText('Skill — text files seeded into the workspace', { exact: true }).click();
		await page.getByLabel('Name').fill('manual-name');
		await page.getByLabel('Skill folder').setInputFiles(first);

		await expect(page.getByLabel('Name')).toHaveValue('manual-name');
		await expect(page.getByLabel('Description')).toHaveValue('First imported description');
		await expect(page.getByText('From SKILL.md')).toHaveCount(1);
		await page.getByLabel('Description').fill('');
		await page.getByLabel('Name').fill('');
		await expect(page.getByText('From SKILL.md')).toHaveCount(0);

		await page.getByLabel('Skill folder').setInputFiles(second);
		await expect(
			page.getByText('Added 0 files; replaced 1; skipped 0 ignored files.')
		).toBeVisible();
		await expect(page.getByLabel('Name')).toHaveValue('');
		await expect(page.getByLabel('Description')).toHaveValue('');
		await expect(page.getByText('From SKILL.md')).toHaveCount(0);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});

test('metadata hints fit desktop and phone layouts in light and dark themes', async ({
	page,
	context
}) => {
	await signIn(context, ALICE.sessionToken);
	for (const [viewportName, viewport] of [
		['desktop', DESKTOP],
		['phone', PHONE]
	] as const) {
		for (const colorScheme of ['light', 'dark'] as const) {
			await page.setViewportSize(viewport);
			await page.emulateMedia({ colorScheme });
			await gotoHydrated(page, '/context');
			await page.getByRole('button', { name: 'New item' }).click();
			await page.getByText('Skill — text files seeded into the workspace', { exact: true }).click();
			await page
				.getByLabel('Skill folder')
				.setInputFiles(path.join(import.meta.dirname, 'fixtures/skill-folder'));
			await expect(page.getByText('From SKILL.md')).toHaveCount(2);
			await expect(page.locator('html')).toHaveClass(
				colorScheme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/
			);
			expect(
				await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
			).toBe(true);
			for (const hint of await page.getByText('From SKILL.md').all()) {
				const box = await hint.boundingBox();
				expect(box).not.toBeNull();
				expect(box!.x).toBeGreaterThanOrEqual(0);
				expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
			}
			await page.screenshot({
				path: `test-results/skill-metadata-${viewportName}-${colorScheme}.png`
			});
			await page.getByRole('button', { name: 'Cancel' }).click();
		}
	}
});

test('a stale edit response cannot replace files loaded after reopening', async ({
	page,
	context,
	request
}) => {
	const api = apiClient(request, ALICE.apiKey);
	const name = `folder-detail-race-${runId}`;
	const item = await body<ContextItem>(
		await api.post('/api/v1/context', {
			kind: 'skill',
			name,
			files: [{ path: 'server.txt', content: 'server content' }]
		})
	);
	try {
		const first = barrier();
		const second = barrier();
		let requests = 0;
		await page.route(`**/api/v1/context/${item.id}`, async (route) => {
			const requestNumber = ++requests;
			await (requestNumber === 1 ? first.promise : second.promise);
			await route.fulfill({
				json: {
					...item,
					files:
						requestNumber === 1
							? [{ path: 'stale.txt', content: 'stale response' }]
							: [{ path: 'current.txt', content: 'current response' }]
				}
			});
		});

		await signIn(context, ALICE.sessionToken);
		await gotoHydrated(page, '/context');
		await page.getByText(name, { exact: true }).click();
		await expect.poll(() => requests).toBe(1);
		await page.getByRole('button', { name: 'Cancel' }).click();
		await page.getByText(name, { exact: true }).click();
		await expect.poll(() => requests).toBe(2);

		second.release();
		await expect(page.getByLabel('File current.txt content')).toHaveValue('current response');
		first.release();
		await expect(page.getByLabel('File current.txt content')).toHaveValue('current response');
		await expect(page.getByLabel('File stale.txt content')).toHaveCount(0);
		await expect(page.getByLabel(/^File \d+ path$/)).toHaveCount(1);
		await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled();
	} finally {
		expect((await api.delete(`/api/v1/context/${item.id}`)).status()).toBe(204);
	}
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
