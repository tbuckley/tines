// Real authenticated Worker + spawned TypeScript-source CLI acceptance gate.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
	bounds,
	from,
	to,
	user,
	foreignUser,
	seedMixed,
	verifyMixed,
	assertAggregate,
	selected
} from '../test-fixtures/usage-mixed.mjs';
const webDir = fileURLToPath(new URL('..', import.meta.url));
const cliDir = fileURLToPath(new URL('../../../packages/cli', import.meta.url));
const persist = '.wrangler-usage-mixed';
const localKey = 'tines_mixed_local_only_0000000000000000000000000000';
const runKey = `${localKey}_run`;
const foreignKey = `${localKey}_foreign`;
const wrangler = (args) =>
	execFileSync('pnpm', ['exec', 'wrangler', ...args], {
		cwd: webDir,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'inherit']
	});
rmSync(`${webDir}/${persist}`, { recursive: true, force: true });
wrangler(['d1', 'migrations', 'apply', 'tines', '--local', '--persist-to', persist]);
const d1dir = `${webDir}/${persist}/v3/d1/miniflare-D1DatabaseObject`;
const files = readdirSync(d1dir).filter((f) => f.endsWith('.sqlite'));
const candidates = files.map((file) => new DatabaseSync(`${d1dir}/${file}`));
const db = candidates.find((db) =>
	db.prepare("SELECT name FROM sqlite_master WHERE name='agent_run'").get()
);
assert.ok(db, 'migrated application DB must exist');
for (const other of candidates) if (other !== db) other.close();
seedMixed(db);
for (const [id, key, owner, run] of [
	['mixed_key', localKey, user, null],
	['mixed_run_key', runKey, user, 'arun_mixed_143'],
	['mixed_foreign_key', foreignKey, foreignUser, null]
])
	db.prepare(
		'INSERT INTO api_key (id,user_id,name,key_hash,key_prefix,created_at,agent_run_id,expires_at) VALUES (?,?,?,?,?,?,?,?)'
	).run(
		id,
		owner,
		id,
		createHash('sha256').update(key).digest('hex'),
		'tines_mixed',
		from,
		run,
		Date.now() + 3600000
	);
db.close();
if (!process.argv.includes('--skip-build'))
	execFileSync('pnpm', ['build'], { cwd: webDir, stdio: 'inherit' });
const port = 19000 + (process.pid % 1000),
	baseUrl = `http://127.0.0.1:${port}`;
const worker = spawn(
	'pnpm',
	[
		'exec',
		'wrangler',
		'dev',
		'--port',
		String(port),
		'--host',
		`127.0.0.1:${port}`,
		'--persist-to',
		persist,
		'--var',
		'BETTER_AUTH_SECRET:mixed-local-secret-0000000000000000000000',
		'--var',
		`BETTER_AUTH_URL:${baseUrl}`,
		'--var',
		'SECRET_ENCRYPTION_KEY:mixed-local-only'
	],
	{ cwd: webDir, stdio: ['ignore', 'pipe', 'pipe'], detached: true }
);
let logs = '';
worker.stdout.on('data', (b) => (logs += b));
worker.stderr.on('data', (b) => (logs += b));
const comparable = (report) => {
	const copy = structuredClone(report);
	delete copy.generated_at;
	return copy;
};
const flags = (query) =>
	Object.entries(query).flatMap(([k, v]) => [`--${k.replaceAll('_', '-')}`, String(v)]);
// Resolve tsx relative to the CLI package; every process executes src/index.ts directly.
const cli = (command, query = {}, json = true, key = localKey) =>
	execFileSync(
		'node',
		[
			'--import',
			'tsx',
			'src/index.ts',
			...command,
			'--url',
			baseUrl,
			'--api-key',
			key,
			...flags(query),
			...(json ? ['--json'] : [])
		],
		{
			cwd: cliDir,
			encoding: 'utf8',
			maxBuffer: 32 * 1024 * 1024,
			env: { ...process.env, TINES_API_URL: baseUrl, TINES_API_KEY: key },
			stdio: ['ignore', 'pipe', 'pipe']
		}
	);
