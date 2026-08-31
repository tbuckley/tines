/**
 * Library export / import across two accounts. Tines is single-tenant per
 * user, so Alice → Bob is the closest thing to "a second deployment" the
 * suite can reach — and it is exactly the property the feature promises:
 * a document exported from one library rebuilds it somewhere that shares
 * none of its ids.
 */
import type { ImportLibraryResponse, LibraryDocument } from '@tines/shared';
import { expect, test, type Page } from '@playwright/test';
import { ALICE, BOB } from './constants.mjs';
import { apiClient, body, runId, signIn } from './helpers';

type ErrorBody = { error: { code: string; message: string } };

/** Everything but the per-export timestamp. */
const comparable = (doc: LibraryDocument) => ({
	workflows: [...doc.workflows].sort((a, b) => a.name.localeCompare(b.name)),
	context: [...doc.context].sort(
		(a, b) => `${a.kind}${a.name}`.localeCompare(`${b.kind}${b.name}`)
	)
});

test.describe.serial('library export / import', () => {
	const workflowName = `Portable ${runId}`;
	const promptName = `portable-${runId}`;

	test('Alice exports a self-contained library', async ({ request }) => {
		const alice = apiClient(request, ALICE.apiKey);
		const wf = await alice.post('/api/v1/workflows', {
			name: workflowName,
			description: 'travels between deployments',
			initial_state: 'Start',
			states: [
				{ name: 'Start', category: 'backlog' },
				{ name: 'Middle', category: 'active' },
				{ name: 'End', category: 'done' }
			],
			transitions: [
				{ name: 'Begin', from: 'Start', to: 'Middle' },
				{
					name: 'Finish',
					from: 'Middle',
					to: 'End',
					requires: [{ artifact: 'report', type: 'text' }]
				}
			]
		});
		expect(wf.ok()).toBe(true);
		const created = await body<{ states: { id: string; name: string }[] }>(wf);
		const middle = created.states.find((s) => s.name === 'Middle')!;

		const item = await alice.post('/api/v1/context', {
			kind: 'prompt',
			name: promptName,
			workflow_state_id: middle.id,
			body: 'Instructions that should travel.'
		});
		expect(item.ok()).toBe(true);

		const res = await alice.get('/api/v1/export');
		expect(res.ok()).toBe(true);
		const doc = await body<LibraryDocument>(res);
		expect(doc.format).toBe('tines.library');
		expect(doc.version).toBe(1);
		expect(doc.workflows.map((w) => w.name)).toContain(workflowName);
		// The system workflow is seeded identically everywhere, so it never travels.
		expect(doc.workflows.map((w) => w.name)).not.toContain('Standard');
		const exported = doc.context.find((c) => c.name === promptName)!;
		expect(exported.scope.state).toEqual({ workflow: workflowName, name: 'Middle' });
		expect(exported.body).toBe('Instructions that should travel.');
	});

	test("Bob imports Alice's export and ends up with the same library", async ({ request }) => {
		const alice = apiClient(request, ALICE.apiKey);
		const bob = apiClient(request, BOB.apiKey);
		const document = await body<LibraryDocument>(await alice.get('/api/v1/export'));

		// The preview writes nothing.
		const dry = await bob.post('/api/v1/import', { document, dry_run: true });
		expect(dry.ok()).toBe(true);
		const preview = await body<ImportLibraryResponse>(dry);
		expect(preview.applied).toBe(false);
		expect(preview.counts.create).toBeGreaterThan(0);

		const applied = await body<ImportLibraryResponse>(
			await bob.post('/api/v1/import', { document })
		);
		expect(applied.applied).toBe(true);
		expect(applied.counts.error).toBe(0);
		// The plan the preview showed is the plan that ran.
		expect(applied.entries.map((e) => `${e.ref} ${e.action}`)).toEqual(
			preview.entries.map((e) => `${e.ref} ${e.action}`)
		);

		const rebuilt = await body<LibraryDocument>(await bob.get('/api/v1/export'));
		expect(comparable(rebuilt)).toEqual(comparable(document));
	});

	test('re-importing the same file creates nothing', async ({ request }) => {
		const alice = apiClient(request, ALICE.apiKey);
		const bob = apiClient(request, BOB.apiKey);
		const document = await body<LibraryDocument>(await alice.get('/api/v1/export'));

		const again = await body<ImportLibraryResponse>(
			await bob.post('/api/v1/import', { document })
		);
		expect(again.counts.create).toBe(0);
		expect(again.counts.error).toBe(0);
		expect(again.counts.skip).toBeGreaterThan(0);
	});

	test('refuses a document from a newer Tines with a readable message', async ({ request }) => {
		const alice = apiClient(request, ALICE.apiKey);
		const document = await body<LibraryDocument>(await alice.get('/api/v1/export'));

		const res = await alice.post('/api/v1/import', {
			document: { ...document, version: 99 }
		});
		expect(res.status()).toBe(422);
		const err = await body<ErrorBody>(res);
		expect(err.error.code).toBe('unsupported_format');
		expect(err.error.message).toMatch(/newer Tines/);
	});
});

/**
 * Upload a file and wait for the page to react to it. Retried as a unit
 * because a `change` event dispatched before hydration finishes is simply
 * lost — the input is server-rendered, its handler is not.
 */
async function upload(page: Page, name: string, data: unknown, settles: () => Promise<void>) {
	await expect(async () => {
		await page.getByLabel('Library file').setInputFiles({
			name,
			mimeType: 'application/json',
			buffer: Buffer.from(JSON.stringify(data))
		});
		await settles();
	}).toPass({ timeout: 20_000 });
}

test.describe('export / import settings page', () => {
	test('previews an uploaded file before writing anything', async ({ context, page, request }) => {
		await signIn(context, ALICE.sessionToken);
		const document = await body<LibraryDocument>(
			await apiClient(request, ALICE.apiKey).get('/api/v1/export')
		);

		await page.goto('/settings/export-import');
		await expect(page.getByRole('heading', { name: 'Export / import' })).toBeVisible();
		await expect(page.getByRole('button', { name: /Download library/ })).toBeVisible();

		// Alice importing her own export collides with everything: all skips.
		const summary = page.getByTestId('import-summary');
		await upload(page, 'library.json', document, async () => {
			await expect(summary).toContainText('Preview of library.json', { timeout: 5000 });
		});
		await expect(summary).toContainText('Nothing has been written yet');
		await expect(page.getByTestId('import-row').first()).toBeVisible();

		await page.getByRole('button', { name: 'Import', exact: true }).click();
		await expect(summary).toContainText('Imported');
		await expect(summary).toContainText('skipped');
	});

	test('rejects a file that is not a library export', async ({ context, page }) => {
		await signIn(context, ALICE.sessionToken);
		await page.goto('/settings/export-import');
		await upload(page, 'not-a-library.json', { hello: 'world' }, async () => {
			await expect(page.getByTestId('import-error')).toContainText('Not a Tines library export', {
				timeout: 5000
			});
		});
	});
});
