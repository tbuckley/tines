import type { Artifact, IssueDetail, Project, WorkflowResponse } from '@tines/shared';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { ALICE } from './constants.mjs';
import {
	apiClient,
	body,
	clickUntil,
	gotoHydrated,
	readSettled,
	runId,
	signIn,
	issuePath
} from './helpers';

/**
 * A folder artifact's row on a phone (Tines/30): the type icon, the thumbnail
 * strip and the action buttons all refuse to shrink, so at 390px the text
 * column was the only thing left to give — measured 14px wide, 0px once a
 * stale badge added a Reaffirm button, wrapping the metadata one word per
 * line. The row now wraps instead: the text claims a readable width and the
 * actions drop to their own line. Desktop must stay a single line.
 */

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

/** A real 1×1 PNG, so the thumbnails lay out as images rather than alt text. */
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64'
);

let projectName: string;
let project: Project;
let plain: IssueDetail;
let stale: IssueDetail;
/** Three issues sitting in Design, where the typed gates below are available. */
let gatedMd: IssueDetail;
let gatedPlain: IssueDetail;
let gatedPhone: IssueDetail;
let gatedFile: IssueDetail;

test.beforeAll(async ({ apiFor, uniqueName, workerRequest: request }) => {
	projectName = uniqueName('artifacts-panel');
	const api = apiFor(ALICE);
	project = await body<Project>(await api.post('/api/v1/projects', { name: projectName }));

	// Eight images: more than the three thumbnails a row shows, as in the
	// screenshot folders agents actually attach.
	const multipart = Object.fromEntries(
		Array.from({ length: 8 }, (_, i) => [
			`f${i}`,
			{ name: `shot-${i}.png`, mimeType: 'image/png', buffer: PNG }
		])
	);
	const attachPhotos = (issueId: string) =>
		request.put(`/api/v1/issues/${issueId}/artifacts/photos/folder`, {
			headers: { authorization: `Bearer ${ALICE.apiKey}` },
			multipart
		});

	plain = await body<IssueDetail>(
		await api.post(`/api/v1/projects/${project.id}/issues`, { title: `Panel ${runId}` })
	);
	await attachPhotos(plain.id);

	// The stale variant is the tight one: the badge widens the text and the
	// Reaffirm button widens the actions. Attaching before the move leaves the
	// version predating the state entry, and Implementation's only way out
	// requires the slot — so the row renders both.
	const workflow = await body<WorkflowResponse>(
		await api.post('/api/v1/workflows', {
			name: `Panel loop ${runId}`,
			initial_state: 'Design',
			states: [
				{ name: 'Design', category: 'active' },
				{ name: 'Implementation', category: 'active' },
				{ name: 'Review', category: 'active' },
				{ name: 'Archive', category: 'active' },
				{ name: 'Done', category: 'done' }
			],
			transitions: [
				{ name: 'approve', from: 'Design', to: 'Implementation' },
				{
					name: 'ship',
					from: 'Implementation',
					to: 'Done',
					requires: [{ artifact: 'photos', type: 'folder' }]
				},
				// The gates the Attach dialog reads (Tines/275): one concrete
				// Markdown slot, one text/plain slot, out of the initial state.
				{
					name: 'submit',
					from: 'Design',
					to: 'Review',
					requires: [{ artifact: 'prd', type: 'text', content_type: 'text/markdown' }]
				},
				{
					name: 'publish',
					from: 'Design',
					to: 'Done',
					requires: [{ artifact: 'notes', type: 'text', content_type: 'text/plain' }]
				},
				// A concrete *file* MIME: the write declares the picked file, so
				// only reading that file catches a PNG under a PDF gate. Its own
				// to_state, since a workflow takes one transition per state pair.
				{
					name: 'archive',
					from: 'Design',
					to: 'Archive',
					requires: [{ artifact: 'deck', type: 'file', content_type: 'application/pdf' }]
				}
			]
		})
	);
	stale = await body<IssueDetail>(
		await api.post(`/api/v1/projects/${project.id}/issues`, {
			title: `Panel stale ${runId}`,
			workflow_id: workflow.id
		})
	);
	await attachPhotos(stale.id);
	await api.post(`/api/v1/issues/${stale.id}/transition`, { action: 'approve' });

	const inDesign = async (title: string) =>
		body<IssueDetail>(
			await api.post(`/api/v1/projects/${project.id}/issues`, {
				title: `${title} ${runId}`,
				workflow_id: workflow.id
			})
		);
	gatedMd = await inDesign('Panel gated md');
	gatedPlain = await inDesign('Panel gated plain');
	gatedPhone = await inDesign('Panel gated phone');
	gatedFile = await inDesign('Panel gated file');
});

