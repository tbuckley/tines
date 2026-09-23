/**
 * In-process tests over the whole command tree.
 *
 * `src/index.ts` is the bin — importing it runs the CLI — so everything here
 * imports `src/program.ts`, which builds the tree without parsing anything.
 *
 * Constraint for future authors: only inputs that FAIL to parse (or that
 * trigger help) are safe to feed `parseAsync` here. A successfully parsed
 * command runs its action, which calls the network and then `die()`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'tines_help-must-never-print-this';
const SECRET_URL = 'https://api.example.test';

/** Every node of the tree: the root and all registered (sub)commands. */
function walk(cmd: Command): Command[] {
	return [cmd, ...cmd.commands.flatMap((sub) => walk(sub as Command))];
}

/** The full command path of a node, e.g. `tines issues comment`. */
function path(cmd: Command): string {
	const parts: string[] = [];
	for (let c: Command | null = cmd; c; c = c.parent as Command | null) parts.unshift(c.name());
	return parts.join(' ');
}

/**
 * Imports a fresh copy of the program tree. Registration reads the
 * environment at import time (that is the whole point of the secret-leak
 * regression), so the env has to be stubbed before the import.
 */
async function freshProgram(env: Record<string, string>): Promise<Command> {
	for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
	vi.resetModules();
	const mod = await import('./program.js');
	return mod.program;
}

beforeEach(() => {
	vi.resetModules();
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('command tree', () => {
	it('registers every noun, with unique names per parent', async () => {
		const program = await freshProgram({});
		const nouns = program.commands.map((c) => c.name()).sort();
		expect(nouns).toEqual(
			[
				'api-keys',
				'config',
				'context',
				'events',
				'issues',
				'journal',
				'labels',
				'login',
				'logout',
				'projects',
				'routing',
				'runner',
				'runners',
				'runs',
				'schedules',
				'supervisor',
				'time',
				'usage',
				'workflows'
			].sort()
		);

		for (const node of walk(program)) {
			const names = node.commands.map((c) => c.name());
			expect(new Set(names).size, `duplicate subcommand under "${path(node)}"`).toBe(names.length);
		}
	});

	// Regression: --version used to be a hardcoded literal, so it kept
	// reporting 0.0.1 no matter what was published. CI stamps the real number
	// into the manifest at publish time, so the manifest is the only honest
	// source (Tines/42).
	it('reports the version from the package manifest', async () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
		const program = await freshProgram({});
		expect(program.version()).toBe(manifest.version);
	});
});

// Regression: --api-key used to default to process.env.TINES_API_KEY, and
// commander renders an option's default into its help text, so any --help
// printed the caller's live key — straight into agent run logs. The
// subprocess version of this test could only afford to check a handful of
// hand-picked commands; in-process it is cheap to check every one.
describe('help output', () => {
	it('never prints the value of TINES_API_KEY or TINES_API_URL, on any command', async () => {
		const program = await freshProgram({ TINES_API_KEY: SECRET, TINES_API_URL: SECRET_URL });
		const nodes = walk(program);
		expect(nodes.length).toBeGreaterThan(80);

		for (const node of nodes) {
			const help = node.helpInformation();
			expect(help, path(node)).not.toContain(SECRET);
			expect(help, path(node)).not.toContain(SECRET_URL);
		}
	});

	it('still documents the env vars', async () => {
		const program = await freshProgram({ TINES_API_KEY: SECRET });
		const comment = walk(program).find((c) => path(c) === 'tines issues comment');
		const help = comment!.helpInformation();
		expect(help).toContain('TINES_API_KEY');
		expect(help).toContain('TINES_API_URL');
	});

	// The wiring snapshot: the exact help text of all 84 nodes. Splitting
	// command registration across modules is a mechanical move that can
	// silently drop a flag, and this is what catches that. helpWidth is
	// pinned so the snapshot does not depend on the terminal it ran in.
	it('matches the recorded help text for every command', async () => {
		const program = await freshProgram({ TINES_API_KEY: SECRET, TINES_API_URL: SECRET_URL });
		const recorded: Record<string, string> = {};
		for (const node of walk(program)) {
			node.configureHelp({ helpWidth: 80 });
			recorded[path(node)] = node.helpInformation();
		}
		expect(recorded).toMatchSnapshot();
	});
});

// Ported from the subprocess journal-cli.test.ts. `journal append` is
// passThroughOptions(), so a trailing flag becomes an extra argument rather
// than being silently ignored — and the help text has to say so.
describe('tines journal --state', () => {
	it('is offered by all three subcommands, with the ordering hint', async () => {
		const program = await freshProgram({});
		for (const sub of ['show', 'append', 'rewrite']) {
			const node = walk(program).find((c) => path(c) === `tines journal ${sub}`);
			const help = node!.helpInformation();
			expect(help, sub).toContain('--state <workflow>/<state>');
			expect(help, sub).toContain('options go BEFORE <ref>');
		}
	});

	it('rejects a trailing --state on append rather than ignoring it', async () => {
		const program = await freshProgram({});
		// exitOverride has to be applied to every node: set on the root alone,
		// subcommands still call process.exit, and the error that surfaces
		// carries no assertable message.
		for (const node of walk(program)) node.exitOverride();

		await expect(
			program.parseAsync(['journal', 'append', 'Proj/1', '- lesson', '--state', 'W/S'], {
				from: 'user'
			})
		).rejects.toThrow("too many arguments for 'append'");
	});
});

// Tines/92: `--url` used to mean the API base URL on 83 commands and a payload
// on three (`issues artifacts attach`, `context create/edit`), which made the
// documented idiom silently wrong on exactly the commands that took a URL.
describe('the --url flag means the API base URL, everywhere', () => {
	/** Leaf commands — the nodes that actually run an action. */
	function leaves(program: Command): Command[] {
		return walk(program).filter((c) => c.commands.length === 0);
	}

	/**
	 * The commands that never talk to the API — pure filesystem, no common
	 * flags at all. Anything else appearing here is a command that forgot
	 * withCommon(), which is how the collision this test exists for got in.
	 */
	const OFFLINE_LEAVES = [
		'tines logout',
		'tines runner restart',
		'tines runner uninstall',
		'tines runner workspaces prune'
	];

	it('is offered by every leaf command that talks to the API', async () => {
		const program = await freshProgram({});
		const nodes = leaves(program);
		expect(nodes.length).toBeGreaterThan(60);

		const offline = nodes.filter((c) => !c.options.some((o) => o.long === '--api-key'));
		expect(offline.map(path).sort()).toEqual([...OFFLINE_LEAVES].sort());

		for (const node of nodes.filter((c) => !OFFLINE_LEAVES.includes(path(c)))) {
			const opt = node.options.find((o) => o.long === '--url');
			expect(opt, `"${path(node)}" has no --url option`).toBeDefined();
			expect(opt!.short, path(node)).toBe('-u');
			expect(opt!.description, path(node)).toContain('base URL of the Tines API');
			// The published default: the deployment, not a dev server.
			expect(opt!.description, path(node)).toContain('https://tines.tbuckley.dev');
		}
	});

	it('leaves the renamed payload flags in place under their own names', async () => {
		const program = await freshProgram({});
		const longs = (ref: string) =>
			walk(program)
				.find((c) => path(c) === ref)!
				.options.map((o) => o.long);
		expect(longs('tines issues artifacts attach')).toContain('--link');
		expect(longs('tines context create')).toContain('--repo-url');
		expect(longs('tines context edit')).toContain('--repo-url');
	});
});

/**
 * Runs a command expected to `die()`, returning what it printed to stderr.
 * Safe only for failures raised before the first network call.
 */
async function runExpectingDie(program: Command, argv: string[]): Promise<string> {
	const errors: string[] = [];
	const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
		errors.push(args.join(' '));
	});
	const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
		throw new Error(`process.exit(${code})`);
	}) as never);
	try {
		await expect(program.parseAsync(argv, { from: 'user' })).rejects.toThrow('process.exit(1)');
		return errors.join('\n');
	} finally {
		consoleError.mockRestore();
		exit.mockRestore();
	}
}

