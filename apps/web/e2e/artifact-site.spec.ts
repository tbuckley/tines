import type { ArtifactSiteLink, IssueDetail, Project } from '@tines/shared';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { siteHeaders } from '../src/lib/server/artifact-site';
import { ALICE, BASE_URL } from './constants.mjs';
import { apiClient, body, gotoHydrated, runId, signIn, issuePath } from './helpers';

/**
 * HTML artifacts served as live sites (Tines/272, specs/artifacts/SPEC.md
 * "Sites"). Everything else about this feature is unit-tested; what only a
 * real browser can answer is whether the bytes actually *run* — scripts
 * executing inside the frame, a sibling `./app.js` and `./styles.css`
 * resolving through `/s/<token>/`, and the CSP holding the page away from
 * the Tines API while it does.
 *
 * The worker suite never sets `ARTIFACT_SANDBOX_ORIGIN`, so every assertion here is
 * the *same-origin fallback* mode: the site is served from the app origin
 * under CSP `sandbox`, which gives it an opaque origin. Storage APIs
 * therefore throw — asserted in the negative direction below, and the mode
 * the viewer warns about in its own words.
 */

let projectName: string;
let project: Project;
let issue: IssueDetail;

/**
 * The single-file prototype. Reports four things into the DOM so the
 * assertions can read them as text through a sandboxed frame (which no
 * `evaluate` can reach into): that it rendered at all, that its script ran,
 * whether it could reach `/api/v1`, and whether storage worked.
 */
const PROTOTYPE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Prototype</title>
<style>body { font-family: system-ui, sans-serif; margin: 0; padding: 1rem; }</style>
</head>
<body>
<h1>Prototype heading</h1>
<p id="script">script did not run</p>
<p id="api">api not tried</p>
<p id="storage">storage not tried</p>
<script>
	document.getElementById('script').textContent = 'script ran';
	try {
		localStorage.setItem('probe', '1');
		document.getElementById('storage').textContent = 'storage works';
	} catch {
		document.getElementById('storage').textContent = 'storage blocked';
	}
	fetch('/api/v1/projects').then(
		() => { document.getElementById('api').textContent = 'api reachable'; },
		() => { document.getElementById('api').textContent = 'api blocked'; }
	);
</script>
</body>
</html>
`;

/** The folder site: an entry document plus the two siblings it points at. */
const FOLDER_INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Mini app</title>
<link rel="stylesheet" href="./styles.css" />
</head>
<body>
<h1>Mini app index</h1>
<p id="sibling">sibling script did not run</p>
<script src="./app.js"></script>
</body>
</html>
`;

