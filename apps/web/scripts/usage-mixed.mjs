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
	verifyMixedCohort,
	assertAggregate,
	selected
} from '../test-fixtures/usage-mixed.mjs';
const webDir = fileURLToPath(new URL('..', import.meta.url));
const cliDir = fileURLToPath(new URL('../../../packages/cli', import.meta.url));
const persist = '.wrangler-usage-mixed';
const localKey = 'tines_mixed_local_only_0000000000000000000000000000';
const runKey = `${localKey}_run`;
const foreignKey = `${localKey}_foreign`;
const tokenNames = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'];
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
	if (copy.mode === 'cohort') {
		delete copy.scope;
		delete copy.observed_through;
		if (copy.history) delete copy.history.to;
	}
	return copy;
};
const flags = (query) =>
	Object.entries(query).flatMap(([k, v]) => [
		`--${k.replaceAll('_', '-')}`,
		...(v === true ? [] : [String(v)])
	]);
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
let signedEvidenceCliChecked = false;
try {
	for (let attempt = 0; ; attempt++) {
		try {
			await fetch(baseUrl, { headers: { connection: 'close' } });
			break;
		} catch {
			if (attempt > 300 || worker.exitCode !== null) throw new Error(logs);
			await new Promise((r) => setTimeout(r, 100));
		}
	}
	const request = async (path, query, key = localKey, expected = 200) => {
		const response = await fetch(`${baseUrl}/api/v1${path}?${new URLSearchParams(query)}`, {
			// Synchronous source-CLI probes can outlive a pooled socket's idle timeout.
			headers: { authorization: `Bearer ${key}`, connection: 'close' }
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
		for (const [label, aggregate] of [
			['Scope', report.scope_total],
			['Matching', report.matching_total]
		]) {
			const portions = aggregate.portions;
			assert.ok(
				text.includes(
					`${label} sources: provider ${portions.provider.cost_usd_exact} (${portions.provider.priced_run_count}) · calculated ${portions.calculated.cost_usd_exact} (${portions.calculated.priced_run_count}) · unknown ${portions.unknown_source.cost_usd_exact} (${portions.unknown_source.priced_run_count})`
				)
			);
			const line = text.split('\n').find((line) => line.startsWith(`${label} diagnostics:`));
			for (const [diagnostic, count] of Object.entries(aggregate.diagnostics))
				if (count) assert.ok(line.includes(`${diagnostic}=${count}`));
		}

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
			if (population === 'finalized')
				for (const item of items) {
					const dimensionLine = rendered
						.split('\n')
						.find((line) => line.startsWith(`Evidence ${item.id}:`));
					assert.ok(dimensionLine, item.id);
					for (const [name, dimension] of Object.entries(item.usage_dimensions))
						assert.ok(
							dimensionLine.includes(`${name}=${dimension.name} [${dimension.id ?? 'unknown'}]`)
						);
					const a = item.usage_accounting;
					assert.ok(
						rendered.includes(
							`Accounting ${item.id}: ${a.status} · source ${a.source ?? 'unavailable'} · exact cost ${a.cost_exact ?? 'unavailable'}`
						)
					);
					const tokenLine = rendered
						.split('\n')
						.find((line) => line.startsWith(`Tokens ${item.id}:`));
					assert.ok(tokenLine, item.id);
					for (const name of tokenNames)
						assert.ok(tokenLine.includes(`${name}=${a.tokens[name] ?? 'unavailable'}`));
					assert.ok(
						tokenLine.includes(
							`invalid_tokens=${a.invalid_tokens.length ? a.invalid_tokens.join(',') : 'none'}`
						)
					);
					if (a.source === 'calculated' && !a.basis)
						assert.ok(
							rendered.includes(`Rate ${item.id}: historical calculated amount · basis unavailable`)
						);
				}

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
		if (!signedEvidenceCliChecked && populations.finalized.length) {
			const finalized = populations.finalized;
			const output = JSON.parse(
				cli(['usage'], {
					scope: report.matching_scope,
					evidence: 'runs',
					'all-pages': true,
					limit: '17'
				})
			);
			cliCalls++;
			assert.deepEqual(
				output.items.map((item) => item.id).sort(),
				finalized.map((item) => item.id).sort()
			);
			const rendered = cli(
				['usage'],
				{
					scope: report.matching_scope,
					evidence: 'runs',
					'all-pages': true,
					limit: '17'
				},
				false
			);
			cliCalls++;
			assert.ok(rendered.includes('Accounting arun_mixed_'));
			assert.ok(rendered.includes('exact cost'));
			assert.ok(rendered.includes('Evidence arun_mixed_'));
			signedEvidenceCliChecked = true;
		}
	});
	const cohort = await verifyMixedCohort(request);
	const cohortQuery = { ...bounds, cohort: true, workflow: 'wf_mixed' };
	const cohortJson = JSON.parse(cli(['usage'], cohortQuery));
	cliCalls++;
	assert.deepEqual(comparable(cohortJson), comparable(cohort.report));
	const cohortText = cli(['usage'], cohortQuery, false);
	cliCalls++;
	assert.ok(cohortText.includes('4 issues · 169/4 attempts/all issues'));
	assert.ok(cohortText.includes('Terminal states: Closed, Canceled, Dropped'));
	for (const [kind, population, expected] of [
		['issues', null, cohort.issues],
		['runs', 'finalized', cohort.finalized],
		['runs', 'pending', cohort.pending],
		['entries', null, cohort.entries]
	]) {
		const query = {
			scope: cohort.report.scope,
			evidence: kind,
			...(population ? { population } : {}),
			...(population === 'pending' ? { sort: 'time' } : {}),
			'all-pages': true,
			limit: '2'
		};
		const output = JSON.parse(cli(['usage'], query));
		cliCalls++;
		assert.deepEqual(
			output.items.map((item) => item.id ?? item.issue_id ?? item.event_id).sort(),
			expected.map((item) => item.id ?? item.issue_id ?? item.event_id).sort()
		);
		const rendered = cli(['usage'], query, false);
		cliCalls++;
		assert.ok(rendered.includes(`Usage evidence · ${kind}`));
	}
	assert.deepEqual(
		comparable(
			await request('/usage', { ...bounds, mode: 'cohort', workflow: 'wf_mixed' }, runKey)
		),
		comparable(cohort.report)
	);
	await request(
		'/usage',
		{ ...bounds, mode: 'cohort', workflow: 'wf_mixedforeign' },
		localKey,
		404
	);
	// Defaults and manual CLI cursors remain separate from --all-pages' deduplication.
	const first = JSON.parse(cli(['runs', 'list'], { ...bounds, population: 'finalized' }));
	assert.equal(first.items.length, 50);
	assert.ok(first.next_cursor);
	for (const population of ['finalized', 'pending']) {
		const manual = [];
		let cursor;
		do {
			const page = JSON.parse(
				cli(['runs', 'list'], { ...bounds, population, limit: '19', ...(cursor ? { cursor } : {}) })
			);
			manual.push(...page.items);
			cursor = page.next_cursor;
		} while (cursor);
		const expected = selected({}, population === 'pending');
		assert.deepEqual(manual.map((row) => row.id).sort(), expected.map((row) => row.id).sort());
		assert.equal(new Set(manual.map((row) => row.id)).size, expected.length);
	}
	const archivedName = JSON.parse(cli(['usage'], { ...bounds, project: 'Mixed archived' }));
	assertAggregate(archivedName.scope_total, selected({ project: 'prj_mixedb' }));
	const systemName = JSON.parse(cli(['usage'], { ...bounds, workflow: 'Standard' }));
	assertAggregate(systemName.matching_total, selected({ workflow: 'wf_standard' }));
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
				manual_finalized_pages: 8,
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
