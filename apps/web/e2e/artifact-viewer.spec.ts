import type { IssueDetail, Project } from '@tines/shared';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { ALICE, BASE_URL } from './constants.mjs';
import { apiClient, body, gotoHydrated, readSettled, runId, signIn } from './helpers';

/**
 * The artifact viewer on a phone (Tines/28): a markdown doc far taller than
 * the screen, or a folder of images, used to leave no way out — the modal had
 * no close control, so the only exits were Escape (no keyboard on a phone) and
 * a 16px strip of backdrop. These assert the close button stays on screen
 * whatever the content's height, and that the page behind stays put.
 */

const projectName = `viewer-${runId}`;
let project: Project;
let issue: IssueDetail;
let otherIssue: IssueDetail;

const PHONE = { width: 390, height: 844 };

type Box = { x: number; y: number; width: number; height: number };

test.beforeAll(async ({ playwright }) => {
	const request = await playwright.request.newContext({
		baseURL: test.info().project.use.baseURL
	});
	const api = apiClient(request, ALICE.apiKey);
	project = await body<Project>(await api.post('/api/v1/projects', { name: projectName }));
	issue = await body<IssueDetail>(
		await api.post(`/api/v1/projects/${project.id}/issues`, { title: `Viewer ${runId}` })
	);
	otherIssue = await body<IssueDetail>(
		await api.post(`/api/v1/projects/${project.id}/issues`, { title: `Other viewer ${runId}` })
	);

	for (const [target, marker] of [
		[issue, 'IDENTITY ISSUE A'],
		[otherIssue, 'IDENTITY ISSUE B']
	] as const) {
		const put = await api.put(`/api/v1/issues/${target.id}/artifacts/identity-doc`, {
			type: 'text',
			content: marker,
			content_type: 'text/plain'
		});
		expect(put.status(), await put.text()).toBe(200);
	}
	for (const [name, content] of [
		['replace-me', 'ORIGINAL ARTIFACT'],
		['race-doc', 'VERSION ONE'],
		['pending-doc', 'RETRIED CONTENT'],
		['delayed-meta', 'STALE METADATA CONTENT'],
		['fresh-doc', 'FRESH CONTENT'],
		['meta-reopen-success', 'METADATA VERSION ONE'],
		['meta-reopen-failure', 'METADATA FAILURE CONTROL']
	] as const) {
		const put = await api.put(`/api/v1/issues/${issue.id}/artifacts/${name}`, {
			type: 'text',
			content,
			content_type: 'text/plain'
		});
		expect(put.status(), await put.text()).toBe(200);
	}
	await api.post(`/api/v1/issues/${issue.id}/comments`, {
		body: `[Open the other identity issue](/issues/${encodeURIComponent(projectName)}/${otherIssue.number})`
	});

	// Far taller than any viewport: ~400 paragraphs of markdown.
	const paragraphs = Array.from(
		{ length: 400 },
		(_, i) => `## Section ${i + 1}\n\nParagraph ${i + 1} of a very long document.`
	).join('\n\n');
	await api.put(`/api/v1/issues/${issue.id}/artifacts/long-doc`, {
		type: 'text',
		content: paragraphs,
		content_type: 'text/markdown'
	});

	// A folder set: the gallery has no height cap of its own, so the modal is
	// the only thing keeping it on screen.
	const multipart: Record<string, { name: string; mimeType: string; buffer: Buffer }> =
		Object.fromEntries(
			Array.from({ length: 8 }, (_, i) => [
				`f${i}`,
				{ name: `shot-${i}.png`, mimeType: 'image/png', buffer: Buffer.from(`PNG${i}`) }
			])
		);
	await request.put(`/api/v1/issues/${issue.id}/artifacts/photos/folder`, {
		headers: { authorization: `Bearer ${ALICE.apiKey}` },
		multipart
	});
	// A mixed folder takes the file-list path. The standard Word MIME is long
	// enough to expose any row that lets metadata crowd out its filename/actions.
	await request.put(`/api/v1/issues/${issue.id}/artifacts/deliverables/folder`, {
		headers: { authorization: `Bearer ${ALICE.apiKey}` },
		multipart: {
			docx: {
				name: 'onboarding-review.docx',
				mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
				buffer: Buffer.from('PK')
			},
			readme: { name: 'README.md', mimeType: 'text/markdown', buffer: Buffer.from('# Read me') }
		}
	});
	for (const [name, filename, contentType, bytes] of [
		['race-image', 'snapshot.png', 'image/png', 'IMAGE VERSION ONE'],
		['race-pdf', 'snapshot.pdf', 'application/pdf', 'PDF VERSION ONE']
	] as const) {
		const uploaded = await request.put(
			`/api/v1/issues/${issue.id}/artifacts/${name}/file?filename=${filename}`,
			{
				headers: { authorization: `Bearer ${ALICE.apiKey}`, 'content-type': contentType },
				data: Buffer.from(bytes)
			}
		);
		expect(uploaded.status(), await uploaded.text()).toBe(200);
	}
	const raceFolder = await request.put(`/api/v1/issues/${issue.id}/artifacts/race-folder/folder`, {
		headers: { authorization: `Bearer ${ALICE.apiKey}` },
		multipart: {
			first: { name: 'first.png', mimeType: 'image/png', buffer: Buffer.from('FOLDER ONE A') },
			second: { name: 'second.png', mimeType: 'image/png', buffer: Buffer.from('FOLDER ONE B') }
		}
	});
	expect(raceFolder.status(), await raceFolder.text()).toBe(200);
	// The page behind has to be taller than the phone viewport for the scroll
	// lock assertions below to mean anything.
	await api.post(`/api/v1/issues/${issue.id}/comments`, {
		body: Array.from({ length: 40 }, (_, i) => `Comment paragraph ${i + 1}.`).join('\n\n')
	});

	await request.dispose();
});