// The old idiom has to fail loudly rather than doing something plausible: an
// `attach --url <link>` used to attach a link artifact pointing at the API.
describe('old --url payload callers are corrected offline', () => {
	it('artifacts attach with only --url fails the arity check, naming --link', async () => {
		const program = await freshProgram({});
		const err = await runExpectingDie(program, [
			'issues',
			'artifacts',
			'attach',
			'Proj/1',
			'notes',
			'--url',
			'https://example.test/doc'
		]);
		expect(err).toContain('pass exactly one content source');
		expect(err).toContain('--link <url>');
		expect(err).toContain('--url is the API base URL');
	});

	it('context create --kind repo without --repo-url dies before it dials the clone URL', async () => {
		const program = await freshProgram({});
		const err = await runExpectingDie(program, [
			'context',
			'create',
			'--kind',
			'repo',
			'--name',
			'repo-x',
			'--url',
			'https://github.com/tbuckley/tines.git'
		]);
		expect(err).toContain('--kind repo needs --repo-url <clone-url>');
		expect(err).toContain('--url is the API base URL');
	});
});

describe('runner continuation flags fail before network access', () => {
	it.each([
		['runners', 'edit', 'local', '--resume-enabled', 'yes'],
		['runners', 'edit', 'local', '--resume-window-hours', '0'],
		['runners', 'edit', 'local', '--resume-max-cost-usd', 'NaN']
	])('%s', async (...argv) => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const program = await freshProgram({});
		await runExpectingDie(program, argv);
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});
});
