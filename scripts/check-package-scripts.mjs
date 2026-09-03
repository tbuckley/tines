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
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Every command and alias in `pnpm help -a` (pnpm 10.33.0). */
const PNPM_COMMANDS = new Set([
	'add',
	'approve-builds',
	'audit',
	'bin',
	'c',
	'cache',
	'cat-file',
	'cat-index',
	'config',
	'create',
	'dedupe',
	'deploy',
	'dlx',
	'doctor',
	'env',
	'exec',
	'fetch',
	'find-hash',
	'i',
	'ignored-builds',
	'import',
	'init',
	'install',
	'install-test',
	'it',
	'licenses',
	'link',
	'ln',
	'list',
	'ls',
	'outdated',
	'pack',
	'patch',
	'patch-commit',
	'patch-remove',
	'prune',
	'publish',
	'rb',
	'rebuild',
	'remove',
	'rm',
	'root',
	'run',
	'self-update',
	'start',
	'store',
	't',
	'test',
	'unlink',
	'up',
	'update',
	'why'
]);

/**
 * The two commands that exist only to run the like-named script, so a script
 * of that name is reachable as `pnpm <name>` after all. `t` is not here: it is
 * an alias for `test` and runs the `test` script, not a script named `t`.
 */
const DELEGATES_TO_SCRIPT = new Set(['start', 'test']);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The workspace's package directories, from pnpm-workspace.yaml's `dir/*` globs. */
function packageDirs() {
	const yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
	const patterns = [...yaml.matchAll(/^\s*-\s*'([^']+)'/gm)].map((m) => m[1]);
	const dirs = [root];
	for (const pattern of patterns) {
		const match = /^([^*]+)\/\*$/.exec(pattern);
		if (!match) throw new Error(`pnpm-workspace.yaml: unsupported pattern '${pattern}'`);
		for (const entry of readdirSync(join(root, match[1]), { withFileTypes: true }))
			if (entry.isDirectory()) dirs.push(join(root, match[1], entry.name));
	}
	return dirs;
}

const problems = [];
let checked = 0;

for (const dir of packageDirs()) {
	const manifest = join(dir, 'package.json');
	let scripts;
	try {
		scripts = JSON.parse(readFileSync(manifest, 'utf8')).scripts ?? {};
	} catch (error) {
		if (error.code === 'ENOENT') continue;
		throw error;
	}
	checked++;
	for (const name of Object.keys(scripts)) {
		if (!PNPM_COMMANDS.has(name) || DELEGATES_TO_SCRIPT.has(name)) continue;
		problems.push(
			`${relative(root, manifest)}: script '${name}' is shadowed by pnpm's own '${name}' ` +
				`command — \`pnpm ${name}\` runs the builtin, so only \`pnpm run ${name}\` reaches ` +
				`this script. Rename it to something pnpm does not own (e.g. 'deploy:prod').`
		);
	}
}

if (problems.length > 0) {
	console.error(`package scripts: ${problems.length} problem(s)`);
	for (const p of problems) console.error(`  - ${p}`);
	process.exit(1);
}
console.log(`package scripts: ${checked} manifests, no names shadowed by a pnpm command, ok`);