test.beforeEach(async ({ context }) => {
	await signIn(context, ALICE.sessionToken);
});

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

const issueUrl = () => `/issues/${encodeURIComponent(projectName)}/${issue.number}`;

function barrier() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => (release = resolve));
	return { promise, release };
}

test('reopening retries after an obsolete pending text request fails', async ({ page }) => {
	const first = barrier();
	const second = barrier();
	let requests = 0;
	await page.route(`**/artifacts/pending-doc/content?version=1`, async (route) => {
		requests++;
		if (requests === 1) {
			await first.promise;
			await route.abort('failed');
		} else {
			await second.promise;
			await route.continue();
		}
	});

	await gotoHydrated(page, issueUrl());
	const dialog = page.getByRole('dialog', { name: 'Artifact viewer' });
	await openViewer(page.getByRole('button', { name: /^View pending-doc/ }), dialog);
	await expect.poll(() => requests).toBe(1);
	await dialog.getByRole('button', { name: 'Close' }).click();
	await openViewer(page.getByRole('button', { name: /^View pending-doc/ }), dialog);
	first.release();
	await expect.poll(() => requests).toBe(2);
	await expect(dialog.getByText('(failed to load content)')).toHaveCount(0);
	second.release();
	await expect(dialog.getByText('RETRIED CONTENT')).toBeVisible();
	await expect(dialog.getByText('(failed to load content)')).toHaveCount(0);
});

