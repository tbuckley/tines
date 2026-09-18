import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rmSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const persist = '.wrangler-usage-scale';
const sizeArg = process.argv.find((arg) => arg.startsWith('--size='));
const size = Number(sizeArg?.slice(7) ?? 10_000);
const allPriced = process.argv.includes('--all-priced');
const equalTime = process.argv.includes('--equal-time');
const noPriced = process.argv.includes('--no-priced');
const cohortNoRun = process.argv.includes('--cohort-no-run');
if (allPriced && noPriced) throw new Error('--all-priced and --no-priced are mutually exclusive');
if (!Number.isSafeInteger(size) || size < 10_000 || size > 250_000)
	throw new Error('--size must be an integer from 10000 through 250000');
const fromMs = 1_700_000_000_000;
const toMs = 1_701_000_000_001;
const apiKey = 'tines_usage_scale_local_only_000000000000000000000';
const keyHash = createHash('sha256').update(apiKey).digest('hex');

function wrangler(args) {
	return execFileSync('pnpm', ['exec', 'wrangler', ...args], {
		cwd: webDir,
		encoding: 'utf8',
		maxBuffer: 32 * 1024 * 1024,
		stdio: ['ignore', 'pipe', 'inherit']
	});
}

function execute(sql) {
	const started = performance.now();
	const raw = wrangler([
		'd1',
		'execute',
		'tines',
		'--local',
		'--persist-to',
		persist,
		'--json',
		'--command',
		sql
	]);
	const elapsed_ms = Number((performance.now() - started).toFixed(1));
	const statements = JSON.parse(raw);
	if (statements.some((statement) => !statement.success)) throw new Error(raw);
	return {
		rows: statements.flatMap((statement) => statement.results ?? []),
		meta: statements.map((statement) => statement.meta ?? {}),
		elapsed_ms,
		response_bytes: Buffer.byteLength(raw)
	};
}

rmSync(new URL(`../${persist}`, import.meta.url), { recursive: true, force: true });
wrangler(['d1', 'migrations', 'apply', 'tines', '--local', '--persist-to', persist]);
execute(`
	INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt)
	VALUES ('scale_user','Scale','scale@example.test',1,1700000000000,1700000000000);
	INSERT INTO project (id,user_id,name,description,created_at,updated_at)
	VALUES ('scale_project','scale_user','Scale','','1700000000000','1700000000000');
	INSERT INTO issue (id,project_id,number,title,description,workflow_id,state_id,created_at,updated_at)
	VALUES ('scale_issue','scale_project',1,'Scale','','wf_standard','wfs_std_open',1700000000000,1700000000000);
	INSERT INTO runner (id,user_id,type,name,status,max_concurrent,max_run_minutes,default_tier,config,created_at,updated_at)
	VALUES ('scale_runner','scale_user','local','Scale','paused',1,30,'balanced','{}',1700000000000,1700000000000);
	INSERT INTO api_key (id,user_id,name,key_hash,key_prefix,created_at)
	VALUES ('scale_key','scale_user','scale-local','${keyHash}','tines_usage_',1700000000000);
	INSERT INTO event (id,user_id,type,actor_user_id,issue_id,project_id,payload,created_at)
	VALUES ('scale_completion','scale_user','issue.transitioned','scale_user','scale_issue','scale_project',
		'{"state_entry_version":1,"workflow_id":"wf_standard","workflow_name":"Standard","to_state_id":"wfs_std_closed","to_state_name":"Closed","to_state_category":"done"}',${fromMs + 1});
	WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < ${size})
	INSERT INTO agent_run (id,user_id,issue_id,runner_id,status,outcome,tier,usage,state_id_at_start,log,created_at,started_at,ended_at)
	SELECT printf('scale_%06d',n),'scale_user','scale_issue','scale_runner','completed',
		CASE n%4 WHEN 0 THEN 'advanced' WHEN 1 THEN 'stalled' ELSE NULL END,
		CASE n%3 WHEN 0 THEN 'smartest' WHEN 1 THEN 'balanced' ELSE 'cheapest' END,
		CASE WHEN ${allPriced ? '1=1' : '0=1'} THEN json_object('cost_usd', n/100000.0, 'cost_source', 'provider')
			WHEN ${noPriced ? '0=1' : '1=1'} AND n=100001 THEN '{"cost_usd":1,"cost_source":"provider"}'
			WHEN n%4=0 THEN '{"input_tokens":1}' ELSE NULL END,
		'wfs_std_open','',1700000000000-n,1700000000000-n,${toMs - 1}-${equalTime ? 0 : 'CAST(n/10 AS INTEGER)'}
	FROM seq;
	WITH RECURSIVE pending(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM pending WHERE n < 100)
	INSERT INTO agent_run (id,user_id,issue_id,runner_id,status,tier,state_id_at_start,log,created_at)
	SELECT printf('pending_%03d',n),'scale_user','scale_issue','scale_runner','running','balanced',
		'wfs_std_open','',${toMs - 1000}-n FROM pending;
	${
		cohortNoRun
			? `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < ${size})
	INSERT INTO issue (id,project_id,number,title,description,workflow_id,state_id,created_at,updated_at)
	SELECT printf('cohort_%06d',n),'scale_project',100+n,printf('No-run %d',n),'','wf_standard','wfs_std_closed',${fromMs},${fromMs} FROM seq;
	WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < ${size})
	INSERT INTO event (id,user_id,type,actor_user_id,issue_id,project_id,payload,created_at)
	SELECT printf('cohort_evt_%06d',n),'scale_user','issue.transitioned','scale_user',printf('cohort_%06d',n),'scale_project',
		'{"state_entry_version":1,"workflow_id":"wf_standard","workflow_name":"Standard","to_state_id":"wfs_std_closed","to_state_name":"Closed","to_state_category":"done"}',${fromMs + 2} FROM seq;`
			: ''
	}
`);

