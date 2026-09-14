import { spawn, execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { chromium } from '@playwright/test';
import { AUTH_SECRET } from '../e2e/constants.mjs';
import { WEEKLY } from '../e2e/stage-stats-seed.mjs';

const port = Number(process.env.STATS_PROFILE_PORT ?? 8898);
const baseURL = `http://127.0.0.1:${port}`;
const samples = Number(process.env.STATS_PROFILE_SAMPLES ?? 10);
const server = spawn('bash', ['e2e/server.sh'], {
	env: { ...process.env, E2E_PORT: String(port), CI: '1', STATS_SCALE: '1' },
	stdio: ['ignore', 'pipe', 'pipe']
});
server.stdout.pipe(process.stderr);
server.stderr.pipe(process.stderr);

const waitForServer = async () => {
	for (let attempt = 0; attempt < 180; attempt++) {
		try {
			if ((await fetch(`${baseURL}/login`, { redirect: 'manual' })).status < 500) return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error('isolated Worker did not start');
};
const percentile = (values, rank) =>
	[...values].sort((a, b) => a - b)[Math.ceil(values.length * rank) - 1];
const measure = async (name, request) => {
	const values = [],
		timings = [],
		bytes = [];
	for (let index = 0; index < samples; index++) {
		const started = performance.now();
		const response = await request();
		values.push(performance.now() - started);
		const isFetch = response.headers instanceof Headers;
		timings.push(
			isFetch ? response.headers.get('server-timing') : await response.headerValue('server-timing')
		);
		bytes.push(
			isFetch
				? (await response.clone().arrayBuffer()).byteLength
				: (await response.body()).byteLength
		);
		const ok = isFetch ? response.ok : response.ok();
		const status = isFetch ? response.status : response.status();
		if (!ok) throw new Error(`${name}: HTTP ${status}`);
	}
	return {
		name,
		ms: values.map((v) => Number(v.toFixed(1))),
		median_ms: Number(percentile(values, 0.5).toFixed(1)),
		p95_ms: Number(percentile(values, 0.95).toFixed(1)),
		server_timing: timings,
		response_bytes: bytes
	};
};

try {
	await waitForServer();
	const auth = { authorization: `Bearer ${WEEKLY.apiKey}` };
	const signature = createHmac('sha256', AUTH_SECRET).update(WEEKLY.sessionToken).digest('base64');
	const cookie = `better-auth.session_token=${WEEKLY.sessionToken}.${signature}`;
	const results = [];
	for (const [name, path] of [
		['api_unfiltered', '/api/v1/supervisor/stats?window=7d'],
		['api_project', `/api/v1/supervisor/stats?window=7d&project=${WEEKLY.projectId}`],
		['api_compare_none', '/api/v1/supervisor/stats?window=7d&compare=none'],
		['evidence', '/api/v1/supervisor/stats/sent-back?state=ws_review']
	])
		results.push(await measure(name, () => fetch(baseURL + path, { headers: auth })));
	const browser = await chromium.launch();
	const context = await browser.newContext({ extraHTTPHeaders: { cookie } });
	const page = await context.newPage();
	results.push(
		await measure('agents_authenticated', async () => {
			const response = await page.goto(`${baseURL}/agents`, { waitUntil: 'networkidle' });
			if (!response) throw new Error('agents navigation returned no response');
			return response;
		})
	);
	await browser.close();
	const plan = execFileSync(
		'pnpm',
		[
			'exec',
			'wrangler',
			'd1',
			'execute',
			'tines',
			'--local',
			'--persist-to',
			'.wrangler-e2e',
			'--json',
			'--command',
			"EXPLAIN QUERY PLAN SELECT id FROM event INDEXED BY event_user_type_created_idx WHERE user_id='usr_weekly' AND type IN ('issue.created','issue.transitioned') AND created_at>=0 AND created_at<9999999999999"
		],
		{ encoding: 'utf8' }
	);
	console.log(
		JSON.stringify(
			{
				fixture: {
					added_issues: 524,
					states: 28,
					added_runs: 1525,
					added_stats_events: 2096,
					markers: 20
				},
				samples,
				results,
				native_plan: JSON.parse(plan)
			},
			null,
			2
		)
	);
} finally {
	server.kill('SIGTERM');
}