test('superseded metadata success and failure cannot replace a newer selection', async ({
	page
}) => {
	for (const outcome of ['success', 'failure'] as const) {
		const held = barrier();
		let intercepted = false;
		await page.route(`**/artifacts/delayed-meta`, async (route) => {
			intercepted = true;
			await held.promise;
			if (outcome === 'success') await route.continue();
			else await route.abort('failed');
		});

		await gotoHydrated(page, issueUrl());
		const dialog = page.getByRole('dialog', { name: 'Artifact viewer' });
		await openViewer(page.getByRole('button', { name: /^View delayed-meta/ }), dialog);
		await expect.poll(() => intercepted).toBe(true);
		await dialog.getByRole('button', { name: 'Close' }).click();
		await openViewer(page.getByRole('button', { name: /^View fresh-doc/ }), dialog);
		await expect(dialog.getByText('FRESH CONTENT')).toBeVisible();
		held.release();
		await page.waitForTimeout(100);
		await expect(dialog.getByText('FRESH CONTENT')).toBeVisible();
		await expect(dialog.getByText('STALE METADATA CONTENT')).toHaveCount(0);
		await expect(dialog.getByText('Couldn’t load this artifact — close and retry.')).toHaveCount(0);
		await page.unroute(`**/artifacts/delayed-meta`);
	}
});

test('reopen owns delayed metadata success and failure for the same selection', async ({
	page
}) => {
	for (const outcome of ['success', 'failure'] as const) {
		const name = `meta-reopen-${outcome}`;
		const first = barrier();
		const second = barrier();
		let requests = 0;
		const detailUrl = `**/api/v1/issues/${issue.id}/artifacts/${name}`;
		await page.route(detailUrl, async (route) => {
			requests++;
			const response = outcome === 'success' || requests === 2 ? await route.fetch() : null;
			await (requests === 1 ? first.promise : second.promise);
			if (response) await route.fulfill({ response });
			else await route.abort('failed');
		});

		await gotoHydrated(page, issueUrl());
		const dialog = page.getByRole('dialog', { name: 'Artifact viewer' });
		await openViewer(page.getByRole('button', { name: new RegExp(`^View ${name}`) }), dialog);
		await expect.poll(() => requests).toBe(1);
		if (outcome === 'success') {
			const appended = await page.request.put(`/api/v1/issues/${issue.id}/artifacts/${name}`, {
				headers: { authorization: `Bearer ${ALICE.apiKey}` },
				data: { type: 'text', content: 'METADATA VERSION TWO', content_type: 'text/plain' }
			});
			expect(appended.status(), await appended.text()).toBe(200);
		}
		await dialog.getByRole('button', { name: 'Close' }).click();
		await openViewer(page.getByRole('button', { name: new RegExp(`^View ${name}`) }), dialog);
		await expect.poll(() => requests).toBe(2);
		first.release();
		await expect(dialog.getByText('Loading…')).toBeVisible();
		await expect(dialog.getByText('Couldn’t load this artifact — close and retry.')).toHaveCount(0);
		await expect(dialog.getByText('METADATA VERSION ONE')).toHaveCount(0);
		second.release();
		await expect(
			dialog.getByText(outcome === 'success' ? 'METADATA VERSION TWO' : 'METADATA FAILURE CONTROL')
		).toBeVisible();
		await page.unroute(detailUrl);
	}
});

test('text cache identity survives client navigation without crossing issues', async ({ page }) => {
	await gotoHydrated(page, issueUrl());
	const dialog = page.getByRole('dialog', { name: 'Artifact viewer' });
	await openViewer(page.getByRole('button', { name: /^View identity-doc/ }), dialog);
	await expect(dialog.getByText('IDENTITY ISSUE A')).toBeVisible();
	await dialog.getByRole('button', { name: 'Close' }).click();

	await page.evaluate(() => Object.assign(window, { __artifactIdentitySentinel: 'kept' }));
	await page.getByRole('link', { name: 'Open the other identity issue' }).click();
	await expect(page).toHaveURL(new RegExp(`/${otherIssue.number}$`));
	expect(await page.evaluate(() => Reflect.get(window, '__artifactIdentitySentinel'))).toBe('kept');

	await openViewer(page.getByRole('button', { name: /^View identity-doc/ }), dialog);
	await expect(dialog.getByText('IDENTITY ISSUE B')).toBeVisible();
	await expect(dialog.getByText('IDENTITY ISSUE A')).toHaveCount(0);
});

