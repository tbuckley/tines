/**
 * Guards package.json script names against pnpm's own commands. `pnpm <name>`
 * runs a builtin when one exists and the script only when one does not, so a
 * script named after a builtin is unreachable in the form everyone types:
 * `apps/web`'s `deploy` script silently ran pnpm's workspace deploy instead,
 * failing with ERR_PNPM_NOTHING_TO_DEPLOY without building or deploying
 * anything (Tines/121). Nothing else notices — the script is valid JSON and
 * `pnpm run <name>` still works.
 *
 * `pnpm check` runs this from the repo root; CI runs `pnpm check`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every name pnpm 10.33.0 resolves to something other than your script —
 * either its own builtin or an npm command it forwards to (`pnpm version`,
 * `pnpm pkg`, …). Do NOT derive this from `pnpm help -a`: that omits `setup`,
 * `server`, `ci`, `help`, the `-r` aliases and the whole npm-forwarded group.
 * Derived instead by probing every candidate name, which tells the three cases
 * apart by the first line of `pnpm <name> --help` in a directory with no
 * package.json:
 *
 *   for n in add deploy setup version build …; do
 *     printf '%s\t%s\n' "$n" "$(pnpm "$n" --help 2>&1 | head -1)"
 *   done
 *
 * `Version 10.33.0 …` is a pnpm builtin, `npm warn …`/npm's own help is a
 * forwarded npm command, and ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND means pnpm
 * fell through to `pnpm run <name>` — i.e. the name is free. Re-run it when
 * `packageManager` moves to a new pnpm.
 */
const PNPM_COMMANDS = new Set([
	'access',
	'add',
	'adduser',
	'approve-builds',
	'audit',
	'bin',
	'bugs',
	'c',
	'cache',
	'cat-file',
	'cat-index',
	'ci',
	'completion',
	'config',
	'create',
	'dedupe',
	'deploy',
	'dist-tag',
	'dlx',
	'docs',
	'doctor',
	'edit',
	'env',
	'exec',
	'fetch',
	'find-hash',
	'help',
	'home',
	'i',
	'ignored-builds',
	'import',
	'init',
	'install',
	'install-test',
	'issues',
	'it',
	'la',
	'licenses',
	'link',
	'list',
	'll',
	'ln',
	'login',
	'logout',
	'ls',
	'm',
	'multi',
	'outdated',
	'owner',
	'pack',
	'patch',
	'patch-commit',
	'patch-remove',
	'ping',
	'pkg',
	'prefix',
	'profile',
	'prune',
	'publish',
	'rb',
	'rebuild',
	'recursive',
	'remove',
	'repo',
	'restart',
	'rm',
	'root',
	'run',
	'search',
	'self-update',
	'server',
	'setup',
	'star',
	'stars',
	'start',
	'store',
	't',
	'team',
	'test',
	'token',
	'un',
	'uninstall',
	'unlink',
	'unstar',
	'up',
	'update',
	'upgrade',
	'version',
	'view',
	'whoami',
	'why'
]);

/**
 * The names above where `pnpm <name>` does reach the like-named script, so the
 * script is not shadowed and must not be flagged. `start`, `test` and
 * `restart` are the commands that exist to run it (`restart` runs `stop`,
 * `restart` then `start`, and errors unless all three exist); `install` is the
 * npm lifecycle hook, which `pnpm install` runs. All four verified against
 * pnpm 10.33.0.
 *
 * `t` is deliberately absent: it is an alias for `test` and runs the `test`
 * script, never a script named `t`. So are `publish`, `version` and
 * `uninstall`: npm invokes those as lifecycle hooks, but `pnpm <name>` runs
 * pnpm's command — it is not a way to invoke your script.
 */
const RUNS_THE_SCRIPT = new Set(['install', 'restart', 'start', 'test']);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceFile = join(root, 'pnpm-workspace.yaml');

/** Report and stop. `pnpm check` is a gate: it must say why, not print a stack. */
function fail(message) {
	console.error(`package scripts: ${message}`);
	process.exit(1);
}

/**
 * The `packages:` globs from pnpm-workspace.yaml, hand-read rather than
 * pulling a YAML parser into a root build script. Deliberately strict, because
 * a guard that quietly covers less than the workspace is worse than no guard:
 * it reads only the top-level `packages:` block (so an unrelated key such as
 * `onlyBuiltDependencies` cannot be mistaken for a glob), takes list items
 * quoted or not, and fails loudly on anything it does not understand.
 */
function workspaceGlobs() {
	const lines = readFileSync(workspaceFile, 'utf8').split('\n');
	const start = lines.findIndex((line) => /^packages:\s*$/.test(line));
	if (start === -1)
		fail(
			`${relative(root, workspaceFile)}: no top-level 'packages:' block — this check reads the ` +
				`block form only, so teach it the new shape rather than letting it check nothing.`
		);
	const globs = [];
	for (const line of lines.slice(start + 1)) {
		if (/^\s*(#.*)?$/.test(line)) continue; // blank or comment
		if (!/^\s/.test(line)) break; // the next top-level key ends the block
		const item = /^\s*-\s*(.*?)\s*$/.exec(line);
		if (!item)
			fail(
				`${relative(root, workspaceFile)}: unreadable line in the packages block: ${line.trim()}`
			);
		globs.push(item[1].replace(/^(['"])(.*)\1$/, '$2'));
	}
	if (globs.length === 0) fail(`${relative(root, workspaceFile)}: the packages block is empty`);
	return globs;
}

/**
 * The repo root plus every workspace package. Each glob must match at least
 * one package: that is the floor on how much this check covers, so a parser
 * regression fails loudly instead of reporting ok over the root alone.
 */
function packageDirs() {
	const dirs = [root];
	for (const glob of workspaceGlobs()) {
		const match = /^([^*]+)\/\*$/.exec(glob);
		if (!match)
			fail(
				`${relative(root, workspaceFile)}: unsupported packages glob '${glob}' — this check ` +
					`understands 'dir/*' only; teach it the new shape rather than dropping the entry.`
			);
		const parent = join(root, match[1]);
		const matched = (existsSync(parent) ? readdirSync(parent, { withFileTypes: true }) : [])
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(parent, entry.name))
			.filter((dir) => existsSync(join(dir, 'package.json')));
		if (matched.length === 0)
			fail(
				`${relative(root, workspaceFile)}: glob '${glob}' matched no package — this check would ` +
					`cover less than the workspace.`
			);
		dirs.push(...matched);
	}
	return dirs;
}

const problems = [];
let checked = 0;

for (const dir of packageDirs()) {
	const manifest = join(dir, 'package.json');
	const scripts = JSON.parse(readFileSync(manifest, 'utf8')).scripts ?? {};
	checked++;
	for (const name of Object.keys(scripts)) {
		if (!PNPM_COMMANDS.has(name) || RUNS_THE_SCRIPT.has(name)) continue;
		problems.push(
			`${relative(root, manifest)}: script '${name}' is shadowed by pnpm's own '${name}' ` +
				`command — \`pnpm ${name}\` runs that command rather than this script, which is then ` +
				`only reachable as \`pnpm run ${name}\`. Rename it to something pnpm does not own ` +
				`(e.g. 'deploy:prod').`
		);
	}
}

if (problems.length > 0) {
	console.error(`package scripts: ${problems.length} problem(s)`);
	for (const p of problems) console.error(`  - ${p}`);
	process.exit(1);
}
console.log(`package scripts: ${checked} manifests, no names shadowed by a pnpm command, ok`);
