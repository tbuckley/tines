/**
 * Guards apps/web/migrations/ numbering. D1 applies migrations in filename
 * order and records them by name, so nothing else notices a duplicate or a
 * gap — two PRs both picking the next number is how 0010 got taken twice.
 * `pnpm check` runs this from the repo root; CI runs `pnpm check`.
 *
 * Rules: every file is `NNNN_snake_case.sql`; numbers are unique and run
 * 0001..N with no gaps. The one existing duplicate is grandfathered — the
 * files are already applied under those names in production, and renaming
 * an applied migration would make D1 re-run it.
 */
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GRANDFATHERED_DUPLICATES = new Set(['0010']);

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const files = readdirSync(dir).sort();
const problems = [];
const byNumber = new Map();

for (const file of files) {
	const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(file);
	if (!match) {
		problems.push(`${file}: expected NNNN_snake_case.sql`);
		continue;
	}
	const number = match[1];
	const seen = byNumber.get(number) ?? [];
	seen.push(file);
	byNumber.set(number, seen);
}

for (const [number, names] of byNumber) {
	if (names.length > 1 && !GRANDFATHERED_DUPLICATES.has(number)) {
		problems.push(
			`${number} is used ${names.length} times: ${names.join(', ')} — renumber the newer one`
		);
	}
}

const numbers = [...byNumber.keys()].map(Number).sort((a, b) => a - b);
const highest = numbers.at(-1) ?? 0;
for (let n = 1; n <= highest; n++) {
	if (!byNumber.has(String(n).padStart(4, '0')))
		problems.push(`no migration numbered ${String(n).padStart(4, '0')}`);
}

if (problems.length > 0) {
	console.error(`migrations: ${problems.length} problem(s) in ${dir}`);
	for (const p of problems) console.error(`  - ${p}`);
	process.exit(1);
}
console.log(
	`migrations: ${files.length} files, numbered 0001..${String(highest).padStart(4, '0')}, ok`
);