test('delete and recreate cannot reuse text cached under the old artifact id', async ({ page }) => {
	await gotoHydrated(page, issueUrl());
	const dialog = page.getByRole('dialog', { name: 'Artifact viewer' });
	await openViewer(page.getByRole('button', { name: /^View replace-me/ }), dialog);
	await expect(dialog.getByText('ORIGINAL ARTIFACT')).toBeVisible();
	await dialog.getByRole('button', { name: 'Close' }).click();

	const headers = { authorization: `Bearer ${ALICE.apiKey}` };
	const removed = await page.request.delete(`/api/v1/issues/${issue.id}/artifacts/replace-me`, {
		headers
	});
	expect(removed.status(), await removed.text()).toBe(204);
	const recreated = await page.request.put(`/api/v1/issues/${issue.id}/artifacts/replace-me`, {
		headers,
		data: { type: 'text', content: 'RECREATED ARTIFACT', content_type: 'text/plain' }
	});
	expect(recreated.status(), await recreated.text()).toBe(200);

	await openViewer(page.getByRole('button', { name: /^View replace-me/ }), dialog);
	await expect(dialog.getByText('RECREATED ARTIFACT')).toBeVisible();
	await expect(dialog.getByText('ORIGINAL ARTIFACT')).toHaveCount(0);
});

test('current stays pinned when a newer version lands after metadata resolves', async ({
	page
}) => {
	await page.route(`**/api/v1/issues/${issue.id}/artifacts/race-doc`, async (route) => {
		const v1Detail = await route.fetch();
		const appended = await page.request.put(`/api/v1/issues/${issue.id}/artifacts/race-doc`, {
			headers: { authorization: `Bearer ${ALICE.apiKey}` },
			data: { content: 'VERSION TWO', content_type: 'text/plain' }
		});
		expect(appended.status(), await appended.text()).toBe(200);
		await route.fulfill({ response: v1Detail });
	});

	await gotoHydrated(page, issueUrl());
	const dialog = page.getByRole('dialog', { name: 'Artifact viewer' });
	await openViewer(page.getByRole('button', { name: /^View race-doc/ }), dialog);
	await expect(dialog.getByText('VERSION ONE')).toBeVisible();
	const download = dialog.getByRole('link', { name: 'Download', exact: true });
	const href = await download.getAttribute('href');
	expect(href).not.toBeNull();
	expect(new URL(href!, 'http://local').searchParams.get('version')).toBe('1');
	expect(await (await page.request.get(href!)).text()).toBe('VERSION ONE');
	expect(
		await (await page.request.get(`/api/v1/issues/${issue.id}/artifacts/race-doc/content`)).text()
	).toBe('VERSION TWO');
});

test('image and PDF preview URLs stay pinned to captured metadata', async ({ page }) => {
	for (const [name, filename, contentType, oldBytes, newBytes, selector] of [
		['race-image', 'snapshot.png', 'image/png', 'IMAGE VERSION ONE', 'IMAGE VERSION TWO', 'img'],
		['race-pdf', 'snapshot.pdf', 'application/pdf', 'PDF VERSION ONE', 'PDF VERSION TWO', 'iframe']
	] as const) {
		const detailUrl = `**/api/v1/issues/${issue.id}/artifacts/${name}`;
		await page.route(detailUrl, async (route) => {
			const v1Detail = await route.fetch();
			const appended = await page.request.put(
				`/api/v1/issues/${issue.id}/artifacts/${name}/file?filename=${filename}`,
				{
					headers: { authorization: `Bearer ${ALICE.apiKey}`, 'content-type': contentType },
					data: Buffer.from(newBytes)
				}
			);
			expect(appended.status(), await appended.text()).toBe(200);
			await route.fulfill({ response: v1Detail });
		});
		await gotoHydrated(page, issueUrl());
		const dialog = page.getByRole('dialog', { name: 'Artifact viewer' });
		await openViewer(
			page.getByRole('button', { name: new RegExp(`^View ${name}`) }).first(),
			dialog
		);
		const previewUrl = await dialog.locator(selector).last().getAttribute('src');
		expect(new URL(previewUrl!, 'http://local').searchParams.get('version')).toBe('1');
		expect(await (await page.request.get(previewUrl!)).text()).toBe(oldBytes);
		expect(
			await (await page.request.get(`/api/v1/issues/${issue.id}/artifacts/${name}/content`)).text()
		).toBe(newBytes);
		await page.unroute(detailUrl);
	}
});

