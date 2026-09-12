import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const persist = '.wrangler-usage-scale';
const sizeArg = process.argv.find((arg) => arg.startsWith('--size='));
const size = Number(sizeArg?.slice(7) ?? 10_000);
const allPriced = process.argv.includes('--all-priced');
const noPriced = process.argv.includes('--no-priced');
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
	WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < ${size})
	INSERT INTO agent_run (id,user_id,issue_id,runner_id,status,outcome,tier,usage,state_id_at_start,log,created_at,started_at,ended_at)
	SELECT printf('scale_%06d',n),'scale_user','scale_issue','scale_runner','completed',
		CASE n%4 WHEN 0 THEN 'advanced' WHEN 1 THEN 'stalled' ELSE NULL END,
		CASE n%3 WHEN 0 THEN 'smartest' WHEN 1 THEN 'balanced' ELSE 'cheapest' END,
		CASE WHEN ${allPriced ? '1=1' : '0=1'} THEN json_object('cost_usd', n/100000.0, 'cost_source', 'provider')
			WHEN ${noPriced ? '0=1' : '1=1'} AND n=100001 THEN '{"cost_usd":1,"cost_source":"provider"}'
			WHEN n%4=0 THEN '{"input_tokens":1}' ELSE NULL END,
		'wfs_std_open','',1700000000000-n,1700000000000-n,${toMs - 1}-CAST(n/10 AS INTEGER)
	FROM seq;
	WITH RECURSIVE pending(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM pending WHERE n < 100)
	INSERT INTO agent_run (id,user_id,issue_id,runner_id,status,tier,state_id_at_start,log,created_at)
	SELECT printf('pending_%03d',n),'scale_user','scale_issue','scale_runner','running','balanced',
		'wfs_std_open','',${toMs - 1000}-n FROM pending;
`);

const aggregateSql = (boundary) => `
	SELECT agent_run.id,agent_run.usage,agent_run.outcome,agent_run.tier,agent_run.runner_id,
		agent_run.state_id_at_start,agent_run.created_at,agent_run.ended_at,issue.project_id,
		start_state.workflow_id AS start_workflow_id,issue.workflow_id AS issue_workflow_id
	FROM agent_run
	LEFT JOIN issue ON issue.id=agent_run.issue_id
	LEFT JOIN workflow_state AS start_state ON start_state.id=agent_run.state_id_at_start
	WHERE agent_run.user_id='scale_user' AND agent_run.ended_at>=${fromMs}
		AND agent_run.ended_at<${toMs} ${boundary ? `AND (agent_run.ended_at<${boundary.at} OR (agent_run.ended_at=${boundary.at} AND agent_run.id<'${boundary.id}'))` : ''}
	ORDER BY agent_run.ended_at DESC,agent_run.id DESC LIMIT 5001`;

let aggregateQueries = 0;
let aggregateRows = 0;
let aggregateBytes = 0;
let aggregateMs = 0;
let boundary = null;
for (;;) {
	const result = execute(aggregateSql(boundary));
	aggregateQueries++;
	aggregateRows += result.rows.length;
	aggregateBytes = Math.max(aggregateBytes, result.response_bytes);
	aggregateMs += result.elapsed_ms;
	if (result.rows.length <= 5000) break;
	const last = result.rows[4999];
	boundary = { at: last.ended_at, id: last.id };
}

const candidateSql = (boundary) => `
	SELECT agent_run.id,agent_run.usage,agent_run.ended_at,agent_run.created_at
	FROM agent_run WHERE agent_run.user_id='scale_user' AND agent_run.ended_at>=${fromMs}
		AND agent_run.ended_at<${toMs} ${boundary ? `AND (agent_run.ended_at<${boundary.at} OR (agent_run.ended_at=${boundary.at} AND agent_run.id<'${boundary.id}'))` : ''}
	ORDER BY agent_run.ended_at DESC,agent_run.id DESC LIMIT 10001`;
let candidateQueries = 0;
let candidateRows = 0;
let candidateBytes = 0;
let candidateMs = 0;
let priced = null;
boundary = null;
while (candidateQueries < 20 && !priced) {
	const result = execute(candidateSql(boundary));
	candidateQueries++;
	candidateRows += Math.min(result.rows.length, 10_000);
	candidateBytes = Math.max(candidateBytes, result.response_bytes);
	candidateMs += result.elapsed_ms;
	priced = result.rows.slice(0, 10_000).find((row) => row.usage?.includes('cost_usd')) ?? null;
	if (result.rows.length <= 10_000) break;
	const last = result.rows[9999];
	boundary = { at: last.ended_at, id: last.id };
}

const pending = execute(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM agent_run
	WHERE user_id='scale_user' AND created_at<${toMs} AND (ended_at IS NULL OR ended_at>=${toMs})`);
