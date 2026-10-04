#!/usr/bin/env node
// The e2e flake ledger (e2e/README.md, "Recording a flake"): which tests
// failed in CI lately, which of those are flakes, and which flakes no issue
// owns yet.
//
//   pnpm --filter web flake:ledger            # last 14 days
//   pnpm --filter web flake:ledger --days 30
//
// Needs an authenticated `gh`. Options:
//   --days N        window, default 14
//   --repo o/r      default: the repository `gh` resolves from the checkout
//   --workflow f    default ci.yml
//   --json          print the rows as JSON instead of the Markdown table
//
// For each attempt of each run it lists the jobs, and for every failed
// "Playwright e2e (N)" shard reads that shard's results.json artifact when
// the run kept one, else parses the list-reporter job log — so it works on
// history from before the JSON reporter existed. Exits 0 whatever it finds:
// this is a report, not a gate.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLedger, parseJsonReport, parseListLog, renderLedger } from './flake-lib.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
	const i = args.indexOf(name);
	return i === -1 ? fallback : args[i + 1];
};
const days = Number(opt('--days', '14'));
const workflow = opt('--workflow', 'ci.yml');
if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('--days must be 1-90');

const SHARD = /^Playwright e2e \((\d+)\)$/;
const CONCURRENCY = 8;

function gh(ghArgs) {
	return new Promise((resolve, reject) => {
		execFile('gh', ghArgs, { maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) =>
			err ? reject(new Error(`gh ${ghArgs.join(' ')}: ${stderr || err.message}`)) : resolve(stdout)
		);
	});
}

async function pool(items, worker) {
	const queue = [...items];
	await Promise.all(
		Array.from({ length: CONCURRENCY }, async () => {
			for (let item = queue.shift(); item !== undefined; item = queue.shift()) await worker(item);
		})
	);
}

const repo =
	opt('--repo', '') ||
	(await gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])).trim();
const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const runs = JSON.parse(
	await gh([
		'run',
		'list',
		'--repo',
		repo,
		'--workflow',
		workflow,
		'--created',
		`>=${since}`,
		'--limit',
		'1000',
		'--json',
		'databaseId,headBranch,headSha,createdAt,attempt'
	])
);

// results.json per shard, for the attempt the artifacts belong to (the
// latest: a re-run replaces them). Empty when the run predates the reporter.
async function jsonResults(runId) {
	const dir = mkdtempSync(join(tmpdir(), 'flake-ledger-'));
	try {
		await gh([
			'run',
			'download',
			String(runId),
			'--repo',
			repo,
			'--pattern',
			'playwright-results-*',
			'--dir',
			dir
		]);
		const byShard = new Map();
		for (const name of readdirSync(dir)) {
			const shard = /^playwright-results-(\d+)$/.exec(name)?.[1];
			if (shard)
				byShard.set(shard, JSON.parse(readFileSync(join(dir, name, 'results.json'), 'utf8')));
		}
		return byShard;
	} catch {
		return new Map(); // no such artifact, or it expired
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const observations = [];
const greenShas = new Set();
const unparsed = [];
const attempts = runs.flatMap((run) =>
	Array.from({ length: run.attempt }, (_, i) => ({ run, attempt: i + 1 }))
);
await pool(attempts, async ({ run, attempt }) => {
	const jobs = JSON.parse(
		await gh([
			'api',
			'--paginate',
			'--slurp',
			`repos/${repo}/actions/runs/${run.databaseId}/attempts/${attempt}/jobs`
		])
	).flatMap((page) => page.jobs);
	const shards = jobs.filter((job) => SHARD.test(job.name));
	if (shards.length > 0 && shards.every((job) => job.conclusion === 'success')) {
		greenShas.add(run.headSha);
	}
	const failed = shards.filter((job) => job.conclusion === 'failure');
	if (failed.length === 0) return;
	const reports = attempt === run.attempt ? await jsonResults(run.databaseId) : new Map();
	for (const job of failed) {
		const report = reports.get(SHARD.exec(job.name)[1]);
		const failures = report
			? parseJsonReport(report)
			: parseListLog(
					await gh(['api', `repos/${repo}/actions/jobs/${job.id}/logs`]).catch(() => '')
				);
		if (failures.length === 0) unparsed.push(`${run.databaseId}#${attempt} ${job.name}`);
		for (const failure of failures) {
			observations.push({
				...failure,
				runId: run.databaseId,
				attempt,
				sha: run.headSha,
				branch: run.headBranch,
				createdAt: run.createdAt
			});
		}
	}
});

const known = JSON.parse(
	readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../e2e/known-flakes.json'), 'utf8')
);
const rows = buildLedger(observations, greenShas, known);
if (args.includes('--json')) {
	console.log(JSON.stringify({ repo, since, rows, unparsed }, null, '\t'));
} else {
	console.log(renderLedger(rows, { days }));
	if (unparsed.length > 0) {
		console.log(
			`Red shards with no failed test in their output (setup failure, or logs expired): ${unparsed.length}`
		);
		for (const line of unparsed) console.log(`- ${line}`);
	}
}
