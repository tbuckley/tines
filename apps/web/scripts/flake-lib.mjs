// Pure helpers shared by flake-ledger.mjs (history, via `gh`) and
// flake-summary.mjs (one CI run's step summary). No I/O here, so
// src/lib/flake-lib.test.ts can drive every branch. See e2e/README.md,
// "Recording a flake".
import { dirname, join, relative } from 'node:path';

/** How many branches a failure must span before it counts as a flake by spread alone. */
export const BRANCH_THRESHOLD = 3;

// `gh run view --log` prefixes each line with "<job>\t<step>\t<timestamp> ";
// the raw job log has only the timestamp. Either way the timestamp ends it.
const LOG_PREFIX = /^.*?\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
const ANSI = /\u001b\[[0-9;]*m/g;
// "  1) e2e/x.spec.ts:853:2 › suite › title ───" — the failure block header.
const BLOCK = /^\s*\d+\) (\S+\.spec\.ts):(\d+):\d+ › (.+?)[\s─]*$/;
// "  ✘  12 e2e/x.spec.ts:853:2 › suite › title (5.2s)" — the per-test line.
const CROSS = /^\s*✘\s+\d+ (\S+\.spec\.ts):(\d+):\d+ › (.+?)(?: \([\d.]+(?:ms|s|m|h)\))?\s*$/;

/** `file:line › title`, the identity `known-flakes.json` is keyed on. */
export function flakeKey({ file, line, title }) {
	return `${file}:${line} › ${title}`;
}

// A spec edit above the test moves its line, so identity for matching is the
// file and title; the line in a key is for the human reading it.
function looseKey(key) {
	return key.replace(/^(\S+?):\d+ › /, '$1 › ');
}

/**
 * Failed tests in list-reporter output. Reads the numbered failure blocks
 * (which carry the error line) and falls back to the `✘` lines, so a log cut
 * off before the summary still yields its failures.
 */
export function parseListLog(text) {
	const lines = text.split('\n').map((l) => l.replace(LOG_PREFIX, '').replace(ANSI, ''));
	const found = new Map();
	for (let i = 0; i < lines.length; i++) {
		const block = BLOCK.exec(lines[i]);
		const hit = block ?? CROSS.exec(lines[i]);
		if (!hit) continue;
		const failure = { file: hit[1], line: Number(hit[2]), title: hit[3].trim(), error: '' };
		if (block) {
			// The error is the first non-blank line under the header, unless the
			// next header arrives first (a retry header, another failure).
			for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
				const next = lines[j].trim();
				if (!next) continue;
				if (!BLOCK.test(lines[j])) failure.error = next;
				break;
			}
		}
		const key = flakeKey(failure);
		if (!found.get(key)?.error) found.set(key, failure);
	}
	return [...found.values()];
}

/**
 * Failed and flaky tests in a Playwright JSON report (`results.json`).
 * `status` is Playwright's own outcome: `unexpected` (failed) or `flaky`
 * (failed, then passed on retry — only if retries are ever turned on).
 */
export function parseJsonReport(report) {
	const { rootDir, configFile } = report.config ?? {};
	// Spec files are relative to testDir; the list reporter, and so every key,
	// is relative to the config file.
	const prefix = rootDir && configFile ? relative(dirname(configFile), rootDir) : 'e2e';
	const failures = [];
	const walk = (suite, titles) => {
		for (const spec of suite.specs ?? []) {
			for (const test of spec.tests ?? []) {
				if (test.status !== 'unexpected' && test.status !== 'flaky') continue;
				const failed = (test.results ?? []).find((r) => r.error ?? r.errors?.length);
				const message = failed?.error?.message ?? failed?.errors?.[0]?.message ?? '';
				failures.push({
					file: join(prefix, spec.file),
					line: spec.line,
					title: [...titles, spec.title].join(' › '),
					error: message.replace(ANSI, '').split('\n')[0].trim(),
					status: test.status
				});
			}
		}
		for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
	};
	// A top-level suite is the file; its title is the file name, not a describe.
	for (const fileSuite of report.suites ?? []) walk(fileSuite, []);
	return failures;
}

/** The owning issue ref for a failure, or null when nothing owns it. */
export function knownIssue(known, failure) {
	const wanted = looseKey(flakeKey(failure));
	for (const [key, ref] of Object.entries(known)) {
		if (looseKey(key) === wanted) return ref;
	}
	return null;
}

