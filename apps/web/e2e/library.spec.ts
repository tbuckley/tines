/**
 * Library export / import across two accounts. Tines is single-tenant per
 * user, so Alice → Bob is the closest thing to "a second deployment" the
 * suite can reach — and it is exactly the property the feature promises:
 * a document exported from one library rebuilds it somewhere that shares
 * none of its ids.
 */
import type { ImportLibraryResponse, LibraryDocument } from '@tines/shared';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { ALICE, BOB, RUNROW } from './constants.mjs';
import { apiClient, body, errorBody, gotoHydrated, runId, signIn } from './helpers';

/** Everything but the per-export timestamp. */
const comparable = (doc: LibraryDocument) => ({
	workflows: [...doc.workflows].sort((a, b) => a.name.localeCompare(b.name)),
	context: [...doc.context].sort((a, b) => `${a.kind}${a.name}`.localeCompare(`${b.kind}${b.name}`))
});

/** One workflow's inheritance pointers, as `<state> -> <ref>`. */
const pointersOf = (doc: LibraryDocument, workflow: string) =>
	(doc.workflows.find((w) => w.name === workflow)?.states ?? [])
		.filter((s) => s.inherits_from)
		.map((s) => `${s.name} -> ${s.inherits_from}`)
		.sort();

test.describe.serial('library export / import', () => {
	const workflowName = `Portable ${runId}`;
	const promptName = `portable-${runId}`;
	const projectName = `portable-project-${runId}`;

	test('Alice exports a self-contained library', async ({ request }) => {
		const alice = apiClient(request, ALICE.apiKey);
		const wf = await alice.post('/api/v1/workflows', {
			name: workflowName,
			description: 'travels between deployments',
			initial_state: 'Start',
			states: [
				// Two inheritance pointers: one at the standard workflow, which
				// never travels and has to be re-found by name on the other
				// side, and one inside this workflow.
				{ name: 'Start', category: 'backlog', inherits_from: 'wfs_std_open' },
				{ name: 'Middle', category: 'active', inherits_from: 'Start' },
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
		const created = await body<{ id: string; states: { id: string; name: string }[] }>(wf);
		const middle = created.states.find((s) => s.name === 'Middle')!;

		// A project whose default workflow is the one travelling with it: the
		// pointer is by name in the document and has to be re-resolved there.
		const project = await alice.post('/api/v1/projects', {
			name: projectName,
			default_workflow_id: created.id
		});
		expect(project.ok()).toBe(true);

		const item = await alice.post('/api/v1/context', {
			kind: 'prompt',
			name: promptName,
			workflow_state_id: middle.id,
			body: 'Instructions that should travel.'
		});
		expect(item.ok()).toBe(true);

		const res = await alice.get('/api/v1/export?version=2');
		expect(res.ok()).toBe(true);
		const doc = await body<LibraryDocument>(res);
		expect(doc.format).toBe('tines.library');
		expect(doc.version).toBe(2);
		expect(doc.workflows.map((w) => w.name)).toContain(workflowName);
		// The system workflow is seeded identically everywhere, so it never travels.
		expect(doc.workflows.map((w) => w.name)).not.toContain('Standard');
		expect(doc.projects.find((p) => p.name === projectName)?.default_workflow).toBe(workflowName);
		expect(pointersOf(doc, workflowName)).toEqual([
			`Middle -> ${workflowName}/Start`,
			'Start -> Standard/Open'
		]);
		const exported = doc.context.find((c) => c.name === promptName)!;
		expect(exported.scope.state).toEqual({ workflow: workflowName, name: 'Middle' });
		expect(exported.body).toBe('Instructions that should travel.');
	});

	test("Bob imports Alice's export and ends up with the same library", async ({ request }) => {
		const alice = apiClient(request, ALICE.apiKey);
		const bob = apiClient(request, BOB.apiKey);
		const document = await body<LibraryDocument>(await alice.get('/api/v1/export?version=2'));

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

		const rebuilt = await body<LibraryDocument>(await bob.get('/api/v1/export?version=2'));
		expect(comparable(rebuilt)).toEqual(comparable(document));
		// Both pointers survived the trip, re-resolved against Bob's own ids.
		expect(pointersOf(rebuilt, workflowName)).toEqual(pointersOf(document, workflowName));
		// Projects are compared by the one this suite creates: Bob has a library
		// of his own, so his export is a superset rather than the same document.
		expect(rebuilt.projects.find((p) => p.name === projectName)?.default_workflow).toBe(
			workflowName
		);
	});

	test('re-importing the same file creates nothing', async ({ request }) => {
		const alice = apiClient(request, ALICE.apiKey);
		const bob = apiClient(request, BOB.apiKey);
		const document = await body<LibraryDocument>(await alice.get('/api/v1/export?version=2'));

		const again = await body<ImportLibraryResponse>(await bob.post('/api/v1/import', { document }));
		expect(again.counts.create).toBe(0);
		expect(again.counts.error).toBe(0);
		expect(again.counts.skip).toBeGreaterThan(0);
	});

	test('refuses a document from a newer Tines with a readable message', async ({ request }) => {
		const alice = apiClient(request, ALICE.apiKey);
		const document = await body<LibraryDocument>(await alice.get('/api/v1/export?version=2'));

		const res = await alice.post('/api/v1/import', {
			document: { ...document, version: 99 }
		});
		expect(res.status()).toBe(422);
		const err = await errorBody(res);
		expect(err.error.code).toBe('unsupported_format');
		expect(err.error.message).toMatch(/newer Tines/);
	});

	test('refuses a body that is valid JSON but not an object', async ({ request }) => {
		const res = await request.post('/api/v1/import', {
			headers: { authorization: `Bearer ${ALICE.apiKey}`, 'content-type': 'application/json' },
			data: 'null'
		});
		expect(res.status()).toBe(400);
		const err = await errorBody(res);
		expect(err.error.code).toBe('invalid_json');
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
			await apiClient(request, ALICE.apiKey).get('/api/v1/export?version=2')
		);

		await gotoHydrated(page, '/settings/export-import');
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
		// Exact wording, so a mangled past tense ("skippedd") cannot pass here.
		await expect(summary).toContainText(/\d+ skipped\./);
	});

	// The picker used to be a bare `<input type="file">`, whose browser chrome
	// ("Choose File  No file chosen") ignores the app palette entirely.
	test('the file picker is an app button, and names the chosen file', async ({ context, page }) => {
		await signIn(context, ALICE.sessionToken);
		await gotoHydrated(page, '/settings/export-import');

		// The input is still there and still labelled — it is only clipped, so it
		// keeps its place in the tab order and its accessible name. `sr-only`
		// leaves a 1px box behind, which Playwright still counts as visible, so
		// the check is on the painted size rather than `not.toBeVisible()`.
		const input = page.getByLabel('Library file');
		await expect(input).toBeAttached();
		const painted = await input.boundingBox();
		expect(painted?.width).toBeLessThanOrEqual(1);
		expect(painted?.height).toBeLessThanOrEqual(1);

		// What a sighted user sees instead: a control with the same geometry as
		// the "Download library" button it sits beside, and the filename spelled
		// out rather than left to the browser.
		const picker = page.locator('label:has(input[type="file"])');
		await expect(picker).toBeVisible();
		await expect(picker).toContainText('Choose file');

		// Same geometry as the button beside it (the fill differs: this one is
		// the outline variant, which is also why it draws a border at all).
		const box = (target: Locator) =>
			target.evaluate((el) => {
				const s = getComputedStyle(el);
				return { height: s.height, radius: s.borderRadius };
			});
		expect(await box(picker)).toEqual(
			await box(page.getByRole('button', { name: /Download library/ }))
		);
		expect(await picker.evaluate((el) => getComputedStyle(el).borderTopWidth)).not.toBe('0px');

		await expect(page.getByText('No file chosen')).toBeVisible();

		await upload(page, 'named-library.json', { hello: 'world' }, async () => {
			await expect(page.getByText('named-library.json', { exact: true })).toBeVisible({
				timeout: 5000
			});
		});
		await expect(page.getByText('No file chosen')).toHaveCount(0);
	});

	test('rejects a file that is not a library export', async ({ context, page }) => {
		await signIn(context, ALICE.sessionToken);
		await gotoHydrated(page, '/settings/export-import');
		await upload(page, 'not-a-library.json', { hello: 'world' }, async () => {
			await expect(page.getByTestId('import-error')).toContainText('Not a Tines library export', {
				timeout: 5000
			});
		});
	});
});

test('file preview exposes legacy ambiguous workflows and invalid project names before any write', async ({
	context,
	page,
	request
}) => {
	await signIn(context, ALICE.sessionToken);
	await gotoHydrated(page, '/settings/export-import');
	const name = `Ambiguous-file-${runId}`;
	const workflow = {
		name,
		initial_state: 'Work',
		states: [{ name: 'Work', category: 'active' }],
		transitions: []
	};
	const document = {
		format: 'tines.library',
		version: 2,
		exported_at: 1,
		projects: [{ name: 'x'.repeat(201) }],
		workflows: [workflow, workflow],
		context: [
			{
				kind: 'prompt',
				name: 'instructions',
				body: 'Ambiguous recipient',
				scope: { state: { workflow: name, name: 'Work' } }
			}
		]
	};
	await upload(page, 'invalid-collisions.json', document, async () => {
		await expect(page.getByTestId('import-summary')).toContainText('Nothing has been written yet');
	});
	const rows = page.getByTestId('import-row');
	await expect(rows).toHaveCount(4);
	await expect(rows.filter({ hasText: /at most 200/ })).toHaveCount(1);
	await expect(rows.filter({ hasText: /ambiguous workflow name/ })).toHaveCount(3);
	const api = apiClient(request, ALICE.apiKey);
	const exported = await body<LibraryDocument>(await api.get('/api/v1/export?version=2'));
	expect(exported.workflows.some((w) => w.name === name)).toBe(false);
	// Apply's report agrees with the visible preview; no wrongly-scoped prompt is created.
	const applied = await body<ImportLibraryResponse>(await api.post('/api/v1/import', { document }));
	expect(applied.counts).toMatchObject({ refuse: 3, error: 1, create: 0 });
});

test('v3 browser file transfer maps duplicate workflows and distinct prompts into renamed copies', async ({
	context,
	page,
	request
}) => {
	const alice = apiClient(request, ALICE.apiKey);
	const bob = apiClient(request, BOB.apiKey);
	const name = `Duplicate file ${runId}`;
	for (const text of ['First instructions', 'Second instructions']) {
		const response = await alice.post('/api/v1/workflows', {
			name,
			initial_state: 'Ready',
			states: [{ name: 'Ready', category: 'active' }],
			transitions: []
		});
		expect(response.ok()).toBe(true);
		const workflow = await body<{ id: string; states: { id: string }[] }>(response);
		expect(
			(
				await alice.post('/api/v1/context', {
					kind: 'prompt',
					name: 'instructions',
					body: text,
					workflow_state_id: workflow.states[0].id
				})
			).ok()
		).toBe(true);
	}
	expect(
		(
			await bob.post('/api/v1/workflows', {
				name,
				initial_state: 'Ready',
				states: [{ name: 'Ready', category: 'active' }],
				transitions: []
			})
		).ok()
	).toBe(true);
	// Download the real browser artifact, then upload its bytes as the second account.
	await signIn(context, ALICE.sessionToken);
	await gotoHydrated(page, '/settings/export-import');
	const downloadPromise = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Download library', exact: true }).click();
	const download = await downloadPromise;
	const file = await download.path();
	const { readFile } = await import('node:fs/promises');
	const bytes = await readFile(file!);
	const document = JSON.parse(bytes.toString()) as import('@tines/shared').LibraryV3Document;
	expect(document.version).toBe(3);
	expect(document.profile).toBe('library');
	const duplicates = document.workflows.filter((w) => w.name === name);
	expect(duplicates).toHaveLength(2);
	await signIn(context, BOB.sessionToken);
	await gotoHydrated(page, '/settings/export-import');
	await page.getByLabel('Library file').setInputFiles({
		name: 'downloaded-library.json',
		mimeType: 'application/json',
		buffer: bytes
	});
	await expect(page.getByTestId('import-summary')).toContainText('Nothing has been written yet');
	for (const [index, workflow] of duplicates.entries()) {
		await expect(page.getByLabel(`Destination for ${workflow.id}`, { exact: true })).toHaveValue(
			'create'
		);
		const input = page.getByLabel(`Create name for ${workflow.id}`, { exact: true });
		await input.fill(`${name} copy ${index}`);
		// Editing invalidates the preceding review before blur starts a fresh preview.
		await expect(page.getByRole('button', { name: 'Import', exact: true })).toHaveCount(0);
		await input.blur();
		await expect(page.getByTestId('import-summary')).toContainText('Nothing has been written yet');
		const previewRow = page
			.getByTestId('import-row')
			.filter({ hasText: `workflow "${name}" [${workflow.id}]` });
		await expect(previewRow).toContainText(`→ ${name} copy ${index}`);
		await expect(previewRow.getByRole('link')).toHaveCount(0);
	}
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.screenshot({ path: test.info().outputPath('library-mappings-desktop.png') });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: test.info().outputPath('library-mappings-phone.png') });
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
		true
	);
	await page.getByRole('button', { name: 'Import', exact: true }).click();
	await expect(page.getByTestId('import-summary')).toContainText(
		'Imported downloaded-library.json'
	);
	for (const [index, workflow] of duplicates.entries()) {
		const row = page
			.getByTestId('import-row')
			.filter({ hasText: `workflow "${name}" [${workflow.id}]` });
		await expect(row).toContainText('create');
		await expect(row).toContainText(`→ ${name} copy ${index}`);
		const exported = await body<import('@tines/shared').LibraryV3Document>(
			await bob.get('/api/v1/export')
		);
		const copy = exported.workflows.find((w) => w.name === `${name} copy ${index}`)!;
		expect(copy).toBeTruthy();
		await expect(row.getByRole('link', { name: copy.name })).toHaveAttribute(
			'href',
			`/workflows/${copy.id}`
		);
		const sourcePrompt = document.context.find(
			(c) =>
				c.scope.state?.kind === 'bundled_state' && c.scope.state.state_id === workflow.states[0].id
		);
		const copyPrompt = exported.context.find(
			(c) => c.scope.state?.kind === 'bundled_state' && c.scope.state.state_id === copy.states[0].id
		);
		expect(copyPrompt?.kind === 'prompt' ? copyPrompt.body : null).toBe(
			sourcePrompt?.kind === 'prompt' ? sourcePrompt.body : null
		);
	}
	const firstCopy = (
		await body<import('@tines/shared').LibraryV3Document>(await bob.get('/api/v1/export'))
	).workflows.find((w) => w.name === `${name} copy 0`)!;
	await page.getByRole('link', { name: firstCopy.name }).click();
	await expect(page).toHaveURL(new RegExp(`/workflows/${firstCopy.id}$`));
	await expect(page.getByRole('heading', { name: firstCopy.name })).toBeVisible();
});

