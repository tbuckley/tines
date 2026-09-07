import type { ArtifactSiteLink, IssueDetail, Project } from '@tines/shared';
import { expect, test, type Page } from '@playwright/test';
import { ALICE, BASE_URL } from './constants.mjs';
import { apiClient, body, gotoHydrated, runId, signIn } from './helpers';

/**
 * HTML artifacts served as live sites (Tines/272, specs/artifacts/SPEC.md
 * "Sites"). Everything else about this feature is unit-tested; what only a
 * real browser can answer is whether the bytes actually *run* — scripts
 * executing inside the frame, a sibling `./app.js` and `./styles.css`
 * resolving through `/s/<token>/`, and the CSP holding the page away from
 * the Tines API while it does.
 *
 * The suite serves the app on `127.0.0.1` and sets
 * `ARTIFACT_SANDBOX_ORIGIN` to `localhost`, so the viewer exercises the real
 * cross-origin mode while a replay of the same token on the app origin proves
 * the fallback remains sandboxed. The two hosts reach the same worker, but
 * only the sandbox host is gated to `/s/*` and allowed to use storage APIs.
 */

const projectName = `site-${runId}`;
const SANDBOX_ORIGIN = BASE_URL.replace('127.0.0.1', 'localhost');
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
		(response) => {
			document.getElementById('api').textContent = response.ok ? 'api reachable' : 'api blocked';
		},
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

test.beforeAll(async ({ playwright }) => {
	const request = await playwright.request.newContext({
		baseURL: test.info().project.use.baseURL
	});
	const api = apiClient(request, ALICE.apiKey);
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

	await request.dispose();
});

test.beforeEach(async ({ context }) => {
	await signIn(context, ALICE.sessionToken);
});

const issueUrl = () => `/issues/${encodeURIComponent(projectName)}/${issue.number}`;

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

test('an HTML artifact renders live in the viewer, with its scripts running', async ({ page }) => {
	await gotoHydrated(page, issueUrl());
	const dialog = await openViewer(page, 'prototype');

	const frame = page.frameLocator('iframe[title="prototype preview"]');
	// Rendered as a page, not as an escaped source listing: the markdown/text
	// path would show the tags themselves.
	await expect(frame.locator('h1')).toHaveText('Prototype heading');
	await expect(frame.locator('#script')).toHaveText('script ran');

	// The whole security claim, from inside the page: the sandbox hostname gate
	// returns 404 for `/api/v1`, while `connect-src` permits only this origin's
	// own signed artifact prefix.
	await expect(frame.locator('#api')).toHaveText('api blocked');
	// The dedicated host is a real origin, so prototypes can persist state.
	await expect(frame.locator('#storage')).toHaveText('storage works');
	await expect(
		dialog.getByText('storage APIs (localStorage, cookies) are unavailable')
	).toHaveCount(0);
});

test('the width switcher narrows the frame to a phone and back', async ({ page }) => {
	await gotoHydrated(page, issueUrl());
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
	await gotoHydrated(page, issueUrl());
	const dialog = await openViewer(page, 'prototype');
	await expect(dialog.locator('iframe[title="prototype preview"]')).toBeVisible();

	await dialog.getByRole('button', { name: 'Source' }).click();
	await expect(dialog.locator('iframe[title="prototype preview"]')).toHaveCount(0);
	await expect(dialog.locator('pre')).toContainText('<title>Prototype</title>');

	await dialog.getByRole('button', { name: 'Back to the rendered page' }).click();
	await expect(dialog.locator('iframe[title="prototype preview"]')).toBeVisible();
});

test('Open full page loads the site as a top-level document', async ({ page, context }) => {
	await gotoHydrated(page, issueUrl());
	const dialog = await openViewer(page, 'prototype');
	await expect(dialog.locator('iframe[title="prototype preview"]')).toBeVisible();

	const popupPromise = context.waitForEvent('page');
	await dialog.getByRole('link', { name: 'Open full page' }).click();
	const popup = await popupPromise;
	await popup.waitForLoadState('domcontentloaded');

	// This is the exact sandbox-host URL with no wrapper page, and scripts and
	// storage keep working as a top-level app.
	expect(new URL(popup.url()).origin).toBe(SANDBOX_ORIGIN);
	expect(new URL(popup.url()).pathname).toMatch(/^\/s\/v1\./);
	await expect(popup.locator('#script')).toHaveText('script ran');
	await expect(popup.locator('#api')).toHaveText('api blocked');
	await expect(popup.locator('#storage')).toHaveText('storage works');
});

test('a folder site resolves its relative siblings and steps into subfolders', async ({ page }) => {
	await gotoHydrated(page, issueUrl());
	const dialog = await openViewer(page, 'mini-app');

	const frame = page.frameLocator('iframe[title="mini-app preview"]');
	await expect(frame.locator('h1')).toHaveText('Mini app index');
	// `./app.js` and `./styles.css` only resolve because the entry document is
	// served at the `/s/<token>/` root rather than behind a `?path=` query.
	await expect(frame.locator('#sibling')).toHaveText('sibling script ran');
	await expect(frame.locator('#sibling')).toHaveCSS('color', 'rgb(0, 128, 0)');

	// The escape hatch out of the rendered page for a folder is its file list.
	await dialog.getByRole('button', { name: 'Files' }).click();
	await expect(dialog.getByText('app.js')).toBeVisible();
});

test('a directory redirects to its trailing slash and serves its index', async ({ page }) => {
	const link = await siteLink(page, 'mini-app');
	expect(link.mode).toBe('sandbox-origin');
	expect(new URL(link.url).origin).toBe(SANDBOX_ORIGIN);
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
	expect(link.mode).toBe('sandbox-origin');
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
	// Never `'self'`: artifact subresources stay pinned to this signed prefix.
	expect(csp).not.toContain(`'self'`);
	expect(csp).not.toContain('sandbox allow-scripts');
	expect(csp).toContain(`frame-ancestors ${BASE_URL}`);
	expect(headers['x-robots-tag']).toContain('noindex');
	expect(headers['x-content-type-options']).toBe('nosniff');

	// The sandbox hostname is a hard allowlist, not merely a cookie boundary.
	const gated = await page.request.get(`${SANDBOX_ORIGIN}/issues`);
	expect(gated.status()).toBe(404);
	expect(await gated.text()).toBe('Not found');
});

test('replaying a sandbox link on the app origin activates fallback containment', async ({
	page
}) => {
	const link = await siteLink(page, 'prototype');
	const fallbackUrl = link.url.replace(SANDBOX_ORIGIN, BASE_URL);
	const response = await page.request.get(fallbackUrl);
	expect(response.status()).toBe(200);
	const csp = response.headers()['content-security-policy'];
	expect(csp).toContain(`connect-src ${fallbackUrl}`);
	expect(csp).toContain('sandbox allow-scripts');

	await page.goto(fallbackUrl);
	await expect(page.locator('#script')).toHaveText('script ran');
	await expect(page.locator('#api')).toHaveText('api blocked');
	await expect(page.locator('#storage')).toHaveText('storage blocked');
});

test('a bad token gets an HTML error page, not a JSON error or a download', async ({ page }) => {
	await page.goto('/s/not-a-real-token/');
	await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();

	// A real token with one character of its signature changed: the HMAC is
	// the only thing standing between a reader and someone else's artifact.
	const link = await siteLink(page, 'prototype');
	const token = new URL(link.url).pathname.split('/')[2];
	const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
	expect(tampered).not.toBe(token);
	await page.goto(`/s/${tampered}/`);
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
