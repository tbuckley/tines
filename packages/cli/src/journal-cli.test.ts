/**
 * The `--state` override and the argument order it must be given in. The
 * ordering matters because `journal append` is `passThroughOptions()` — a
 * trailing flag is a parse error, not a silently ignored one — so the help
 * text has to say so.
 */
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const tsx = join(here, '..', 'node_modules', '.bin', 'tsx');
const entry = join(here, 'index.ts');

/** Runs the CLI from source against an unreachable API. */
function cli(args: string[]) {
	return run(tsx, [entry, ...args], {
		env: { ...process.env, TINES_API_KEY: 'tines_test', TINES_API_URL: 'https://api.example.test' },
		timeout: 60_000
	});
}

describe('tines journal --state', () => {
	it('is offered by all three subcommands, with the ordering hint', async () => {
		for (const sub of ['show', 'append', 'rewrite']) {
			const { stdout } = await cli(['journal', sub, '--help']);
			expect(stdout, sub).toContain('--state <workflow>/<state>');
			expect(stdout, sub).toContain('options go BEFORE <ref>');
		}
	}, 60_000);

	it('rejects a trailing --state on append rather than ignoring it', async () => {
		// passThroughOptions() hands everything after the arguments to the
		// markdown, so commander sees three arguments where it wants two.
		const err: { code?: number; stderr?: string } = await cli([
			'journal',
			'append',
			'Proj/1',
			'- lesson',
			'--state',
			'W/S'
		]).then(
			() => ({}),
			(e: { code?: number; stderr?: string }) => e
		);
		expect(err.code).not.toBe(0);
		expect(err.stderr).toContain("too many arguments for 'append'");
	}, 60_000);
});