test('workflow export and strict validation are read-only and allowed to run keys', async ({
	request
}) => {
	const run = apiClient(request, RUNROW.runKey);
	const response = await run.get('/api/v1/workflows/wf_standard/export');
	expect(response.ok()).toBe(true);
	const document = await body<import('@tines/shared').WorkflowPackageDocument>(response);
	expect(document.profile).toBe('workflow');
	expect(document.workflows[0].name).toBe('Standard');
	const validated = await run.post('/api/v1/library/validate', {
		document_json: JSON.stringify(document)
	});
	expect(validated.ok()).toBe(true);
	expect(await body(validated)).toMatchObject({ valid: true, digest: document.digest, document });

	for (const client of [run, apiClient(request, ALICE.apiKey), apiClient(request, BOB.apiKey)]) {
		const before = await client.get('/api/v1/workflows');
		const beforeRows = await body(before);
		const prepared = await client.post('/api/v1/library/prepare', {
			document_json: JSON.stringify(document)
		});
		expect(prepared.status()).toBe(200);
		const plan = await body<import('@tines/shared').PrepareWorkflowPackageResponse>(prepared);
		expect(plan.document_digest).toBe(document.digest);
		expect(plan.resolved.workflows[0].name).toBe('Standard (imported)');
		expect(plan.resolved.schedules).toEqual([]);
		expect(
			plan.operations.some(
				(operation) => operation.action === 'create' && operation.kind === 'state'
			)
		).toBe(true);
		expect(plan.plan_token).toMatch(/^wip1\./);
		expect(await body(await client.get('/api/v1/workflows'))).toEqual(beforeRows);
	}
	const malformed = await run.post('/api/v1/library/validate', {
		document_json: '{"version":3,"version":2}'
	});
	expect(malformed.ok()).toBe(true);
	expect(await body(malformed)).toMatchObject({
		valid: false,
		diagnostics: [{ code: 'duplicate_key' }]
	});
	const foreign = await run.get('/api/v1/workflows/nonexistent/export');
	expect(foreign.status()).toBe(404);
});