function waitForWorker(url, child) {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + 30_000;
		const poll = async () => {
			if (child.exitCode !== null) return reject(new Error(`worker exited ${child.exitCode}`));
			try {
				await fetch(url);
				return resolve();
			} catch (error) {
				if (Date.now() >= deadline) return reject(error);
				setTimeout(poll, 100);
			}
		};
		poll();
	});
}

if (!process.argv.includes('--skip-build'))
	execFileSync('pnpm', ['build'], { cwd: webDir, stdio: 'inherit' });
execFileSync('pnpm', ['--dir', '../..', '--filter', 'tines', 'build'], {
	cwd: webDir,
	stdio: 'inherit'
});
const port = 18_000 + (process.pid % 1_000);
const baseUrl = `http://127.0.0.1:${port}`;
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
		'BETTER_AUTH_SECRET:usage-scale-local-secret-00000000000000000000',
		'--var',
		`BETTER_AUTH_URL:${baseUrl}`,
		'--var',
		'SECRET_ENCRYPTION_KEY:usage-scale-local-only',
		'--var',
		'USAGE_SCALE_SQL_TRACE:1'
	],
	{ cwd: webDir, stdio: ['ignore', 'pipe', 'pipe'] }
);
let workerLog = '';
worker.stdout.on('data', (chunk) => (workerLog += chunk));
worker.stderr.on('data', (chunk) => (workerLog += chunk));
let workerEvidence;
try {
	await waitForWorker(baseUrl, worker);
	const tracesSince = async (start) => {
		await new Promise((resolve) => setTimeout(resolve, 100));
		const traces = [...workerLog.slice(start).matchAll(/\[USAGE_SCALE_SQL\](\{[^\n]+\})/g)].map(
			(match) => JSON.parse(match[1])
		);
		if (!traces.length)
			throw new Error('Worker SQL telemetry absent: refusing to certify query bounds');
		if (traces.some((trace) => !Number.isSafeInteger(trace.rows_read) || trace.rows_read < 0))
			throw new Error('Worker rows_read telemetry absent or invalid');
		return traces;
	};
	const orderedIds = Array.from({ length: size }, (_, i) => i + 1)
		.sort((a, b) => (equalTime ? b - a : Math.floor(a / 10) - Math.floor(b / 10) || b - a))
		.map((n) => `scale_${String(n).padStart(6, '0')}`);
	const verifyPageIds = (pages, pageSize, offset = 0) => {
		for (const page of pages) {
			const ids = orderedIds.slice(offset, offset + pageSize + 1);
			const expected = createHash('sha256').update(JSON.stringify(ids)).digest('hex');
			if (page.ids_sha256 !== expected || page.returned_rows !== ids.length)
				throw new Error('Worker page IDs differ from independent ordered fixture');
			offset += pageSize;
		}
	};
	const pageTraces = (traces) =>
		traces.filter(
			(trace) => trace.sql?.includes('order by "agent_run".') && trace.sql.includes('limit ?')
		);
	const scanReceipt = (pages, multiplier, pageSize) => {
		if (!pages.length) throw new Error('Worker scan telemetry absent');
		for (const page of pages) {
			// The fixture has fixed, owned metadata. Seven indexed rows per
			// aggregate fact (fact + six joins); candidates prune all unused joins.
			if (
				page.rows_read > multiplier * (page.returned_rows + 2) ||
				page.rows_read < page.returned_rows
			)
				throw new Error(
					`Worker rows_read bound exceeded: ${page.rows_read} for ${page.returned_rows} returned rows`
				);
		}
		const total = pages.reduce((sum, page) => sum + page.rows_read, 0);
		if (total > multiplier * (pages.length * (pageSize + 3)))
			throw new Error('Worker total rows_read bound exceeded');
		return {
			total_rows_read: total,
			first_page_rows_read: pages[0].rows_read,
			last_page_rows_read: pages.at(-1).rows_read,
			max_response_bytes: Math.max(...pages.map((page) => page.response_bytes)),
			pages
		};
	};
	const query = new URLSearchParams({
		from: new Date(fromMs).toISOString(),
		to: new Date(toMs).toISOString(),
		by: 'tier'
	});
	const started = performance.now();
	const aggregateTraceStart = workerLog.length;
	const response = await fetch(`${baseUrl}/api/v1/usage?${query}`, {
		headers: { authorization: `Bearer ${apiKey}` }
	});
	const body = await response.json();
	const aggregateTraces = await tracesSince(aggregateTraceStart);
	const aggregateWorkerQueries = aggregateTraces.length;
	if (
		aggregateTraces.reduce((sum, t) => sum + t.rows_read, 0) >
		8 * (size + Math.ceil(size / 5000)) + 1000
	)
		throw new Error('Worker complete aggregate request rows_read bound exceeded');
	const aggregateScan = scanReceipt(pageTraces(aggregateTraces), 7, 5000);
	verifyPageIds(aggregateScan.pages, 5000);
	const aggregateElapsed = Number((performance.now() - started).toFixed(1));
	// Two bearer queries, one settings read, one pending count, and
	// ceil(N/5000) data pages: four fixed queries on this unfiltered dataset.
	const expectedAggregateQueries = Math.ceil(size / 5000) + 4;
	if (aggregateWorkerQueries !== expectedAggregateQueries)
		throw new Error(
			`worker aggregate telemetry mismatch: ${aggregateWorkerQueries} != ${expectedAggregateQueries}`
		);
	if (aggregateWorkerQueries > 49)
		throw new Error(`worker aggregate query bound exceeded: ${aggregateWorkerQueries} > 49`);
	if (!response.ok) throw new Error(JSON.stringify(body));
	if (body.scope_total.finalized_run_count !== size)
		throw new Error(
			`worker finalized mismatch: ${body.scope_total.finalized_run_count} != ${size}`
		);
	if (body.pending.scope_count !== 100)
		throw new Error(`worker pending mismatch: ${body.pending.scope_count} != 100`);
	const expectedPriced = allPriced ? size : !noPriced && size >= 100_001 ? 1 : 0;
	const expectedUnpriced = allPriced ? 0 : Math.floor(size / 4);
	const expectedUnreported = size - expectedPriced - expectedUnpriced;
	const expectedCost = allPriced ? (size * (size + 1)) / 200_000 : expectedPriced ? 1 : null;
	const expectedMedian = allPriced
		? size % 2
			? (size + 1) / 2 / 100_000
			: (size / 2 + (size / 2 + 1)) / 2 / 100_000
		: expectedPriced
			? 1
			: null;
	const expectedP95 = allPriced ? Math.ceil(size * 0.95) / 100_000 : expectedPriced ? 1 : null;
	const expectedMax = allPriced ? size / 100_000 : expectedPriced ? 1 : null;
	const oracle = {
		finalized_run_count: size,
		priced_run_count: expectedPriced,
		unpriced_run_count: expectedUnpriced,
		unreported_run_count: expectedUnreported,
		cost_usd: expectedCost
	};
	for (const [field, expected] of Object.entries(oracle))
		if (body.scope_total[field] !== expected)
			throw new Error(`worker ${field} mismatch: ${body.scope_total[field]} != ${expected}`);
	for (const [field, expected] of Object.entries({
		median_cost_usd: expectedMedian,
		p95_cost_usd: expectedP95,
		max_cost_usd: expectedMax
	}))
		if (body.scope_total.distribution[field] !== expected)
			throw new Error(
				`worker distribution ${field} mismatch: ${body.scope_total.distribution[field]} != ${expected}`
			);
	const groupedCounts = body.groups.reduce(
		(total, group) => total + group.aggregate.finalized_run_count,
		0
	);
	const groupedCost = body.groups.reduce(
		(total, group) => total + (group.aggregate.cost_usd ?? 0),
		0
	);
	if (groupedCounts !== size || Math.abs(groupedCost - (expectedCost ?? 0)) > 1e-9)
		throw new Error('worker tier groups do not independently reconcile to the known dataset');
	const evidenceQuery = new URLSearchParams({
		population: 'finalized',
		from: new Date(fromMs).toISOString(),
		to: new Date(toMs).toISOString(),
		accounting_status: 'priced',
		limit: '50'
	});
	const evidencePages = [];
	const evidenceWorkerQueries = [];
	const evidenceTraces = [];
	const evidenceElapsed = [];
	for (let page = 0; page < 2; page++) {
		const evidenceTraceStart = workerLog.length;
		const evidenceStarted = performance.now();
		const evidenceResponse = await fetch(`${baseUrl}/api/v1/runs?${evidenceQuery}`, {
			headers: { authorization: `Bearer ${apiKey}` }
		});
		const evidence = await evidenceResponse.json();
		const traces = await tracesSince(evidenceTraceStart);
		evidenceTraces.push(traces);
		if (
			traces.reduce((sum, t) => sum + t.rows_read, 0) >
			size + pageTraces(traces).reduce((sum, t) => sum + t.rows_read, 0) + 1000
		)
			throw new Error('Worker complete evidence request rows_read bound exceeded');
		evidenceElapsed.push(Number((performance.now() - evidenceStarted).toFixed(1)));
		const evidenceQueryCount = traces.length;
		scanReceipt(pageTraces(traces), 1, 10000);
		if (evidenceQueryCount < 3 || evidenceQueryCount > 30)
			throw new Error(`worker evidence query bound exceeded: ${evidenceQueryCount} outside 3..30`);
		evidenceWorkerQueries.push(evidenceQueryCount);
		if (!evidenceResponse.ok) throw new Error(JSON.stringify(evidence));
		evidencePages.push({
			items: evidence.items.map((item) => item.id),
			scan_complete: evidence.usage_window.scan_complete,
			has_cursor: Boolean(evidence.next_cursor)
		});
		if (!evidence.next_cursor) break;
		evidenceQuery.set('cursor', evidence.next_cursor);
	}
	const allEvidencePages = evidenceTraces.flatMap(pageTraces);
	if (!allPriced) {
		if (allEvidencePages.length !== Math.ceil(size / 10000) || evidencePages.at(-1).has_cursor)
			throw new Error('Sparse walk did not exhaust its exact candidate population');
		verifyPageIds(allEvidencePages, 10000);
	} else {
		evidenceTraces.forEach((traces, page) => verifyPageIds(pageTraces(traces), 10000, page * 50));
	}

	// Signed cost-ranked evidence is a separate complete-scan path. Exercise the
	// first and middle pages against the real Worker, including parent replay.
	const signedPages = [];
	const signedEvidenceTraces = [];
	const signedQuery = new URLSearchParams({
		scope: body.matching_scope,
		kind: 'runs',
		limit: '50'
	});
	for (let page = 0; page < 2; page++) {
		const traceStart = workerLog.length;
		const response = await fetch(`${baseUrl}/api/v1/usage/evidence?${signedQuery}`, {
			headers: { authorization: `Bearer ${apiKey}` }
		});
		const result = await response.json();
		if (!response.ok) throw new Error(JSON.stringify(result));
		const traces = await tracesSince(traceStart);
		if (traces.length > 49)
			throw new Error(`signed evidence query bound exceeded: ${traces.length} > 49`);
		const rowsRead = traces.reduce((sum, trace) => sum + trace.rows_read, 0);
		// The ranked scan and the route's parent reconciliation each walk the
		// candidate population in 5k pages, including dimension joins. Keep the
		// measured multiplier bounded and independent of issue cardinality.
		if (rowsRead > size * 30 + 10_000)
			throw new Error(`signed evidence rows_read bound exceeded: ${rowsRead}`);
		if (result.total_count !== size || result.attempt_count !== size)
			throw new Error('signed evidence whole-population counts mismatch');
		signedPages.push(result.items.map((item) => item.id));
		signedEvidenceTraces.push(traces);
		if (!result.next_cursor) break;
		signedQuery.set('cursor', result.next_cursor);
	}
	if (new Set(signedPages.flat()).size !== signedPages.flat().length)
		throw new Error('signed evidence pages repeated a run');

	const lifetimeTraceStart = workerLog.length;
	const lifetimeResponse = await fetch(`${baseUrl}/api/v1/usage?mode=issue&issue=scale_issue`, {
		headers: { authorization: `Bearer ${apiKey}` }
	});
	const lifetime = await lifetimeResponse.json();
	if (!lifetimeResponse.ok) throw new Error(JSON.stringify(lifetime));
	const lifetimeTraces = await tracesSince(lifetimeTraceStart);
	if (lifetimeTraces.length > 49)
		throw new Error(`lifetime query bound exceeded: ${lifetimeTraces.length} > 49`);
	if (lifetime.issue.attempt_count !== size + 100 || lifetime.issue.pending_count !== 100)
		throw new Error('direct lifetime attempt population mismatch');
	if (lifetime.issue.aggregate.finalized_run_count !== size)
		throw new Error('direct lifetime finalized population mismatch');
	const cohortTraceStart = workerLog.length;
	const cohortResponse = await fetch(
		`${baseUrl}/api/v1/usage?mode=cohort&workflow=wf_standard&from=${encodeURIComponent(new Date(fromMs).toISOString())}&to=${encodeURIComponent(new Date(toMs).toISOString())}`,
		{ headers: { authorization: `Bearer ${apiKey}` } }
	);
	const cohort = await cohortResponse.json();
	if (!cohortResponse.ok) throw new Error(JSON.stringify(cohort));
	const cohortTraces = await tracesSince(cohortTraceStart);
	if (cohortTraces.length > 49)
		throw new Error(`cohort query bound exceeded: ${cohortTraces.length} > 49`);
	if (
		cohort.counters.distinct_issue_count !== 1 + (cohortNoRun ? size : 0) ||
		cohort.counters.attempt_count !== size + 100 ||
		cohort.counters.pending_count !== 100 ||
		cohort.counters.zero_run_issue_count !== (cohortNoRun ? size : 0) ||
		cohort.aggregate.finalized_run_count !== size
	)
		throw new Error('completion cohort huge-member population mismatch');
	const cohortRowsRead = cohortTraces.reduce((sum, trace) => sum + trace.rows_read, 0);
	// This combined fixture contains both H attempts on one issue and K no-run
	// members. The bound is linear in H+K and includes every metadata/history
	// statement emitted by the authenticated application request.
	if (cohortRowsRead > size * (cohortNoRun ? 240 : 35) + 20_000)
		throw new Error(
			`cohort rows_read bound exceeded: ${cohortRowsRead} (${cohortTraces.map((trace) => trace.rows_read).join(',')})`
		);
	const cohortEvidenceResponse = await fetch(
		`${baseUrl}/api/v1/usage/evidence?scope=${encodeURIComponent(cohort.scope)}&kind=issues&member=scale_issue&limit=10`,
		{ headers: { authorization: `Bearer ${apiKey}` } }
	);
	const cohortEvidence = await cohortEvidenceResponse.json();
	if (!cohortEvidenceResponse.ok) throw new Error(JSON.stringify(cohortEvidence));
	if (
		cohortEvidence.total_count !== 1 ||
		cohortEvidence.items[0]?.attempt_count !== size + 100 ||
		cohortEvidence.items[0]?.pending_count !== 100
	)
		throw new Error('completion cohort issue evidence mismatch');
	if (cohortNoRun) {
		for (const [kind, direction, expected] of [
			['issues', 'asc', 'scale_issue'],
			['issues', 'desc', 'cohort_000001'],
			['entries', 'asc', 'scale_completion'],
			['entries', 'desc', 'cohort_evt_000001']
		]) {
			const response = await fetch(
				`${baseUrl}/api/v1/usage/evidence?scope=${encodeURIComponent(cohort.scope)}&kind=${kind}&sort=time&direction=${direction}&limit=1`,
				{ headers: { authorization: `Bearer ${apiKey}` } }
			);
			const page = await response.json();
			if (!response.ok || (page.items[0]?.event_id ?? page.items[0]?.issue_id) !== expected)
				throw new Error(`completion cohort ${kind} ${direction} boundary mismatch`);
		}
	}
	const cliRaw = execFileSync(
		'node',
		[
			fileURLToPath(new URL('../../../packages/cli/dist/index.js', import.meta.url)),
			'usage',
			'--url',
			baseUrl,
			'--api-key',
			apiKey,
			'--from',
			new Date(fromMs).toISOString(),
			'--to',
			new Date(toMs).toISOString(),
			'--by',
			'tier',
			'--json'
		],
		{ encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
	);
	const cli = JSON.parse(cliRaw);
	const comparable = (value) => {
		const copy = structuredClone(value);
		delete copy.generated_at;
		return copy;
	};
	if (JSON.stringify(comparable(cli)) !== JSON.stringify(comparable(body)))
		throw new Error('source CLI and HTTP accounting differ');
	const cohortCli = JSON.parse(
		execFileSync(
			'node',
			[
				fileURLToPath(new URL('../../../packages/cli/dist/index.js', import.meta.url)),
				'usage',
				'--url',
				baseUrl,
				'--api-key',
				apiKey,
				'--cohort',
				'--workflow',
				'wf_standard',
				'--from',
				new Date(fromMs).toISOString(),
				'--to',
				new Date(toMs).toISOString(),
				'--json'
			],
			{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
		)
	);
	if (
		cohortCli.mode !== 'cohort' ||
		JSON.stringify(cohortCli.counters) !== JSON.stringify(cohort.counters) ||
		JSON.stringify(cohortCli.aggregate) !== JSON.stringify(cohort.aggregate)
	)
		throw new Error('source CLI completion cohort differs from HTTP');
	const signedCliArgs = [
		fileURLToPath(new URL('../../../packages/cli/dist/index.js', import.meta.url)),
		'usage',
		'--url',
		baseUrl,
		'--api-key',
		apiKey,
		'--scope',
		body.matching_scope,
		'--evidence',
		'runs',
		'--limit',
		'50'
	];
	const signedCli = JSON.parse(
		execFileSync('node', [...signedCliArgs, '--json'], {
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024
		})
	);
	if (signedCli.total_count !== size || signedCli.items.length !== 50)
		throw new Error('source CLI signed evidence page mismatch');
	const signedCliText = execFileSync('node', signedCliArgs, {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024
	});
	if (!signedCliText.includes('Accounting scale_') || !signedCliText.includes('exact cost'))
		throw new Error('source CLI signed evidence omitted accounting disclosure');
	const runsArgs = [
		fileURLToPath(new URL('../../../packages/cli/dist/index.js', import.meta.url)),
		'runs',
		'list',
		'--url',
		baseUrl,
		'--api-key',
		apiKey,
		'--population',
		'finalized',
		'--from',
		new Date(fromMs).toISOString(),
		'--to',
		new Date(toMs).toISOString(),
		'--accounting-status',
		'priced',
		'--all-pages'
	];
	let cliEvidenceItems = null;
	let cliEvidenceCost = null;
	let cliTextDisclosure = null;
	// The sparse datasets are the complete spawned-CLI evidence gate. Avoid asking a
	// single Worker invocation to enumerate the deliberately all-priced 100k load case.
	if (expectedPriced <= 100) {
		const cliEvidence = JSON.parse(
			execFileSync('node', [...runsArgs, '--json'], {
				encoding: 'utf8',
				maxBuffer: 64 * 1024 * 1024
			})
		);
		if (cliEvidence.items.length !== expectedPriced || cliEvidence.next_cursor !== null)
			throw new Error('source CLI complete priced evidence does not match the independent oracle');
		cliEvidenceItems = cliEvidence.items.length;
		cliEvidenceCost = cliEvidence.items.reduce(
			(total, item) => total + (item.usage_accounting.cost ?? 0),
			0
		);
		if (Math.abs(cliEvidenceCost - (expectedCost ?? 0)) > 1e-9)
			throw new Error('source CLI evidence does not independently re-sum to the aggregate');
		const cliEvidenceText = execFileSync('node', runsArgs, {
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024
		});
		cliTextDisclosure =
			!expectedPriced ||
			(cliEvidenceText.includes('Accounting') && cliEvidenceText.includes('source provider'));
		if (!cliTextDisclosure)
			throw new Error('source CLI text omitted accounting or rate disclosure');
	}
	workerEvidence = {
		status: response.status,
		elapsed_ms: aggregateElapsed,
		evidence_elapsed_ms: evidenceElapsed,
		native_scan: {
			aggregate: aggregateScan,
			evidence: scanReceipt(evidenceTraces.flatMap(pageTraces), 1, 10000)
		},
		total_request_rows_read: {
			aggregate: aggregateTraces.reduce((sum, t) => sum + t.rows_read, 0),
			evidence: evidenceTraces.map((ts) => ts.reduce((sum, t) => sum + t.rows_read, 0))
		},
		response_bytes: Buffer.byteLength(JSON.stringify(body)),
		finalized: body.scope_total.finalized_run_count,
		priced: body.scope_total.priced_run_count,
		pending: body.pending.scope_count,
		groups: body.groups.length,
		evidence_pages: evidencePages,
		signed_evidence_pages: signedPages,
		signed_evidence_queries: signedEvidenceTraces.map((traces) => traces.length),
		signed_evidence_rows_read: signedEvidenceTraces.map((traces) =>
			traces.reduce((sum, trace) => sum + trace.rows_read, 0)
		),
		direct_lifetime: {
			attempts: lifetime.issue.attempt_count,
			pending: lifetime.issue.pending_count,
			finalized: lifetime.issue.aggregate.finalized_run_count,
			queries: lifetimeTraces.length,
			rows_read: lifetimeTraces.reduce((sum, trace) => sum + trace.rows_read, 0)
		},
		completion_cohort: {
			issues: cohort.counters.distinct_issue_count,
			attempts: cohort.counters.attempt_count,
			pending: cohort.counters.pending_count,
			queries: cohortTraces.length,
			rows_read: cohortRowsRead,
			zero_run_issues: cohort.counters.zero_run_issue_count,
			no_run_scale_enabled: cohortNoRun,
			issue_evidence_reconciled: true
		},
		independent_oracle: oracle,
		distribution_oracle: {
			median_cost_usd: expectedMedian,
			p95_cost_usd: expectedP95,
			max_cost_usd: expectedMax
		},
		groups_reconciled: true,
		measured_worker_queries: {
			aggregate: aggregateWorkerQueries,
			evidence_pages: evidenceWorkerQueries
		},
		source_cli_exact_match: true,
		source_cli_cohort_exact_match: true,
		source_cli_evidence_items: cliEvidenceItems,
		source_cli_evidence_resummed_cost: cliEvidenceCost,
		source_cli_text_disclosure: cliTextDisclosure
	};
} finally {
	worker.kill('SIGTERM');
}

// Probe the exact compiled statements with positional bindings, after the
// measured requests. EXPLAIN statements are never charged to service telemetry.
const planConfig = new URL(`../${persist}/plan.json`, import.meta.url);
writeFileSync(
	planConfig,
	JSON.stringify({
		name: 'usage-scale-plan',
		main: fileURLToPath(new URL('./usage-scale-plan-worker.mjs', import.meta.url)),
		compatibility_date: '2025-08-01',
		d1_databases: [
			{
				binding: 'DB',
				database_name: 'tines',
				database_id: readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8').match(
					/"database_id":\s*"([^"]+)"/
				)[1]
			}
		]
	})
);
const planUrl = `http://127.0.0.1:${port + 1000}`;
const planWorker = spawn(
	'pnpm',
	[
		'exec',
		'wrangler',
		'dev',
		'--config',
		fileURLToPath(planConfig),
		'--ip',
		'127.0.0.1',
		'--port',
		String(port + 1000),
		'--persist-to',
		fileURLToPath(new URL(`../${persist}`, import.meta.url))
	],
	{ cwd: webDir, stdio: ['ignore', 'pipe', 'pipe'] }
);
planWorker.stdout.resume();
planWorker.stderr.resume();
try {
	await waitForWorker(planUrl, planWorker);
	for (const scan of Object.values(workerEvidence.native_scan)) {
		scan.bound_query_plans = [];
		for (const page of [scan.pages[0], scan.pages.at(-1)]) {
			const response = await fetch(planUrl, { method: 'POST', body: JSON.stringify(page) });
			const plan = await response.json();
			if (
				!response.ok ||
				!plan.success ||
				!plan.results.some((row) => row.detail.includes('agent_run_user_ended_idx'))
			)
				throw new Error('Compiled bound query lost its ledger index: ' + JSON.stringify(plan));
			scan.bound_query_plans.push(plan.results);
		}
	}
} finally {
	planWorker.kill('SIGTERM');
}

const receipt = {
	generated_at: new Date().toISOString(),
	wrangler: wrangler(['--version']).trim(),
	dataset: {
		finalized: size,
		all_priced: allPriced,
		no_priced: noPriced,
		groups: 3,
		pending: 100,
		retained_rates: 0,
		equal_time_fanout: equalTime ? size : 10
	},
	authenticated_worker: workerEvidence,
	bounds: {
		service_queries_at_100k: 27,
		invocation_queries_with_bearer_auth_at_100k: 29,
		sparse_invocation_queries_max: 30,
		free_query_limit: 50,
		worker_isolate_limit_mb: 128,
		priced_sample_capacity_mb_at_100k: 3.2,
		all_growth_allocations_mb_at_100k: 6.4
	},
	limitations: [
		'Wrangler CLI elapsed time includes process startup; D1 meta is emitted by the local emulator.',
		'Native rows_read includes joined metadata reads; telemetry uses actual parameterized shipping statements, not literal replays.',
		'Worker heap is a conservative bound, not an isolate inspector measurement; whole-process RSS is intentionally not presented as isolate heap.',
		'Run with --size=120001 to place the unique priced evidence match beyond 100k candidates.'
	]
};
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