test.use({ signedIn: ALICE });

/**
 * On a phone the Artifacts panel folds to one row (Tines/165); open it before
 * reaching for anything inside. A no-op on desktop, where there is no fold.
 * Retried across the hydration window: the row is a Svelte listener.
 */
async function unfoldArtifacts(page: Page): Promise<void> {
	const fold = page.getByRole('button', { name: /^Artifacts\b/ });
	if (!(await fold.isVisible())) return;
	await expect(async () => {
		if ((await fold.getAttribute('aria-expanded')) !== 'true') await fold.click();
		expect(await fold.getAttribute('aria-expanded')).toBe('true');
	}).toPass({ timeout: 15_000 });
}

/** The `photos` row, keyed off the artifact-name button inside it. */
function photosRow(page: Page): Locator {
	return page
		.getByRole('listitem')
		.filter({ has: page.getByRole('button', { name: 'photos', exact: true }) });
}

type Box = { x: number; y: number; width: number; height: number };
type RowGeometry = { row: Box; text: Box; meta: Box; actions: Box };

/**
 * Every box of a row, read from one layout pass (Tines/123). The parts are
 * reached structurally: the row's first div is the text column and the second
 * the actions, and `meta` is the version/actor/age line the crushed column
 * mangled — the last paragraph of the text column.
 *
 * These tests are all about how the row's parts sit relative to each other,
 * and a `boundingBox()` per part is a separate round trip: the issue page is
 * still settling after the row is visible, so two reads can land either side
 * of a reflow and the difference between them then measures the page shift
 * rather than the row. That is how the desktop assertion below came to fail
 * at exactly its boundary in a longer suite run — its two reads were 6px of
 * page shift apart. Reading every box inside one `evaluate` makes the
 * comparisons internally consistent whatever the page is doing.
 */
function rowGeometry(row: Locator): Promise<RowGeometry> {
	return row.evaluate((li) => {
		const box = (el: Element): Box => {
			const { x, y, width, height } = el.getBoundingClientRect();
			return { x, y, width, height };
		};
		const columns = li.querySelectorAll(':scope > div');
		const paragraphs = columns[0].querySelectorAll('p');
		return {
			row: box(li),
			text: box(columns[0]),
			meta: box(paragraphs[paragraphs.length - 1]),
			actions: box(columns[columns.length - 1])
		};
	});
}

/**
 * `rowGeometry` once the layout has stopped moving (`readSettled` in
 * `helpers.ts`). The row slides in, and content above the panel can reflow
 * after hydration — measuring through that gives a box from a frame no
 * assertion here means to describe.
 */
const settledGeometry = (row: Locator): Promise<RowGeometry> => readSettled(() => rowGeometry(row));

test('a folder row keeps its metadata readable on a phone', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await gotoHydrated(page, issuePath(projectName, plain.number));
	await unfoldArtifacts(page);

	const row = photosRow(page);
	await expect(row).toBeVisible();
	const { meta } = await settledGeometry(row);

	// Was 14px — one word per line, ten lines tall. The width is the column's,
	// not the text's, so it does not move with the age wording; the height
	// still allows the line to wrap once, which the bug's ten lines cannot.
	expect(meta.width).toBeGreaterThan(180);
	expect(meta.height).toBeLessThan(40);

	// The thumbnail strip gives up its extra images at this width; the first
	// still opens the viewer.
	await expect(row.locator('img')).toHaveCount(3);
	await expect(row.locator('img').first()).toBeVisible();
	await expect(row.locator('img').nth(1)).toBeHidden();
});