test('workflow install commits once, recovers its receipt, and denies run keys', async ({
	request
}) => {
	const alice = apiClient(request, ALICE.apiKey);
	const run = apiClient(request, RUNROW.runKey);
	const document = await body<import('@tines/shared').WorkflowPackageDocument>(
		await alice.get('/api/v1/workflows/wf_standard/export')
	);
	const raw = JSON.stringify(document);
	const prepared = await body<import('@tines/shared').PrepareWorkflowPackageResponse>(
		await alice.post('/api/v1/library/prepare', {
			document_json: raw,
			choices: { workflow_names: { 'workflow:1': `Installed ${runId}` } }
		})
	);
	const requestBody: import('@tines/shared').WorkflowPackageInstallRequest = {
		document_json: raw,
		plan_token: prepared.plan_token,
		confirmation: { plan_digest: prepared.plan_digest }
	};
	const installed = await alice.post('/api/v1/library/install', requestBody);
	expect(installed.status()).toBe(200);
	const receipt = await body<import('@tines/shared').WorkflowPackageReceipt>(installed);
	expect(receipt.id).toBe(prepared.plan_id);
	expect(receipt.objects.find((object) => object.relationship === 'main')?.name).toBe(
		`Installed ${runId}`
	);
	expect(await body(await alice.post('/api/v1/library/install', requestBody))).toEqual(receipt);
	expect(await body(await run.get(`/api/v1/library/installs/${receipt.id}`))).toEqual(receipt);

	const runPrepared = await body<import('@tines/shared').PrepareWorkflowPackageResponse>(
		await run.post('/api/v1/library/prepare', { document_json: raw })
	);
	const denied = await run.post('/api/v1/library/install', {
		document_json: raw,
		plan_token: runPrepared.plan_token,
		confirmation: { plan_digest: runPrepared.plan_digest }
	});
	expect(denied.status()).toBe(403);
	expect((await errorBody(denied)).error.code).toBe('run_key_forbidden');
});