test('folder gallery and downloads stay pinned to the panel and viewer snapshot', async ({
	page
}) => {
	const detailUrl = `**/api/v1/issues/${issue.id}/artifacts/race-folder`;
	await page.route(detailUrl, async (route) => {
		const v1Detail = await route.fetch();
		const appended = await page.request.put(
			`/api/v1/issues/${issue.id}/artifacts/race-folder/folder`,
			{
				headers: { authorization: `Bearer ${ALICE.apiKey}`, origin: BASE_URL },
				multipart: {
					first: {
						name: 'first.png',
						mimeType: 'image/png',
						buffer: Buffer.from('FOLDER TWO')
					}
				}
			}
		);
		expect(appended.status(), await appended.text()).toBe(200);
		await route.fulfill({ response: v1Detail });
	});
	await gotoHydrated(page, issueUrl());
	await expect(page.locator('img[alt="first.png"]').first()).toHaveAttribute(
		'src',
		/[?&]version=1(?:&|$)/
	);
	const dialog = page.getByRole('dialog', { name: 'Artifact viewer' });
	await openViewer(page.getByRole('button', { name: /^View race-folder/ }).first(), dialog);
	const gallery = dialog.locator('img[alt="first.png"]');
	await expect(gallery).toHaveAttribute('src', /[?&]version=1(?:&|$)/);
	await dialog.locator('button[title="View first.png"]').click();
	const download = dialog.getByRole('link', { name: 'Download', exact: true }).last();
	const href = await download.getAttribute('href');
	expect(new URL(href!, 'http://local').searchParams.get('version')).toBe('1');
	expect(await (await page.request.get(href!)).text()).toBe('FOLDER ONE A');
});

/**
 * Click that survives the SSR-to-hydration window (same shape as
 * `ui.spec.ts`'s `clickUntil`): a click landing before the listeners attach is
 * swallowed, so retry until the dialog is up.
 */
async function openViewer(opener: Locator, dialog: Locator): Promise<void> {
	await expect(async () => {
		if (await opener.isVisible()) await opener.click();
		await expect(dialog).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 15_000 });
}

test('a long markdown artifact stays dismissable on a phone', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await gotoHydrated(page, issueUrl());
	await unfoldArtifacts(page);

	const dialog = page.getByRole('dialog', { name: 'Artifact viewer' });
	await openViewer(page.getByRole('button', { name: /^View long-doc/ }), dialog);

	const closeButton = dialog.getByRole('button', { name: 'Close' });
	await expect(closeButton).toBeInViewport();

	// The body is the only scroller; run it to the bottom and the close button
	// is still there (it lives in the non-scrolling header).
	const scroller = dialog.locator('div.overflow-y-auto').first();
	await expect(async () => {
		const scrolledToEnd = await scroller.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
			return el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
		});
		expect(scrolledToEnd).toBe(true);
	}).toPass({ timeout: 10_000 });
	await expect(closeButton).toBeInViewport();

	await closeButton.click();
	await expect(dialog).toBeHidden();
});