test('a stale folder row keeps its metadata and actions on a phone', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await gotoHydrated(page, issuePath(projectName, stale.number));
	await unfoldArtifacts(page);

	const row = photosRow(page);
	await expect(row.getByText('stale')).toBeVisible();

	// Was 0px: the Reaffirm button took the last of the row.
	const { text, meta, actions } = await settledGeometry(row);
	expect(meta.width).toBeGreaterThan(180);

	// The State card now leads the page on a phone (Tines/128), so this row can
	// start below the fold — scroll it in first. What this test is about is the
	// horizontal squeeze that used to clip the actions off the right edge
	// (Tines/123), not where the row happens to sit down the page.
	await row.scrollIntoViewIfNeeded();

	// Every action stays on screen, on its own line under the text.
	for (const name of [
		'Reaffirm',
		'View photos (content and version history)',
		'Attach a new version of photos',
		'Delete photos'
	]) {
		await expect(row.getByRole('button', { name })).toBeInViewport();
	}
	expect(actions.y).toBeGreaterThanOrEqual(text.y + text.height);
});

test('a folder row stays one line on a desktop', async ({ page }) => {
	await page.setViewportSize(DESKTOP);
	await gotoHydrated(page, issuePath(projectName, plain.number));
	await unfoldArtifacts(page);

	const row = photosRow(page);
	await expect(row).toBeVisible();

	// All three thumbnails, and nothing wrapped: the row is a single line.
	const thumbs = row.locator('img');
	await expect(thumbs).toHaveCount(3);
	for (let i = 0; i < 3; i++) await expect(thumbs.nth(i)).toBeVisible();

	// Nothing wrapped: the actions sit beside the text column, sharing its
	// flex line, and the row is one line tall. Stated as a relation between
	// the two columns rather than as a y-delta against the metadata text,
	// whose height moves with its wording (Tines/123).
	const { row: rowBox, text, actions } = await settledGeometry(row);
	expect(rowBox.height).toBeLessThan(72);
	expect(actions.x).toBeGreaterThanOrEqual(text.x + text.width);
	expect(actions.y).toBeLessThan(text.y + text.height);
	expect(text.y).toBeLessThan(actions.y + actions.height);
});

/**
 * The Attach dialog reads the gate (Tines/275): the requirement on an
 * available transition is the single source for the type it pre-selects, the
 * content type it declares, and the warning it shows when the operator picks
 * a type the gate can never accept. A human attaching `prd` under a
 * `(text, text/markdown)` gate used to create an immutable `file` artifact —
 * the very thing the CLI now refuses offline.
 */

const typeRadio = (page: Page, type: string): Locator =>
	page.locator(`input[name="artifact-type"][value="${type}"]`);

/** One option of the type selector: the input is `sr-only`, so click its label. */
const typeOption = (page: Page, type: string): Locator =>
	page.locator(`label:has(input[name="artifact-type"][value="${type}"])`);

/** Open the Attach dialog and name the slot, through the hydration window. */
async function openAttachFor(page: Page, issue: IssueDetail, name: string): Promise<Locator> {
	await gotoHydrated(page, issuePath(projectName, issue.number));
	await unfoldArtifacts(page);
	const nameField = page.locator('#artifact-name');
	await clickUntil(page.getByRole('button', { name: 'Attach artifact' }), async () => {
		await expect(nameField).toBeVisible();
	});
	await nameField.fill(name);
	return nameField;
}

