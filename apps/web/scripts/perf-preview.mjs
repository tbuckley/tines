#!/usr/bin/env node
// Navigation timings against a real PR preview (docs/PERFORMANCE.md, "PR
// previews"): signs in as the preview probe user (docs/preview-login.md),
// makes sure it owns a realistic project, then clicks through the app's main
// transitions in Chromium and reports what the app's own navigation telemetry
// measured for each one: click to new page mounted, the wait on its data
// request, and the server time that request reported.
//
//   PREVIEW_LOGIN_TOKEN=… pnpm --filter web perf:preview --pr 305 --base 299
//
// Options:
//   --pr N | --url URL     the preview to measure (repeatable)
//   --base N | --base-url URL
//                          a second preview to measure alongside, interleaved
//                          round by round, and compare against (the "before")
//   --rounds N             tours per preview, default 5
//   --json FILE            also write every sample as JSON
//
// Previews share one D1 database (`tines-preview`), so the seeded project is
// the same data for every preview; only the code differs. Timings are from
// wherever this script runs to the Cloudflare location the preview is served
// from, which it prints.
import { chromium } from '@playwright/test';
import { X509Certificate, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const PREVIEW_HOST = 'tines-web-preview.tbuckley.workers.dev';
const PROJECT = 'perf-probe';
const ISSUES = 250;
const COMMENTS = 30;
const PROBE_TITLE = 'Perf probe issue';

const args = process.argv.slice(2);
const all = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const one = (name, fallback) => all(name).at(-1) ?? fallback;
const prUrl = (n) => `https://pr-${n}-${PREVIEW_HOST}`;

const target = (url, base = false) => {
	const name = new URL(url).hostname.split('.')[0].replace(/-tines-web-preview$/, '');
	return { label: base ? `base ${name}` : name, url: url.replace(/\/$/, ''), base };
};
const targets = [...all('--pr').map(prUrl), ...all('--url')].map((url) => target(url));
const baseUrl = one('--base') ? prUrl(one('--base')) : one('--base-url');
if (baseUrl) targets.push(target(baseUrl, true));
const rounds = Number(one('--rounds', '5'));
const jsonOut = one('--json');
const token = process.env.PREVIEW_LOGIN_TOKEN;

if (!targets.some((t) => !t.base)) {
	console.error('Pass --pr N or --url URL (and optionally --base N).');
	process.exit(1);
}
if (!token) {
	console.error('Set PREVIEW_LOGIN_TOKEN (docs/preview-login.md).');
	process.exit(1);
}
if (!Number.isInteger(rounds) || rounds < 1) throw new Error('--rounds must be a positive integer');

async function signIn(target) {
	const res = await fetch(`${target.url}/api/preview-login`, {
		method: 'POST',
		headers: { authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		throw new Error(
			`${target.url}: preview login answered ${res.status}. ` +
				(res.status === 404
					? 'The preview predates the route or its PREVIEW_LOGIN_TOKEN secret; push to the PR to re-upload it.'
					: 'Check PREVIEW_LOGIN_TOKEN.')
		);
	}
	target.cookie = (await res.json()).cookie;
	const trace = await (await fetch(`${target.url}/cdn-cgi/trace`)).text();
	target.colo = trace.match(/^colo=(.+)$/m)?.[1] ?? '?';
}

async function call(target, method, path, body) {
	const res = await fetch(`${target.url}${path}`, {
		method,
		headers: {
			cookie: `${target.cookie.name}=${target.cookie.value}`,
			...(body ? { 'content-type': 'application/json' } : {})
		},
		body: body ? JSON.stringify(body) : undefined
	});
	if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
	return res.json();
}

/**
 * The probe user's project: `ISSUES` issues (the list shows the newest 100 a
 * page, and tab switches get slower as the project grows), the newest of which
 * has `COMMENTS` comments and a text artifact, roughly a worked issue. Created
 * once and topped up, since every preview reads the same database.
 */
async function ensureSeed(target) {
	const { items } = await call(target, 'GET', '/api/v1/projects?limit=100');
	const project =
		items.find((p) => p.name === PROJECT) ??
		(await call(target, 'POST', '/api/v1/projects', {
			name: PROJECT,
			description: 'Seeded by perf:preview. Safe to leave.',
			initial_prompt: ''
		}));
	const issues = [];
	let cursor = '';
	do {
		const page = await call(
			target,
			'GET',
			`/api/v1/issues?project=${PROJECT}&limit=100&hide_duplicates=false${cursor}`
		);
		issues.push(...page.items);
		cursor = page.next_cursor ? `&cursor=${encodeURIComponent(page.next_cursor)}` : '';
	} while (cursor);

	const create = (body) => call(target, 'POST', `/api/v1/projects/${project.id}/issues`, body);
	for (let i = issues.length; i < ISSUES - 1; i++) {
		await create({
			title: `Ambient issue ${i + 1}`,
			description: 'Filler so list queries are not degenerate.'
		});
	}
	// The probe issue is opened from the list, so it must be the newest issue:
	// retire an older one rather than paging to it.
	const probe = issues.find((i) => i.title === PROBE_TITLE);
	if (probe && issues.length >= ISSUES - 1 && issues[0].id === probe.id) return;
	if (probe) {
		await call(target, 'PATCH', `/api/v1/issues/${probe.id}`, { title: 'Former perf probe issue' });
	}
	const fresh = await create({
		title: PROBE_TITLE,
		description: 'The issue perf:preview opens. '.repeat(40)
	});
	for (let i = 0; i < COMMENTS; i++) {
		await call(target, 'POST', `/api/v1/issues/${fresh.id}/comments`, {
			body: `Comment ${i + 1}: ${'a realistic amount of text. '.repeat(8)}`
		});
	}
	await call(target, 'PUT', `/api/v1/issues/${fresh.id}/artifacts/design`, {
		type: 'text',
		content: '# Design\n\n' + 'A paragraph of design notes.\n\n'.repeat(30)
	});
}

// Capture the app's own navigation records instead of letting them reach the
// preview's telemetry dataset: the numbers are the real-user measurement,
// without skewing what `perf:report --preview` shows.
const CAPTURE = () => {
	window.__perf = [];
	const send = navigator.sendBeacon.bind(navigator);
	navigator.sendBeacon = (url, body) => {
		if (!String(url).endsWith('/api/telemetry')) return send(url, body);
		body.text().then((text) => window.__perf.push(...JSON.parse(text).records));
		return true;
	};
};

async function navRecord(page, before) {
	for (let i = 0; i < 100; i++) {
		const records = await page.evaluate(() => {
			dispatchEvent(new Event('pagehide')); // flushes the telemetry queue
			return window.__perf.filter((r) => r.k === 'nav');
		});
		if (records.length > before) return records.at(-1);
		await page.waitForTimeout(50);
	}
	throw new Error(`No navigation record arrived at ${page.url()}`);
}

/** One transition: click, then read what the app recorded for it. */
async function step(page, name, click, samples, target, round) {
	const before = await page.evaluate(() => window.__perf.filter((r) => r.k === 'nav').length);
	const started = Date.now();
	await click();
	const r = await navRecord(page, before);
	await page.waitForLoadState('networkidle'); // let streamed panels land before the next click
	samples.push({
		target: target.label,
		round,
		step: name,
		route: r.route,
		ms: r.ms,
		wait: Math.round(r.wait),
		server: Math.round(r.app),
		preloaded: r.pre,
		wall: Date.now() - started
	});
}

async function tour(context, target, samples, round) {
	const page = await context.newPage();
	await page.goto(`${target.url}/issues?project=${PROJECT}`, { waitUntil: 'networkidle' });
	const tab = (label) => page.locator('header nav a', { hasText: label }).first();
	const issue = page.locator('a', { hasText: PROBE_TITLE }).first();
	const run = (name, click) => step(page, name, click, samples, target, round);

	await run('/issues → issue', () => issue.click());
	await run('issue → back', () => page.goBack());
	await run('/issues → issue (again)', () => issue.click());
	await run('issue → /agents', () => tab('Agents').click());
	await run('/agents → /workflows', () => tab('Workflows').click());
	await run('/workflows → /issues', () => tab('Issues').click());
	await run('/issues → Active filter', () =>
		page.locator('a[href="/issues?category=active"]').first().click()
	);
	await run('/issues → /agents', () => tab('Agents').click());
	await run('/agents → /issues', () => tab('Issues').click());
	await page.close();
}

// Negative wait and server times mean the app could not tell; leave them out.
const pct = (xs, p) => {
	const s = xs.filter((x) => x >= 0).sort((a, b) => a - b);
	return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : '—';
};

const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
// Chromium keeps its own trust store, so a TLS-inspecting proxy that Node
// trusts through NODE_EXTRA_CA_CERTS would fail every page load. Trust exactly
// those extra CAs in the browser too, by public-key hash.
const extraCaSpki = () => {
	const file = process.env.NODE_EXTRA_CA_CERTS;
	if (!file || !existsSync(file)) return [];
	const pems = readFileSync(file, 'utf8').match(
		/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g
	);
	return (pems ?? []).map((pem) =>
		createHash('sha256')
			.update(new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' }))
			.digest('base64')
	);
};
const spki = extraCaSpki();
// Same browser resolution as playwright.config.ts.
const browser = await chromium.launch({
	executablePath:
		process.env.PLAYWRIGHT_CHROMIUM_PATH ??
		(existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined),
	// Chromium ignores HTTPS_PROXY on its own; pass it through where one is set.
	...(proxy ? { proxy: { server: proxy } } : {}),
	args: spki.length ? [`--ignore-certificate-errors-spki-list=${spki.join(',')}`] : []
});
const samples = [];
try {
	for (const target of targets) {
		await signIn(target);
		await ensureSeed(target);
		target.context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await target.context.addInitScript(CAPTURE);
		await target.context.addCookies([
			{ ...target.cookie, url: target.url, httpOnly: true, secure: true, sameSite: 'Lax' }
		]);
		console.error(`${target.label}: ${target.url} (served from ${target.colo})`);
	}
	// Interleave rounds so a slow minute on the network hits every preview alike.
	for (let round = 0; round <= rounds; round++) {
		for (const target of targets) {
			const into = round === 0 ? [] : samples; // round 0 warms caches and isolates
			await tour(target.context, target, into, round);
		}
		if (round) console.error(`round ${round}/${rounds} done`);
	}
} finally {
	await browser.close();
}

const steps = [...new Set(samples.map((s) => s.step))];
const stat = (target, stepName, key, p) =>
	pct(
		samples.filter((s) => s.target === target.label && s.step === stepName).map((s) => s[key]),
		p
	);
const main = targets.filter((t) => !t.base);
const baseTarget = targets.find((t) => t.base);
console.log(
	`\nClick to page mounted, ms (p50 / p75 of ${rounds} rounds; app telemetry). ` +
		`Served from ${[...new Set(targets.map((t) => t.colo))].join(', ')}.\n`
);
const header = ['transition'];
for (const t of targets) header.push(`${t.label} p50`, 'p75', 'wait', 'server');
if (baseTarget) header.push('Δ p50');
console.log(header.join('\t'));
for (const name of steps) {
	const row = [name];
	for (const t of targets) {
		row.push(
			stat(t, name, 'ms', 0.5),
			stat(t, name, 'ms', 0.75),
			stat(t, name, 'wait', 0.5),
			stat(t, name, 'server', 0.5)
		);
	}
	if (baseTarget) {
		const d = stat(main[0], name, 'ms', 0.5) - stat(baseTarget, name, 'ms', 0.5);
		row.push(`${d > 0 ? '+' : ''}${d}`);
	}
	console.log(row.join('\t'));
}
if (jsonOut) {
	writeFileSync(
		jsonOut,
		JSON.stringify(
			{ targets: targets.map(({ label, url, colo }) => ({ label, url, colo })), samples },
			null,
			2
		)
	);
}
