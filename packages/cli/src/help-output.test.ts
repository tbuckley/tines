import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const tsx = join(here, '..', 'node_modules', '.bin', 'tsx');
const entry = join(here, 'index.ts');

const SECRET = 'tines_help-must-never-print-this';

/** Runs the CLI from source through the real bin. */
function cli(args: string[], env: NodeJS.ProcessEnv) {
	return run(tsx, [entry, ...args], {
		env: { ...process.env, ...env },
		timeout: 60_000
	});
}

/**
 * What is left in a subprocess. The blanket help assertions that used to live
 * here are made in-process in program.test.ts, across all 84 commands rather
 * than a hand-picked four. What a subprocess still buys is the real bin: that
 * src/index.ts wires src/program.ts up correctly, that the secret never
 * reaches actual stdout, and the two call-site regressions below, which are
 * about what the action handlers do with argv and cannot be seen from the
 * command tree alone.
 */
describe('the shipped bin', () => {
	it('prints help without leaking TINES_API_KEY or TINES_API_URL', async () => {
		const { stdout } = await cli(['issues', 'comment', '--help'], {
			TINES_API_KEY: SECRET,
			TINES_API_URL: 'https://api.example.test'
		});
		expect(stdout).not.toContain(SECRET);
		expect(stdout).not.toContain('https://api.example.test');
		expect(stdout).toContain('TINES_API_KEY');
		expect(stdout).toContain('TINES_API_URL');
	}, 60_000);

	// The positional source's typing rules live in an addHelpText('after')
	// epilogue, which commander's helpInformation() leaves out — so
	// program.test.ts's snapshot of all 84 commands cannot see it, and only the
	// real bin's rendered --help can.
	it('documents how a positional source is typed on attach --help', async () => {
		const { stdout } = await cli(['issues', 'artifacts', 'attach', '--help'], {
			TINES_API_KEY: SECRET,
			TINES_API_URL: 'http://127.0.0.1:1'
		});
		expect(stdout).toContain(
			'Usage: tines issues artifacts attach [options] <ref> <name> [source]'
		);
		expect(stdout).toContain("typed by the slot's gate");
		// The ungated rule an agent is most likely to get wrong.
		expect(stdout).toContain('a .md path included');
		expect(stdout).toContain('--ignore-gates');
		expect(stdout).not.toContain(SECRET);
	}, 60_000);

	/**
	 * The bin's five lines of try/catch are the only thing turning a thrown
	 * CliError back into the `error: …` line and exit 1 that every parser
	 * diagnostic now rides on (PR 1 converted them from self-terminating
	 * die()). Nothing in-process can see that wiring: program.test.ts imports
	 * program.ts, not the bin.
	 */
	it('reports a parse error on stderr and exits 1', async () => {
		const err = await cli(['issues', 'show', 'badref'], {
			TINES_API_KEY: SECRET,
			TINES_API_URL: 'https://api.example.test'
		}).catch((e: Error & { code?: number; stderr?: string }) => e);

		expect(err).toBeInstanceOf(Error);
		const failure = err as Error & { code?: number; stderr?: string };
		expect(failure.code).toBe(1);
		expect(failure.stderr).toContain('error: issue reference must look like');
		expect(failure.stderr).not.toContain('CliError');
	}, 60_000);

	// Regression (Tines/5, re-asserted for Tines/9): passThroughOptions() hands
	// a TRAILING --help to the action as the literal <markdown>, so helpGuard()
	// is the only thing stopping it from being posted as a comment body. Exit 0
	// with usage on stdout proves it was not: the API URL below is unreachable,
	// so any attempt to post exits 1. (helpGuard also runs before the body is
	// resolved. That ordering is defensive rather than load-bearing — "--help"
	// and "-h" are neither @file nor exactly "-", so readBodyValue returns them
	// verbatim — but it keeps the guard ahead of all I/O by construction.)
	it('prints help for a trailing --help on comment/append instead of posting', async () => {
		for (const args of [
			['issues', 'comment', 'Tines/1', '--help'],
			['issues', 'comment', 'Tines/1', '-h'],
			['issues', 'comment-edit', 'Tines/1', 'cmt_1', '--help'],
			['issues', 'comment-edit', 'Tines/1', 'cmt_1', '-h'],
			['journal', 'append', 'Tines/1', '--help']
		]) {
			const { stdout } = await cli(args, {
				TINES_API_KEY: SECRET,
				// Unreachable: any attempt to talk to the API fails the test.
				TINES_API_URL: 'http://127.0.0.1:1'
			});
			expect(stdout, args.join(' ')).toContain(`Usage: tines ${args[0]} ${args[1]}`);
			expect(stdout, args.join(' ')).not.toContain(SECRET);
		}
	}, 60_000);

	// Wiring regression (Tines/9): the helper is unit-tested in body-value.test.ts,
	// but nothing pinned the six call sites that call it — reverting any of them
	// to the raw value left the suite green. An unreadable @file is the cheap
	// probe: every site resolves its body before it touches the network, so the
	// failure is local and needs no HTTP mock. A site that stopped calling
	// readBodyValue would send the literal "@<path>" to the unreachable URL and
	// fail with a connection error instead. (Tines/50 moved five of these call
	// sites into commands/{issues,journal,schedules}.ts; this spec is what
	// proved the move kept every one of them.)
	it('resolves @file at every Markdown-body call site, before any request', async () => {
		const missing = join(here, 'no-such-body-file.md');
		for (const args of [
			['issues', 'comment', 'Tines/1', `@${missing}`],
			['issues', 'comment-edit', 'Tines/1', 'cmt_1', `@${missing}`],
			['journal', 'append', 'Tines/1', `@${missing}`],
			['issues', 'create', 'Tines', '-t', 'x', '-d', `@${missing}`],
			['issues', 'edit', 'Tines/1', '-d', `@${missing}`],
			['schedules', 'edit', 'Tines/nightly', '-d', `@${missing}`]
		]) {
			const label = args.join(' ');
			const failure = await cli(args, {
				TINES_API_KEY: SECRET,
				// Unreachable: reaching the API at all is the failure this pins.
				TINES_API_URL: 'http://127.0.0.1:1'
			}).catch((err: { code?: number; stderr?: string }) => err);
			expect(failure, label).toBeInstanceOf(Error);
			const { code, stderr } = failure as { code?: number; stderr?: string };
			expect(code, label).toBe(1);
			expect(stderr ?? '', label).toContain(`cannot read ${missing}`);
		}
	}, 60_000);
});