const FOLDER_APP_JS = `document.getElementById('sibling').textContent = 'sibling script ran';\n`;
/** Loaded through the same `/s/<token>/` prefix the CSP pins `style-src` to. */
const FOLDER_STYLES_CSS = `#sibling { color: rgb(0, 128, 0); }\n`;
const FOLDER_SUB_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Sub</title></head>
<body><h1>Sub page index</h1></body></html>
`;

test.beforeAll(async ({ apiFor, uniqueName, workerRequest: request }) => {
	projectName = uniqueName('site');
	const api = apiFor(ALICE);
	project = await body<Project>(await api.post('/api/v1/projects', { name: projectName }));
	issue = await body<IssueDetail>(
		await api.post(`/api/v1/projects/${project.id}/issues`, { title: `Site ${runId}` })
	);

	// A `text` artifact whose content type makes it a site. Asserted rather
	// than fire-and-forget: `content_type` is what decides sitehood, so a 422
	// here would surface as "the viewer shows markdown" three tests later.
	const put = await api.put(`/api/v1/issues/${issue.id}/artifacts/prototype`, {
		type: 'text',
		content: PROTOTYPE_HTML,
		content_type: 'text/html'
	});
	expect(put.status(), await put.text()).toBe(200);
	const raceSite = await api.put(`/api/v1/issues/${issue.id}/artifacts/race-site`, {
		type: 'text',
		content: '<h1>SITE VERSION ONE</h1>',
		content_type: 'text/html'
	});
	expect(raceSite.status(), await raceSite.text()).toBe(200);

	const folder = await request.put(`/api/v1/issues/${issue.id}/artifacts/mini-app/folder`, {
		headers: { authorization: `Bearer ${ALICE.apiKey}` },
		multipart: {
			f0: {
				name: 'index.html',
				mimeType: 'text/html',
				buffer: Buffer.from(FOLDER_INDEX_HTML)
			},
			f1: { name: 'app.js', mimeType: 'text/javascript', buffer: Buffer.from(FOLDER_APP_JS) },
			f2: { name: 'styles.css', mimeType: 'text/css', buffer: Buffer.from(FOLDER_STYLES_CSS) },
			f3: {
				name: 'sub/index.html',
				mimeType: 'text/html',
				buffer: Buffer.from(FOLDER_SUB_HTML)
			}
		}
	});
	expect(folder.status(), await folder.text()).toBe(200);
});

test.use({ signedIn: ALICE });

/** Mints a link the way the viewer does, for the request-level assertions. */
async function siteLink(page: Page, name: string): Promise<ArtifactSiteLink> {
	const res = await page.request.post(`/api/v1/issues/${issue.id}/artifacts/${name}/site-link`, {
		headers: { authorization: `Bearer ${ALICE.apiKey}` },
		data: {}
	});
	return body<ArtifactSiteLink>(res);
}

/**
 * Open the viewer on an artifact. Retried across the hydration window like
 * the other artifact specs: a click that lands before the listeners attach
 * is swallowed.
 */
async function openViewer(page: Page, name: string) {
	const dialog = page.getByRole('dialog', { name: 'Artifact viewer' });
	const opener = page.getByRole('button', { name: new RegExp(`^View ${name}`) });
	await expect(async () => {
		if (await opener.isVisible()) await opener.click();
		await expect(dialog).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 15_000 });
	return dialog;
}

function barrier() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => (release = resolve));
	return { promise, release };
}

test('superseded site-link success and failure cannot enter a reopened site view', async ({
	page
}) => {
	for (const outcome of ['success', 'failure'] as const) {
		const first = barrier();
		const second = barrier();
		let requests = 0;
		await page.route(`**/artifacts/prototype/site-link`, async (route) => {
			requests++;
			if (requests === 1) {
				const response = outcome === 'success' ? await route.fetch() : null;
				await first.promise;
				if (response) await route.fulfill({ response });
				else await route.abort('failed');
			} else {
				await second.promise;
				await route.continue();
			}
		});

		await gotoHydrated(page, issuePath(projectName, issue.number));
		const dialog = await openViewer(page, 'prototype');
		await expect.poll(() => requests).toBe(1);
		await dialog.getByRole('button', { name: 'Source' }).click();
		await expect(dialog.getByRole('button', { name: '← Back to the rendered page' })).toBeVisible();
		await dialog.getByRole('button', { name: '← Back to the rendered page' }).click();
		await expect.poll(() => requests).toBe(2);
		first.release();
		await expect(dialog.getByText('Preparing preview…')).toBeVisible();
		await expect(dialog.getByText('Couldn’t open this preview — close and retry.')).toHaveCount(0);
		await expect(dialog.getByRole('link', { name: 'Open full page' })).toHaveCount(0);
		await expect(dialog.locator('iframe[title="prototype preview"]')).toHaveCount(0);
		second.release();
		await expect(dialog.locator('iframe[title="prototype preview"]')).toBeVisible();
		await page.unroute(`**/artifacts/prototype/site-link`);
	}
});

test('site frame, source and download share the metadata snapshot across an upload', async ({
	page
}) => {
	await page.route(`**/api/v1/issues/${issue.id}/artifacts/race-site`, async (route) => {
		const v1Detail = await route.fetch();
		const appended = await page.request.put(`/api/v1/issues/${issue.id}/artifacts/race-site`, {
			headers: { authorization: `Bearer ${ALICE.apiKey}` },
			data: {
				type: 'text',
				content: '<h1>SITE VERSION TWO</h1>',
				content_type: 'text/html'
			}
		});
		expect(appended.status(), await appended.text()).toBe(200);
		await route.fulfill({ response: v1Detail });
	});

	await gotoHydrated(page, issuePath(projectName, issue.number));
	const dialog = await openViewer(page, 'race-site');
	await expect(page.frameLocator('iframe[title="race-site preview"]').locator('h1')).toHaveText(
		'SITE VERSION ONE'
	);
	const download = dialog.getByRole('link', { name: 'Download', exact: true });
	const href = await download.getAttribute('href');
	expect(new URL(href!, 'http://local').searchParams.get('version')).toBe('1');
	expect(await (await page.request.get(href!)).text()).toContain('SITE VERSION ONE');
	await dialog.getByRole('button', { name: 'Source' }).click();
	await expect(dialog.getByText('<h1>SITE VERSION ONE</h1>', { exact: true })).toBeVisible();
	await expect(dialog.getByText('SITE VERSION TWO')).toHaveCount(0);

	await page.unroute(`**/api/v1/issues/${issue.id}/artifacts/race-site`);
	await dialog.getByRole('button', { name: 'Close' }).click();
	await openViewer(page, 'race-site');
	await expect(page.frameLocator('iframe[title="race-site preview"]').locator('h1')).toHaveText(
		'SITE VERSION TWO'
	);
	const versions = dialog.getByRole('combobox', { name: 'Version' });
	await versions.selectOption('1');
	await expect(page.frameLocator('iframe[title="race-site preview"]').locator('h1')).toHaveText(
		'SITE VERSION ONE'
	);
	await versions.selectOption('current');
	await expect(page.frameLocator('iframe[title="race-site preview"]').locator('h1')).toHaveText(
		'SITE VERSION TWO'
	);
});

test('an HTML artifact renders live in the viewer, with its scripts running', async ({ page }) => {
	let requestedVersion: number | undefined;
	page.on('request', (request) => {
		if (request.url().endsWith(`/artifacts/prototype/site-link`)) {
			requestedVersion = request.postDataJSON().version;
		}
	});
	await gotoHydrated(page, issuePath(projectName, issue.number));
	const dialog = await openViewer(page, 'prototype');

	const frame = page.frameLocator('iframe[title="prototype preview"]');
	// Rendered as a page, not as an escaped source listing: the markdown/text
	// path would show the tags themselves.
	await expect(frame.locator('h1')).toHaveText('Prototype heading');
	await expect(frame.locator('#script')).toHaveText('script ran');
	expect(requestedVersion).toBe(1);

	// The whole security claim, from inside the page: `connect-src` names only
	// this artifact's own `/s/<token>/` prefix, so the Tines API is unreachable
	// even though the bytes are served from the app's own origin.
	await expect(frame.locator('#api')).toHaveText('api blocked');
	// Same-origin mode means an opaque origin, so storage throws — and the
	// viewer says so rather than letting a prototype fail mysteriously.
	await expect(frame.locator('#storage')).toHaveText('storage blocked');
	await expect(
		dialog.getByText('storage APIs (localStorage, cookies) are unavailable')
	).toBeVisible();
});

test('the width switcher narrows the frame to a phone and back', async ({ page }) => {
	await gotoHydrated(page, issuePath(projectName, issue.number));
	const dialog = await openViewer(page, 'prototype');

	const iframe = dialog.locator('iframe[title="prototype preview"]');
	await expect(iframe).toBeVisible();
	const widths = dialog.getByRole('radiogroup', { name: 'Preview width' });

	const full = await iframe.boundingBox();
	expect(full).not.toBeNull();
	// The dialog is far wider than a phone at the default viewport, so the
	// switcher has something to prove.
	expect(full!.width).toBeGreaterThan(500);

	await widths.getByRole('radio', { name: 'Phone' }).click();
	await expect(widths.getByRole('radio', { name: 'Phone' })).toHaveAttribute(
		'aria-checked',
		'true'
	);
	await expect(async () => {
		const phone = await iframe.boundingBox();
		expect(phone!.width).toBeLessThanOrEqual(390);
		expect(phone!.width).toBeGreaterThan(300);
	}).toPass({ timeout: 5_000 });

	await widths.getByRole('radio', { name: 'Full' }).click();
	await expect(async () => {
		const back = await iframe.boundingBox();
		expect(back!.width).toBeGreaterThan(500);
	}).toPass({ timeout: 5_000 });
});

test('Source shows the markup and comes back to the rendered page', async ({ page }) => {
	await gotoHydrated(page, issuePath(projectName, issue.number));
	const dialog = await openViewer(page, 'prototype');
	await expect(dialog.locator('iframe[title="prototype preview"]')).toBeVisible();

	await dialog.getByRole('button', { name: 'Source' }).click();
	await expect(dialog.locator('iframe[title="prototype preview"]')).toHaveCount(0);
	await expect(dialog.locator('pre')).toContainText('<title>Prototype</title>');

	await dialog.getByRole('button', { name: 'Back to the rendered page' }).click();
	await expect(dialog.locator('iframe[title="prototype preview"]')).toBeVisible();
});

test('Open full page loads the site as a top-level document', async ({ page, context }) => {
	await gotoHydrated(page, issuePath(projectName, issue.number));
	const dialog = await openViewer(page, 'prototype');
	await expect(dialog.locator('iframe[title="prototype preview"]')).toBeVisible();

	const popupPromise = context.waitForEvent('page');
	await dialog.getByRole('link', { name: 'Open full page' }).click();
	const popup = await popupPromise;
	await popup.waitForLoadState('domcontentloaded');

	// CSP `sandbox` applies to a top-level document too, so this is the same
	// URL with the same guarantees — no wrapper page, and scripts still run.
	expect(new URL(popup.url()).pathname).toMatch(/^\/s\/v1\./);
	await expect(popup.locator('#script')).toHaveText('script ran');
	await expect(popup.locator('#api')).toHaveText('api blocked');
});

test('a folder site resolves its relative siblings and steps into subfolders', async ({ page }) => {
	await gotoHydrated(page, issuePath(projectName, issue.number));
	const dialog = await openViewer(page, 'mini-app');

	const frame = page.frameLocator('iframe[title="mini-app preview"]');
	await expect(frame.locator('h1')).toHaveText('Mini app index');
	// `./app.js` and `./styles.css` only resolve because the entry document is
	// served at the `/s/<token>/` root rather than behind a `?path=` query.
	await expect(frame.locator('#sibling')).toHaveText('sibling script ran');
	await expect(frame.locator('#sibling')).toHaveCSS('color', 'rgb(0, 128, 0)');

	// The escape hatch out of the rendered page for a folder is its file list.
	await dialog.getByRole('button', { name: 'Files' }).click();
	const files = dialog.getByRole('list');
	await expect(files.getByRole('listitem')).toHaveCount(4);
	await expect(files.getByRole('button', { name: 'index.html', exact: true })).toBeVisible();
	await expect(files.getByRole('button', { name: 'styles.css', exact: true })).toBeVisible();
	await files.getByRole('button', { name: 'styles.css', exact: true }).click();
	await expect(dialog.locator('pre')).toHaveText(FOLDER_STYLES_CSS.trim());
	await dialog.getByRole('button', { name: 'all files' }).click();
	await expect(files.getByRole('listitem')).toHaveCount(4);
	await dialog.getByRole('button', { name: 'Back to the rendered page' }).click();
	await expect(frame.locator('#sibling')).toHaveText('sibling script ran');
});

test('a directory redirects to its trailing slash and serves its index', async ({ page }) => {
	const link = await siteLink(page, 'mini-app');
	expect(link.mode).toBe('same-origin');
	const base = link.url.replace(/\/$/, '');

	// Without the trailing slash a relative `./x` inside sub/index.html would
	// resolve against the token root, so the server bounces first.
	const bounced = await page.request.get(`${base}/sub`, { maxRedirects: 0 });
	expect(bounced.status()).toBe(302);
	expect(bounced.headers()['location']).toBe(new URL(`${base}/sub/`).pathname);

	const sub = await page.request.get(`${base}/sub/`);
	expect(sub.status()).toBe(200);
	expect(await sub.text()).toContain('Sub page index');

	// The token root itself is the entry document, and a path with no file 404s.
	const root = await page.request.get(`${base}/`);
	expect(await root.text()).toContain('Mini app index');
	expect((await page.request.get(`${base}/nope.html`)).status()).toBe(404);
});

test('served bytes carry the site headers, pinned to their own token prefix', async ({ page }) => {
	const link = await siteLink(page, 'prototype');
	expect(link.version).toBe(1);
	expect(link.expires_at).toBeGreaterThan(Date.now());

	const res = await page.request.get(link.url);
	expect(res.status()).toBe(200);
	const headers = res.headers();
	// The reversal this feature exists for: HTML served to run, not to download.
	expect(headers['content-type']).toContain('text/html');
	expect(headers['content-disposition']).toMatch(/^inline/);

	const csp = headers['content-security-policy'];
	expect(csp).toContain(`connect-src ${link.url}`);
	expect(csp).toContain(`default-src 'none'`);
	// Never `'self'`: that is what keeps `/api/v1` out of reach in this mode.
	expect(csp).not.toContain(`'self'`);
	expect(csp).toContain('sandbox allow-scripts');
	expect(csp).toContain(`frame-ancestors ${BASE_URL}`);
	expect(headers['x-robots-tag']).toContain('noindex');
	expect(headers['x-content-type-options']).toBe('nosniff');
});

test('a bad token gets an HTML error page, not a JSON error or a download', async ({ page }) => {
	await page.goto('/s/not-a-real-token/');
	await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();

	// Changing the final base64url character can affect only unused padding bits,
	// so change the decoded HMAC to ensure the signature bytes differ.
	const link = await siteLink(page, 'prototype');
	const token = new URL(link.url).pathname.split('/')[2];
	const [version, payload, signature] = token.split('.');
	const signatureBytes = Buffer.from(signature, 'base64url');
	expect(signatureBytes).toHaveLength(32);
	signatureBytes[0] ^= 1;
	const tampered = `${version}.${payload}.${signatureBytes.toString('base64url')}`;
	expect(signatureBytes.equals(Buffer.from(signature, 'base64url'))).toBe(false);
	const response = await page.goto(`/s/${tampered}/`);
	expect(response?.status()).toBe(404);
	await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();

	// A non-site artifact cannot be minted a link at all.
	await page.request.put(`/api/v1/issues/${issue.id}/artifacts/plain-notes`, {
		headers: { authorization: `Bearer ${ALICE.apiKey}` },
		data: { type: 'text', content: '# notes', content_type: 'text/markdown' }
	});
	const refused = await page.request.post(
		`/api/v1/issues/${issue.id}/artifacts/plain-notes/site-link`,
		{ headers: { authorization: `Bearer ${ALICE.apiKey}` }, data: {} }
	);
	expect(refused.status()).toBe(422);
	expect((await refused.json()).error.code).toBe('not_a_site');
});

/**
 * Browser integration for the dedicated-origin viewer branch. Wrangler local
 * host rewriting cannot reproduce the production hostname boundary, so this
 * fixture supplies the dedicated host with Playwright routing. The real hook
 * is exercised independently in hooks.server.test.ts; headers here come from
 * the same production builder, not a permissive substitute.
 */
test('the dedicated-origin iframe permits storage while containing the prototype', async ({
	page,
	context
}) => {
	const sandboxOrigin = 'https://artifact-sandbox.test';
	const token = 'browser-probe';
	const url = `${sandboxOrigin}/s/${token}/`;
	await context.route(`${sandboxOrigin}/**`, async (route) => {
		if (route.request().url() !== url) {
			await route.fulfill({ status: 404, body: 'Not found' });
			return;
		}
		await route.fulfill({
			status: 200,
			headers: siteHeaders({
				servedOrigin: sandboxOrigin,
				token,
				appOrigin: BASE_URL,
				sandboxed: false,
				contentType: 'text/html',
				filename: 'prototype.html'
			}),
			body: PROTOTYPE_HTML
		});
	});
	await page.route(`**/api/v1/issues/${issue.id}/artifacts/prototype/site-link`, (route) =>
		route.fulfill({
			json: { url, mode: 'sandbox-origin', version: 1, expires_at: Date.now() + 60_000 }
		})
	);
	await gotoHydrated(page, issuePath(projectName, issue.number));
	const dialog = await openViewer(page, 'prototype');
	const iframe = dialog.locator('iframe[title="prototype preview"]');
	await expect(iframe).toHaveAttribute('src', url);
	await expect(iframe).toHaveAttribute(
		'sandbox',
		'allow-scripts allow-same-origin allow-forms allow-modals allow-popups'
	);
	const frame = page.frameLocator('iframe[title="prototype preview"]');
	await expect(frame.locator('#script')).toHaveText('script ran');
	await expect(frame.locator('#storage')).toHaveText('storage works');
	await expect(frame.locator('#api')).toHaveText('api blocked');
	await expect(
		dialog.getByText('storage APIs (localStorage, cookies) are unavailable')
	).toHaveCount(0);
	const popupPromise = context.waitForEvent('page');
	await dialog.getByRole('link', { name: 'Open full page' }).click();
	const popup = await popupPromise;
	await expect(popup.locator('#storage')).toHaveText('storage works');
	await expect(popup.locator('#api')).toHaveText('api blocked');
});