let cliCalls = 0;
try {
	for (let attempt = 0; ; attempt++) {
		try {
			await fetch(baseUrl);
			break;
		} catch {
			if (attempt > 300 || worker.exitCode !== null) throw new Error(logs);
			await new Promise((r) => setTimeout(r, 100));
		}
	}
	const request = async (path, query, key = localKey, expected = 200) => {
		const response = await fetch(`${baseUrl}/api/v1${path}?${new URLSearchParams(query)}`, {
			headers: { authorization: `Bearer ${key}` }
		});
		const body = await response.json();
		assert.equal(response.status, expected, JSON.stringify(body));
		return body;
	};
	const receipt = await verifyMixed(request, async (filters, report, populations) => {
		const cliReport = JSON.parse(cli(['usage'], { ...bounds, ...filters }));
		cliCalls++;
		assert.deepEqual(comparable(cliReport), comparable(report));
		const text = cli(['usage'], { ...bounds, ...filters }, false);
		cliCalls++;
		assert.ok(text.includes(`${report.scope_total.finalized_run_count} finalized`));
		assert.ok(text.includes('Scope sources:'));
		assert.ok(text.includes('Matching diagnostics:'));
		for (const [population, items] of Object.entries(populations)) {
			const query = {
				...(population === 'pending'
					? report.pending_evidence_filters
					: report.matching_evidence_filters),
				limit: '17'
			};
			const command = ['runs', 'list', '--all-pages'];
			const output = JSON.parse(cli(command, query));
			cliCalls++;
			assert.equal(output.next_cursor, null);
			assert.deepEqual(output.items, items);
			const rendered = cli(command, query, false);
			cliCalls++;
			if (items.length && population === 'finalized') assert.ok(rendered.includes('Accounting'));
			if (population === 'pending') assert.ok(!rendered.includes('future-secret'));
			if (
				population === 'finalized' &&
				items.some((i) => i.usage_accounting.basis?.rate_id === 'mixed-rate')
			)
				for (const reference of [
					'id mixed-rate',
					'version v7',
					'source https://example.test/rates',
					'effective 2023-10-01',
					'adopted 2023-11-14'
				])
					assert.ok(rendered.includes(reference), reference);
		}
	});
	// Defaults and manual CLI cursors remain separate from --all-pages' deduplication.
	const first = JSON.parse(cli(['runs', 'list'], { ...bounds, population: 'finalized' }));
	assert.equal(first.items.length, 50);
	assert.ok(first.next_cursor);
	const manual = [];
	let cursor;
	do {
		const page = JSON.parse(
			cli(['runs', 'list'], {
				...bounds,
				population: 'pending',
				limit: '19',
				...(cursor ? { cursor } : {})
			})
		);
		manual.push(...page.items);
		cursor = page.next_cursor;
	} while (cursor);
	assert.equal(manual.length, 107);
	assert.equal(new Set(manual.map((r) => r.id)).size, 107);
	const defaultUsage = JSON.parse(cli(['usage']));
	assert.equal(defaultUsage.by, 'workflow');
	assert.equal(defaultUsage.timezone, 'UTC');
	assert.equal(defaultUsage.scope_total.finalized_run_count, 0);
	for (const bad of [
		{ limit: '1junk' },
		{ limit: '101' },
		{ limit: '0' },
		{ from: '2026-02-30T00:00:00Z' },
		{ active: 'true' }
	]) {
		const query = { ...bounds, population: 'finalized', ...bad };
		await request('/runs', query, localKey, 422);
		assert.throws(() => cli(['runs', 'list'], query));
	}
	for (const filter of [
		{ project: 'prj_mixedforeign' },
		{ workflow: 'wf_mixedforeign' },
		{ runner: 'rnr_mixedforeign' }
	]) {
		await request('/usage', { ...bounds, ...filter }, localKey, 404);
		await request('/runs', { ...bounds, population: 'finalized', ...filter }, localKey, 404);
		assert.throws(() => cli(['usage'], { ...bounds, ...filter }));
	}
	const foreign = await request('/runs', { ...bounds, population: 'finalized' }, foreignKey);
	assert.deepEqual(
		foreign.items.map((r) => r.id),
		['arun_mixed_foreign']
	);
	for (const population of ['pending', 'finalized']) {
		const normal = await request('/runs', { ...bounds, population, limit: '100' });
		const asRun = await request('/runs', { ...bounds, population, limit: '100' }, runKey);
		assert.deepEqual(asRun, normal);
	}
	const runReport = await request('/usage', { ...bounds, by: 'project' }, runKey);
	assertAggregate(runReport.scope_total, selected({}));
	assert.deepEqual(
		comparable(JSON.parse(cli(['usage'], { ...bounds, by: 'project' }, true, runKey))),
		comparable(runReport)
	);
	// Mutations of CLI accounting or retained-ID forwarding must change these actual results.
	console.log(
		JSON.stringify(
			{
				...receipt,
				source_cli_invocations: cliCalls,
				manual_pending_pages: 6,
				default_limit: 50,
				account_and_run_key_isolation: true,
				source_cli: 'node --import tsx src/index.ts',
				generated_at: new Date().toISOString()
			},
			null,
			2
		)
	);
} finally {
	try {
		process.kill(-worker.pid, 'SIGTERM');
	} catch {
		worker.kill('SIGTERM');
	}
}