/**
 * Group failure observations by test.
 *
 * `observations` are failures tagged with the run they came from
 * (`runId`, `attempt`, `sha`, `branch`, `createdAt`). `greenShas` holds every
 * SHA with at least one attempt whose e2e shards all passed. A test is flaky
 * when it failed on a SHA that also went green, failed on main, or failed on
 * BRANCH_THRESHOLD or more branches.
 */
export function buildLedger(observations, greenShas, known = {}, mainBranch = 'main') {
	const byTest = new Map();
	for (const o of observations) {
		const id = looseKey(flakeKey(o));
		const row = byTest.get(id) ?? { ...o, observations: [] };
		// Report the newest line number and error: that is what the spec says now.
		if (o.createdAt >= row.createdAt)
			Object.assign(row, { line: o.line, error: o.error || row.error });
		row.observations.push(o);
		byTest.set(id, row);
	}
	const rows = [...byTest.values()].map((row) => {
		const obs = row.observations;
		const runs = [...new Set(obs.map((o) => `${o.runId}#${o.attempt}`))];
		const branches = [...new Set(obs.map((o) => o.branch))];
		const reasons = [];
		if (obs.some((o) => greenShas.has(o.sha))) reasons.push('same-sha');
		if (branches.includes(mainBranch)) reasons.push('main');
		if (branches.length >= BRANCH_THRESHOLD) reasons.push('branches');
		return {
			key: flakeKey(row),
			file: row.file,
			line: row.line,
			title: row.title,
			error: row.error,
			redRuns: runs.length,
			runs,
			branches,
			lastSeen: obs
				.map((o) => o.createdAt)
				.sort()
				.at(-1),
			reasons,
			flaky: reasons.length > 0,
			issue: knownIssue(known, row)
		};
	});
	rows.sort((a, b) => b.redRuns - a.redRuns || a.key.localeCompare(b.key));
	return rows;
}

const cell = (text) => String(text).replaceAll('|', '\\|');
const short = (text, max = 160) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The ledger as a Markdown table, then the flaky tests nothing owns yet. */
export function renderLedger(rows, { days }) {
	if (rows.length === 0) return `No failed e2e tests in the last ${days} days.\n`;
	const out = [
		`## E2E flake ledger, last ${days} days`,
		'',
		'| Test | Red runs | Branches | Why flaky | Last seen | Owner |',
		'| --- | ---: | ---: | --- | --- | --- |'
	];
	for (const r of rows) {
		const why = r.reasons.join(', ') || 'not proven';
		const owner = r.issue ?? (r.flaky ? '**none**' : '');
		out.push(
			`| \`${cell(r.key)}\` | ${r.redRuns} | ${r.branches.length} | ${why} | ${r.lastSeen.slice(0, 10)} | ${owner} |`
		);
	}
	out.push(
		'',
		`Why flaky: \`same-sha\` failed on a SHA that also passed, \`main\` failed on main, \`branches\` failed on ${BRANCH_THRESHOLD}+ branches.`
	);
	const orphans = rows.filter((r) => r.flaky && !r.issue);
	out.push('', `### Flaky tests missing from known-flakes.json: ${orphans.length}`, '');
	for (const r of orphans) {
		out.push(`- \`${r.key}\``, `  - ${short(r.error) || 'no error line captured'}`);
		out.push(`  - runs: ${r.runs.join(', ')}`);
	}
	return out.join('\n') + '\n';
}

/**
 * The step summary for one CI run: every failed test, marked as a known
 * flake with its owner or as a new failure. Reports only — the job's
 * pass/fail comes from the shards.
 */
export function renderSummary(failures, known) {
	if (failures.length === 0) return '## Playwright e2e\n\nNo failed tests in the shard results.\n';
	const marked = failures.map((f) => ({ ...f, issue: knownIssue(known, f) }));
	const fresh = marked.filter((f) => !f.issue).length;
	const out = [
		'## Playwright e2e failures',
		'',
		fresh === 0
			? 'Every failure is a known flake. Re-run the failed shard.'
			: `${fresh} new ${fresh === 1 ? 'failure' : 'failures'}. Investigate before re-running.`,
		'',
		'| Test | Verdict | Error |',
		'| --- | --- | --- |'
	];
	for (const f of marked) {
		const verdict = f.issue ? `known flake → ${f.issue}` : '**new failure**';
		out.push(`| \`${cell(flakeKey(f))}\` | ${verdict} | ${cell(short(f.error))} |`);
	}
	out.push(
		'',
		'A new failure that passes when re-run on the same SHA is a flake: record it (apps/web/e2e/README.md, "Recording a flake").'
	);
	return out.join('\n') + '\n';
}
