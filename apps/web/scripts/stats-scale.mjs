import { spawn, execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { chromium } from '@playwright/test';
import { AUTH_SECRET } from '../e2e/constants.mjs';
import { WEEKLY } from '../e2e/stage-stats-seed.mjs';

const port = Number(process.env.STATS_PROFILE_PORT ?? 8898);
const baseURL = `http://127.0.0.1:${port}`;
const samples = Number(process.env.STATS_PROFILE_SAMPLES ?? 10);
const seedNow = Date.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (values, rank) =>
	[...values].sort((a, b) => a - b)[Math.ceil(values.length * rank) - 1];
const hash = (value) => createHash('sha256').update(value).digest('hex');

function payloadHash(name, text) {
	if (name === 'agents_authenticated') return null;
	const body = JSON.parse(text);
	const stable = (value) => {
		if (Array.isArray(value)) return value.map(stable);
		if (!value || typeof value !== 'object') return value;
		return Object.fromEntries(
			Object.entries(value)
				.filter(
					([key]) => key !== 'at' && key !== 'since' && key !== 'until' && !key.endsWith('_at')
				)
				.map(([key, child]) => [key, stable(child)])
		);
	};
	return hash(JSON.stringify(stable(body)));
}

const sqlLiteral = (value) =>
	value === null
		? 'NULL'
		: typeof value === 'number'
			? String(value)
			: `'${String(value).replaceAll("'", "''")}'`;
function bindSql(sql, parameters) {
	let index = 0;
	return sql.replaceAll('?', () => sqlLiteral(parameters[index++]));
}

async function profile(multiplier, repeatedPreparation = false) {
	const server = spawn('bash', ['e2e/server.sh'], {
		env: {
			...process.env,
			E2E_PORT: String(port),
			CI: '1',
			STATS_SCALE: '1',
			STATS_IRRELEVANT_MULTIPLIER: String(multiplier),
			E2E_SEED_NOW: String(seedNow),
			USAGE_SCALE_SQL_TRACE: '1',
			STATS_SCALE_REPEAT_PREPARATION: repeatedPreparation ? '1' : ''
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let workerLog = '';
	server.stdout.on('data', (chunk) => (workerLog += chunk));
	server.stderr.on('data', (chunk) => (workerLog += chunk));
	const waitForServer = async () => {
		for (let attempt = 0; attempt < 180; attempt++) {
			if (server.exitCode !== null) throw new Error(`Worker exited early\n${workerLog}`);
			try {
				if ((await fetch(`${baseURL}/login`, { redirect: 'manual' })).status < 500) return;
			} catch {}
			await sleep(500);
		}
		throw new Error(`isolated Worker did not start\n${workerLog}`);
	};
	const tracesSince = async (start) => {
		await sleep(100);
		return [...workerLog.slice(start).matchAll(/\[USAGE_SCALE_SQL\](\{[^\n]+\})/g)].map((match) =>
			JSON.parse(match[1])
		);
	};
	const measure = async (name, request) => {
		const values = [],
			timings = [],
			bytes = [],
			requestTraces = [],
			hashes = [];
		for (let index = 0; index < samples; index++) {
			const traceStart = workerLog.length;
			const started = performance.now();
			const response = await request(index);
			values.push(performance.now() - started);
			const isFetch = response.headers instanceof Headers;
			timings.push(
				isFetch
					? response.headers.get('server-timing')
					: await response.headerValue('server-timing')
			);
			const body = isFetch ? await response.text() : (await response.body()).toString();
			bytes.push(Buffer.byteLength(body));
			hashes.push(payloadHash(name, body));
			const ok = isFetch ? response.ok : response.ok();
			if (!ok) throw new Error(`${name}: HTTP ${isFetch ? response.status : response.status()}`);
			requestTraces.push(await tracesSince(traceStart));
		}
		return {
			name,
			ms: values.map((value) => Number(value.toFixed(1))),
			median_ms: Number(percentile(values, 0.5).toFixed(1)),
			p95_ms: Number(percentile(values, 0.95).toFixed(1)),
			server_timing: timings,
			response_bytes: bytes,
			query_counts: requestTraces.map((traces) => traces.length),
			rows_read: requestTraces.map((traces) =>
				traces.reduce((sum, trace) => sum + trace.rows_read, 0)
			),
			transferred_rows: requestTraces.map((traces) =>
				traces.reduce((sum, trace) => sum + trace.returned_rows, 0)
			),
			query_profile: requestTraces[0].map((trace) => ({
				rows_read: trace.rows_read,
				returned_rows: trace.returned_rows,
				duration_ms: trace.duration_ms,
				sql: trace.sql
			})),
			payload_sha256: hashes[0],
			traces: requestTraces
		};
	};

	let browser;
	try {
		await waitForServer();
		const auth = { authorization: `Bearer ${WEEKLY.apiKey}` };
		const signature = createHmac('sha256', AUTH_SECRET)
			.update(WEEKLY.sessionToken)
			.digest('base64');
		const cookie = `better-auth.session_token=${WEEKLY.sessionToken}.${signature}`;
		const results = [];
		for (const [name, path] of [
			['api_unfiltered', '/api/v1/supervisor/stats?window=7d'],
			['api_project', `/api/v1/supervisor/stats?window=7d&project=${WEEKLY.projectId}`],
			['api_compare_none', '/api/v1/supervisor/stats?window=7d&compare=none'],
			['evidence', '/api/v1/supervisor/stats/sent-back?state=ws_review']
		])
			results.push(await measure(name, () => fetch(baseURL + path, { headers: auth })));
		browser = await chromium.launch();
		const context = await browser.newContext({ extraHTTPHeaders: { cookie } });
		const page = await context.newPage();
		results.push(
			await measure('agents_authenticated', async (index) => {
				const response = await page.goto(`${baseURL}/agents?profile=${index}`, {
					waitUntil: 'networkidle'
				});
				if (!response) throw new Error('agents navigation returned no response');
				return response;
			})
		);
		const eventTrace = results
			.flatMap((result) => result.traces.flat())
			.find(
				(trace) =>
					trace.sql?.includes('from "event"') &&
					trace.sql.includes('"event"."type" in') &&
					trace.parameters.includes('issue.created')
			);
		if (!eventTrace) throw new Error('shipping stats-event SQL telemetry absent');
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
				`EXPLAIN QUERY PLAN ${bindSql(eventTrace.sql, eventTrace.parameters)}`
			],
			{ encoding: 'utf8' }
		);
		return {
			mode: repeatedPreparation ? 'baseline_repeated_preparation' : 'shared_preparation',
			irrelevant_event_multiplier: multiplier,
			irrelevant_events: 1_000 * multiplier,
			results: results.map(({ traces: _traces, ...result }) => result),
			shipping_event_query: { sql: eventTrace.sql, parameters: eventTrace.parameters },
			native_plan: JSON.parse(plan)
		};
	} finally {
		await browser?.close();
		server.kill('SIGTERM');
		await Promise.race([new Promise((resolve) => server.once('exit', resolve)), sleep(5_000)]);
	}
}

const baseline = await profile(1, true);
const one = await profile(1);
const ten = await profile(10);
for (const result of one.results) {
	if (!result.payload_sha256) continue;
	const old = baseline.results.find((candidate) => candidate.name === result.name);
	const other = ten.results.find((candidate) => candidate.name === result.name);
	if (old?.payload_sha256 !== result.payload_sha256)
		throw new Error(`${result.name}: baseline and shared-preparation output differ`);
	if (other?.payload_sha256 !== result.payload_sha256)
		throw new Error(`${result.name}: approved figures/evidence changed at 10× irrelevant volume`);
}
console.log(
	JSON.stringify(
		{
			fixture: { added_issues: 524, states: 28, added_runs: 1525, markers: 20 },
			samples,
			profiles: [baseline, one, ten]
		},
		null,
		2
	)
);
