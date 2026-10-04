#!/usr/bin/env node
// Writes the aggregate "Playwright e2e" job's step summary (ci.yml): every
// failed test across the shards' results.json, marked as a known flake with
// its owning issue or as a new failure. See e2e/README.md, "Recording a flake".
//
//   node scripts/flake-summary.mjs <dir of downloaded playwright-results-N>
//
// Appends to $GITHUB_STEP_SUMMARY, or prints when that is unset. Always
// exits 0: it reports, and the shards alone decide pass or fail.
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonReport, renderSummary } from './flake-lib.mjs';

const dir = process.argv[2];
if (!dir) throw new Error('usage: flake-summary.mjs <results dir>');

const failures = [];
const notes = [];
for (const name of existsSync(dir) ? readdirSync(dir).sort() : []) {
	const file = join(dir, name, 'results.json');
	if (!existsSync(file)) continue;
	try {
		failures.push(...parseJsonReport(JSON.parse(readFileSync(file, 'utf8'))));
	} catch (err) {
		notes.push(`Could not read ${name}/results.json: ${err.message}`);
	}
}

const known = JSON.parse(
	readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../e2e/known-flakes.json'), 'utf8')
);
const summary = [renderSummary(failures, known), ...notes].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
else console.log(summary);