test('a folder set stays within the viewport and dismissable on a phone', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await gotoHydrated(page, issueUrl());
	await unfoldArtifacts(page);
	const panelThumbnail = page.locator('img[alt="shot-0.png"]');
	await expect(panelThumbnail).toHaveAttribute('src', /[?&]version=1(?:&|$)/);

	const dialog = page.getByRole('dialog', { name: 'Artifact viewer' });
	await openViewer(page.getByRole('button', { name: /^View photos/ }).first(), dialog);

	const closeButton = dialog.getByRole('button', { name: 'Close' });
	await expect(closeButton).toBeInViewport();

	// The panel no longer runs off the bottom of the screen.
	const box = await dialog.boundingBox();
	expect(box).not.toBeNull();
	expect(box!.y + box!.height).toBeLessThanOrEqual(PHONE.height);

	await closeButton.click();
	await expect(dialog).toBeHidden();
});

type FileRowGeometry = {
	row: Box;
	filename: Box;
	download: Box;
	clientWidth: number;
	scrollWidth: number;
};

function fileRowGeometry(download: Locator): Promise<FileRowGeometry> {
	return download.evaluate((link) => {
		const bounds = (el: Element): Box => {
			const { x, y, width, height } = el.getBoundingClientRect();
			return { x, y, width, height };
		};
		const row = link.closest('li')!;
		const text = link.previousElementSibling!;
		const filename = text.firstElementChild!;
		return {
			row: bounds(row),
			filename: bounds(filename),
			download: bounds(link),
			clientWidth: row.clientWidth,
			scrollWidth: row.scrollWidth
		};
	});
}

test('Office metadata keeps the filename and Download inside a phone row in both themes', async ({
	page
}) => {
	await page.setViewportSize(PHONE);

	for (const colorScheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme });
		await gotoHydrated(page, issueUrl());
		await expect(page.locator('html')).toHaveClass(
			colorScheme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/
		);
		await unfoldArtifacts(page);

		const dialog = page.getByRole('dialog', { name: 'Artifact viewer' });
		await openViewer(page.getByRole('button', { name: /^View deliverables/ }).first(), dialog);

		const download = dialog.getByRole('link', { name: 'Download onboarding-review.docx' });
		await expect(download).toBeInViewport();
		const geometry = await readSettled(() => fileRowGeometry(download), {
			timeout: 3_000,
			bestEffort: true
		});
		const dialogBox = await dialog.boundingBox();
		expect(dialogBox).not.toBeNull();

		expect(geometry.filename.width).toBeGreaterThan(100);
		expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
		expect(geometry.download.x + geometry.download.width).toBeLessThanOrEqual(
			geometry.row.x + geometry.row.width
		);
		expect(geometry.download.x + geometry.download.width).toBeLessThanOrEqual(
			dialogBox!.x + dialogBox!.width
		);

		await dialog.getByRole('button', { name: 'Close' }).click();
		await expect(dialog).toBeHidden();
	}
});

/**
 * Scroll the page behind the way a user would — a wheel over the backdrop strip
 * at the screen edge — and report where it ended up. Deliberately not
 * `window.scrollTo`: `overflow: hidden` still allows programmatic scrolling, so
 * that would report 400 for a page that no user can move (measured).
 */
async function wheelPageBehind(page: Page): Promise<number> {
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.mouse.move(5, 400);
	await page.mouse.wheel(0, 400);
	await page.waitForTimeout(250);
	return page.evaluate(() => window.scrollY);
}

/** The page behind is long enough that a failure to lock is visible. */
async function expectPageBehindScrolls(page: Page): Promise<void> {
	await expect(async () => {
		expect(await wheelPageBehind(page)).toBeGreaterThan(0);
	}).toPass({ timeout: 10_000 });
}

test('the page behind does not scroll while the viewer is open', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await gotoHydrated(page, issueUrl());
	await unfoldArtifacts(page);

	const dialog = page.getByRole('dialog', { name: 'Artifact viewer' });
	await openViewer(page.getByRole('button', { name: /^View long-doc/ }), dialog);

	// Behavioural, not `body.style.overflow === 'hidden'`: any lock that works
	// passes this, and a lock that has been defeated fails it.
	expect(await wheelPageBehind(page)).toBe(0);

	await dialog.getByRole('button', { name: 'Close' }).click();
	await expect(dialog).toBeHidden();
	await expectPageBehindScrolls(page);
});