test('the attach dialog pre-selects the gate type and warns on one it rejects', async ({
	page,
	apiFor
}) => {
	await openAttachFor(page, gatedMd, 'prd');

	// Typing the slot name flips the selector to the gate's type…
	await expect(typeRadio(page, 'text')).toBeChecked();
	await expect(page.getByText('Required by submit (text, text/markdown)')).toBeVisible();

	// …and picking a type the gate can never accept warns without blocking.
	await typeOption(page, 'file').click();
	await expect(typeRadio(page, 'file')).toBeChecked();
	const warning = page.getByText(/cannot satisfy/);
	await expect(warning).toBeVisible();
	await expect(warning).toContainText('needs text');

	// The hand-picked type survives further typing — the note still names the
	// gate, but the selector is the operator's.
	await page.locator('#artifact-name').fill('prd');
	await expect(typeRadio(page, 'file')).toBeChecked();

	await typeOption(page, 'text').click();
	await expect(warning).toBeHidden();
	await page.locator('#artifact-text').fill('# PRD\n\nThe document.');
	await page.getByRole('button', { name: 'Attach', exact: true }).click();

	await expect(page.getByRole('button', { name: 'prd', exact: true })).toBeVisible();

	// What the gate wanted, and it clears the gate on the first try.
	const api = apiFor(ALICE);
	const artifact = await body<Artifact>(
		await api.get(`/api/v1/issues/${gatedMd.id}/artifacts/prd`)
	);
	expect(artifact.artifact_type).toBe('text');
	expect(artifact.current_version.content_type).toBe('text/markdown');
	const moved = await api.post(`/api/v1/issues/${gatedMd.id}/transition`, { action: 'submit' });
	expect(moved.status(), await moved.text()).toBe(200);
});

test('a text gate with a concrete content type is declared on the write', async ({
	page,
	apiFor
}) => {
	await openAttachFor(page, gatedPlain, 'notes');

	await expect(typeRadio(page, 'text')).toBeChecked();
	await expect(page.getByText('Required by publish (text, text/plain)')).toBeVisible();
	await page.locator('#artifact-text').fill('plain words');
	await page.getByRole('button', { name: 'Attach', exact: true }).click();
	await expect(page.getByRole('button', { name: 'notes', exact: true })).toBeVisible();

	// The gate's MIME, not the server's text/markdown default.
	const api = apiFor(ALICE);
	const artifact = await body<Artifact>(
		await api.get(`/api/v1/issues/${gatedPlain.id}/artifacts/notes`)
	);
	expect(artifact.current_version.content_type).toBe('text/plain');
});

test('the gate note and warning wrap on a phone', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await openAttachFor(page, gatedPhone, 'prd');

	const note = page.getByText('Required by submit (text, text/markdown)');
	await expect(note).toBeVisible();
	await typeOption(page, 'link').click();
	const warning = page.getByText(/cannot satisfy/);
	await expect(warning).toBeVisible();

	// Neither line pushes the dialog off the right edge — they wrap like the
	// rest of the panel does at this width.
	for (const line of [note, warning]) {
		const box = (await line.boundingBox())!;
		expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
	}
	// Warn, never block: the submit stays live for an operator attaching a
	// link for some other purpose.
	await page.locator('#artifact-url').fill('https://example.com/prd');
	await expect(page.getByRole('button', { name: 'Attach', exact: true })).toBeEnabled();
});

test('the pre-selection re-arms on a new slot name, and a file gate reads the picked file', async ({
	page
}) => {
	await openAttachFor(page, gatedFile, 'prd');
	await expect(typeRadio(page, 'text')).toBeChecked();

	// A hand pick wins over the gate it was made against…
	await typeOption(page, 'link').click();
	await expect(typeRadio(page, 'link')).toBeChecked();

	// …and a name matching a *different* gate re-arms the pre-selection.
	await page.locator('#artifact-name').fill('deck');
	await expect(typeRadio(page, 'file')).toBeChecked();
	await expect(page.getByText('Required by archive (file, application/pdf)')).toBeVisible();

	// The upload declares the picked file, never the gate — so a PNG under a
	// PDF gate warns rather than storing image/png in silence.
	const fileInput = page.locator('[aria-label="File drop zone"] input[type="file"]');
	await fileInput.setInputFiles({ name: 'deck.png', mimeType: 'image/png', buffer: PNG });
	const warning = page.getByText(/cannot satisfy/);
	await expect(warning).toBeVisible();
	await expect(warning).toContainText('needs application/pdf');
	await expect(page.getByRole('button', { name: 'Attach', exact: true })).toBeEnabled();

	// What the gate asked for clears it.
	await fileInput.setInputFiles({ name: 'deck.pdf', mimeType: 'application/pdf', buffer: PNG });
	await expect(warning).toBeHidden();
});
