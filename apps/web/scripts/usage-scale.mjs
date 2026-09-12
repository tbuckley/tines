import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const persist = '.wrangler-usage-scale';
const sizeArg = process.argv.find((arg) => arg.startsWith('--size='));
const size = Number(sizeArg?.slice(7) ?? 10_000);
if (!Number.isSafeInteger(size) || size < 10_000 || size > 250_000)
	throw new Error('--size must be an integer from 10000 through 250000');

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
	WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < ${size})
	INSERT INTO agent_run (id,user_id,issue_id,runner_id,status,outcome,tier,usage,state_id_at_start,log,created_at,started_at,ended_at)
	SELECT printf('scale_%06d',n),'scale_user','scale_issue','scale_runner','completed',
		CASE n%4 WHEN 0 THEN 'advanced' WHEN 1 THEN 'stalled' ELSE NULL END,
		CASE n%3 WHEN 0 THEN 'smartest' WHEN 1 THEN 'balanced' ELSE 'cheapest' END,
		CASE WHEN n=100001 THEN '{"cost_usd":1,"cost_source":"provider"}'
			WHEN n%4=0 THEN '{"input_tokens":1}' ELSE NULL END,
		'wfs_std_open','',1700000000000-n,1700000000000-n,1800000000000-CAST(n/10 AS INTEGER)
	FROM seq;
`);

const aggregateSql = (boundary) => `
	SELECT agent_run.id,agent_run.usage,agent_run.outcome,agent_run.tier,agent_run.runner_id,
		agent_run.state_id_at_start,agent_run.created_at,agent_run.ended_at,issue.project_id,
		start_state.workflow_id AS start_workflow_id,issue.workflow_id AS issue_workflow_id
	FROM agent_run
	LEFT JOIN issue ON issue.id=agent_run.issue_id
	LEFT JOIN workflow_state AS start_state ON start_state.id=agent_run.state_id_at_start
	WHERE agent_run.user_id='scale_user' AND agent_run.ended_at>=1700000000000
		AND agent_run.ended_at<1800000000001 ${boundary ? `AND (agent_run.ended_at<${boundary.at} OR (agent_run.ended_at=${boundary.at} AND agent_run.id<'${boundary.id}'))` : ''}
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
	FROM agent_run WHERE agent_run.user_id='scale_user' AND agent_run.ended_at>=1700000000000
		AND agent_run.ended_at<1800000000001 ${boundary ? `AND (agent_run.ended_at<${boundary.at} OR (agent_run.ended_at=${boundary.at} AND agent_run.id<'${boundary.id}'))` : ''}
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
	WHERE user_id='scale_user' AND created_at<1800000000001 AND (ended_at IS NULL OR ended_at>=1800000000001)`);
const aggregatePlan = execute(`EXPLAIN QUERY PLAN ${aggregateSql(null)}`);
const candidatePlan = execute(`EXPLAIN QUERY PLAN ${candidateSql(null)}`);
const receipt = {
	generated_at: new Date().toISOString(),
	wrangler: wrangler(['--version']).trim(),
	dataset: { finalized: size, groups: 1, retained_rates: priced ? 1 : 0, equal_time_fanout: 10 },
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
		'Worker heap is a conservative bound, not an isolate inspector measurement.',
		'Run with --size=120001 to place the unique priced evidence match beyond 100k candidates.'
	]
};
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