test('two modals open at once still release the page when both close', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await gotoHydrated(page, issueUrl());
	await unfoldArtifacts(page);

	const viewer = page.getByRole('dialog', { name: 'Artifact viewer' });
	await openViewer(page.getByRole('button', { name: /^View long-doc/ }), viewer);

	// Focus is moved into the dialog but not trapped, and the background is not
	// inert (Tines/29), so a keyboard user can still reach a trigger behind the
	// overlay and stack a second modal on the first. The scroll lock has to be
	// ref-counted to survive that: per-instance save/restore inverts, and the
	// last close writes 'hidden' back, leaving the whole app unscrollable.
	const attach = page.getByRole('button', { name: 'Attach artifact' });
	await attach.focus();
	await expect(attach).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('dialog', { name: 'Attach artifact' })).toBeVisible();
	await expect(page.getByRole('dialog')).toHaveCount(2);
	expect(await wheelPageBehind(page)).toBe(0);

	// Escape is a `<svelte:window>` handler in every mounted instance, so one
	// press closes both.
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expectPageBehindScrolls(page);
});

test('Escape closes the viewer and returns focus to the button that opened it', async ({
	page
}) => {
	await gotoHydrated(page, issueUrl());
	await unfoldArtifacts(page);

	const opener = page.getByRole('button', { name: /^View long-doc/ });
	const dialog = page.getByRole('dialog', { name: 'Artifact viewer' });
	await openViewer(opener, dialog);
	await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();

	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await expect(opener).toBeFocused();
});

/**
 * Stepping through a folder's files (Tines/152): the detail view used to have
 * `← all files` as its only navigation, so reading eight screenshots in order
 * meant eight round trips through the index. These cover the Prev/Next
 * cluster, the arrow-key shortcut and its guards, and the header row's layout
 * — the row now carries three more controls than it was measured for.
 */

/** Open the photos folder and click into its first file. */
async function openFirstPhoto(page: Page): Promise<Locator> {
	const dialog = page.getByRole('dialog', { name: 'Artifact viewer' });
	await openViewer(page.getByRole('button', { name: /^View photos/ }).first(), dialog);
	// The gallery thumbnails name themselves by their contents (alt + caption),
	// so address them by the title the markup gives them instead.
	await dialog.locator('button[title="View shot-0.png"]').click();
	return dialog;
}

/** The `n of N` position indicator in the file-detail header. */
const counterOf = (dialog: Locator) => dialog.locator('span.tabular-nums');
/** The truncating path span in the file-detail header. */
const pathOf = (dialog: Locator) => dialog.locator('span.font-mono');

test('Prev/Next step through a folder in order and stop at the ends', async ({ page }) => {
	await gotoHydrated(page, issueUrl());
	await unfoldArtifacts(page);
	const dialog = await openFirstPhoto(page);

	const counter = counterOf(dialog);
	const prev = dialog.getByRole('button', { name: 'Previous file' });
	const next = dialog.getByRole('button', { name: 'Next file' });

	await expect(counter).toHaveText('1 of 8');
	await expect(prev).toHaveAttribute('aria-disabled', 'true');
	await expect(next).toHaveAttribute('aria-disabled', 'false');

	// Stepping moves the preview, not just the label: the <img> follows.
	await next.click();
	await next.click();
	await expect(counter).toHaveText('3 of 8');
	await expect(pathOf(dialog)).toHaveText('shot-2.png');
	await expect(dialog.locator('img[alt="shot-2.png"]')).toHaveAttribute(
		'src',
		/path=shot-2\.png&inline=1/
	);

	await prev.click();
	await expect(counter).toHaveText('2 of 8');
	await expect(pathOf(dialog)).toHaveText('shot-1.png');

	for (let i = 0; i < 6; i++) await next.click();
	await expect(counter).toHaveText('8 of 8');
	await expect(next).toHaveAttribute('aria-disabled', 'true');

	// The end is `aria-disabled`, not `disabled`, so the button that took the
	// user here keeps focus — activating it again is simply a no-op.
	await expect(next).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(counter).toHaveText('8 of 8');
	await expect(next).toBeFocused();

	await dialog.getByRole('button', { name: '← all files' }).click();
	await expect(dialog.locator('button[title="View shot-0.png"]')).toBeVisible();
	await expect(counter).toHaveCount(0);
});

