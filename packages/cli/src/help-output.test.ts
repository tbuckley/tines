import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const tsx = join(here, '..', 'node_modules', '.bin', 'tsx');
const entry = join(here, 'index.ts');

const SECRET = 'tines_help-must-never-print-this';

/** Runs the CLI from source; commander exits 0 after printing help. */
function help(args: string[], env: NodeJS.ProcessEnv) {
	return run(tsx, [entry, ...args], {
		env: { ...process.env, ...env },
		timeout: 60_000
	});
}

// Regression: --api-key used to default to process.env.TINES_API_KEY, and
// commander renders an option's default into its help text, so any --help
// printed the caller's live key — straight into agent run logs.
describe('help output', () => {
	it('never prints the value of TINES_API_KEY', async () => {
		for (const args of [
			['--help'],
			['issues', '--help'],
			['issues', 'comment', '--help'],
			['context', 'create', '--help']
		]) {
			const { stdout } = await help(args, {
				TINES_API_KEY: SECRET,
				TINES_API_URL: 'https://api.example.test'
			});
			expect(stdout, args.join(' ')).not.toContain(SECRET);
			expect(stdout, args.join(' ')).not.toContain('https://api.example.test');
		}
	}, 60_000);

	it('still documents the env vars', async () => {
		const { stdout } = await help(['issues', 'comment', '--help'], { TINES_API_KEY: SECRET });
		expect(stdout).toContain('TINES_API_KEY');
		expect(stdout).toContain('TINES_API_URL');
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
			['journal', 'append', 'Tines/1', '--help']
		]) {
			const { stdout } = await help(args, {
				TINES_API_KEY: SECRET,
				// Unreachable: any attempt to talk to the API fails the test.
				TINES_API_URL: 'http://127.0.0.1:1'
			});
			expect(stdout, args.join(' ')).toContain(`Usage: tines ${args[0]} ${args[1]}`);
			expect(stdout, args.join(' ')).not.toContain(SECRET);
		}
	}, 60_000);

	// Wiring regression (Tines/9): the helper is unit-tested in body-value.test.ts,
	// but nothing pinned the five call sites that call it — reverting any of them
	// to the raw value left the suite green. An unreadable @file is the cheap
	// probe: every site resolves its body before it touches the network, so the
	// failure is local and needs no HTTP mock. A site that stopped calling
	// readBodyValue would send the literal "@<path>" to the unreachable URL and
	// fail with a connection error instead.
	it('resolves @file at every Markdown-body call site, before any request', async () => {
		const missing = join(here, 'no-such-body-file.md');
		for (const args of [
			['issues', 'comment', 'Tines/1', `@${missing}`],
			['journal', 'append', 'Tines/1', `@${missing}`],
			['issues', 'create', 'Tines', '-t', 'x', '-d', `@${missing}`],
			['issues', 'edit', 'Tines/1', '-d', `@${missing}`],
			['schedules', 'edit', 'Tines/nightly', '-d', `@${missing}`]
		]) {
			const label = args.join(' ');
			const failure = await help(args, {
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

	// Regression: --version used to be a hardcoded literal, so it kept
	// reporting 0.0.1 no matter what was published. CI stamps the real number
	// into the manifest at publish time, so the manifest is the only honest
	// source (Tines/42).
	it('reports the version from the package manifest', async () => {
		const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
		const { stdout } = await help(['--version'], {});
		expect(stdout.trim()).toBe(manifest.version);
	}, 60_000);
});