const aggregatePlan = execute(`EXPLAIN QUERY PLAN ${aggregateSql(null)}`);
const candidatePlan = execute(`EXPLAIN QUERY PLAN ${candidateSql(null)}`);
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
	const countQueriesSince = async (start) => {
		await new Promise((resolve) => setTimeout(resolve, 50));
		const count = (workerLog.slice(start).match(/\[USAGE_SCALE_SQL\]/g) ?? []).length;
		if (count === 0)
			throw new Error('Worker SQL telemetry absent: refusing to certify query bounds');
		return count;
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
	const aggregateWorkerQueries = await countQueriesSince(aggregateTraceStart);
	// Two bearer queries, two period/settings queries, one pending count and
	// ceil(N/5000) data pages: settings are read twice, totaling four fixed queries.
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
	for (let page = 0; page < 2; page++) {
		const evidenceTraceStart = workerLog.length;
		const evidenceResponse = await fetch(`${baseUrl}/api/v1/runs?${evidenceQuery}`, {
			headers: { authorization: `Bearer ${apiKey}` }
		});
		const evidence = await evidenceResponse.json();
		const evidenceQueryCount = await countQueriesSince(evidenceTraceStart);
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
		elapsed_ms: Number((performance.now() - started).toFixed(1)),
		response_bytes: Buffer.byteLength(JSON.stringify(body)),
		finalized: body.scope_total.finalized_run_count,
		priced: body.scope_total.priced_run_count,
		pending: body.pending.scope_count,
		groups: body.groups.length,
		evidence_pages: evidencePages,
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
		source_cli_evidence_items: cliEvidenceItems,
		source_cli_evidence_resummed_cost: cliEvidenceCost,
		source_cli_text_disclosure: cliTextDisclosure
	};
} finally {
	worker.kill('SIGTERM');
}

const receipt = {
	generated_at: new Date().toISOString(),
	wrangler: wrangler(['--version']).trim(),
	dataset: {
		finalized: size,
		all_priced: allPriced,
		no_priced: noPriced,
		groups: 1,
		retained_rates: allPriced ? 0 : priced ? 1 : 0,
		equal_time_fanout: 10
	},
	aggregate: {
		queries: aggregateQueries,
		returned_rows_including_lookahead: aggregateRows,
		max_response_bytes: aggregateBytes,
		elapsed_ms: Number(aggregateMs.toFixed(1)),
		plan: aggregatePlan.rows
	},
	sparse_evidence: {
		queries: candidateQueries,
		examined_rows: candidateRows,
		found: priced?.id ?? null,
		max_response_bytes: candidateBytes,
		elapsed_ms: Number(candidateMs.toFixed(1)),
		plan: candidatePlan.rows
	},
	pending_plan: pending.rows,
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
		'Wrangler local exposes duration but not D1 rows_read; indexed plans and returned-row counts are recorded instead.',
		'Worker heap is a conservative bound, not an isolate inspector measurement; whole-process RSS is intentionally not presented as isolate heap.',
		'Run with --size=120001 to place the unique priced evidence match beyond 100k candidates.'
	]
};
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