test('arrow keys step, and are left alone inside the header selects', async ({ page }) => {
	await gotoHydrated(page, issueUrl());
	await unfoldArtifacts(page);
	const dialog = await openFirstPhoto(page);
	const counter = counterOf(dialog);
	await expect(counter).toHaveText('1 of 8');

	await page.keyboard.press('ArrowRight');
	await expect(counter).toHaveText('2 of 8');
	await page.keyboard.press('ArrowLeft');
	await expect(counter).toHaveText('1 of 8');
	// The first file is the end: another press stays put rather than wrapping.
	await page.keyboard.press('ArrowLeft');
	await expect(counter).toHaveText('1 of 8');

	// The header's version picker is a native <select>, which owns arrow keys.
	const versionSelect = dialog.getByRole('combobox', { name: 'Version' });
	await versionSelect.focus();
	await page.keyboard.press('ArrowRight');
	await expect(counter).toHaveText('1 of 8');
	await expect(versionSelect).toBeFocused();
});

type NavGeometry = { row: Box; path: Box; cluster: Box };

/**
 * The header row's boxes from one layout pass (the Tines/123 lesson): the
 * assertions below are about where the parts sit relative to each other, and
 * separate `boundingBox()` reads would also measure whatever the dialog
 * reflowed in between.
 */
function navGeometry(dialog: Locator): Promise<NavGeometry> {
	// Reached from the Prev button outwards rather than by class: the classes
	// this test exists to pin are exactly the ones a locator must not depend on
	// (drop `flex-wrap` and a `div.flex-wrap` locator matches nothing, which
	// would fail as a timeout instead of as a layout claim).
	return dialog.getByRole('button', { name: 'Previous file' }).evaluate((prevButton) => {
		const box = (el: Element): Box => {
			const { x, y, width, height } = el.getBoundingClientRect();
			return { x, y, width, height };
		};
		const cluster = prevButton.parentElement!;
		const row = cluster.parentElement!;
		return {
			row: box(row),
			path: box(row.querySelector(':scope > span')!),
			cluster: box(cluster)
		};
	});
}

// Best effort: a row that never stops moving is a failure too, but the
// assertions below name it far better than a timeout in here would.
const settledNavGeometry = (dialog: Locator): Promise<NavGeometry> =>
	readSettled(() => navGeometry(dialog), { timeout: 3_000, bestEffort: true });

test('the file-detail header keeps one line on desktop and wraps on a phone', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await gotoHydrated(page, issueUrl());
	await unfoldArtifacts(page);
	const dialog = await openFirstPhoto(page);

	const wide = await settledNavGeometry(dialog);
	// One line: the trailing cluster sits beside the path, not under it.
	expect(wide.cluster.y).toBeLessThan(wide.path.y + wide.path.height);
	expect(wide.path.y).toBeLessThan(wide.cluster.y + wide.cluster.height);
	expect(wide.row.height).toBeLessThanOrEqual(40);

	await page.setViewportSize(PHONE);
	const narrow = await settledNavGeometry(dialog);
	// Two lines: the cluster drops below a path that is truncated, not crushed.
	expect(narrow.cluster.y).toBeGreaterThanOrEqual(narrow.path.y + narrow.path.height);
	expect(narrow.path.width).toBeGreaterThan(100);
	expect(narrow.row.height).toBeLessThanOrEqual(80);
});
