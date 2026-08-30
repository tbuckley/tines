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

/**
 * The one end-to-end spec left in a subprocess. Everything else that used to
 * live here is asserted in-process in program.test.ts, across all 84 commands
 * rather than a hand-picked four. What a subprocess still buys is the real
 * bin: that src/index.ts wires src/program.ts up correctly, that the secret
 * never reaches actual stdout, and that --help exits 0.
 */
describe('the shipped bin', () => {
	it('prints help without leaking TINES_API_KEY or TINES_API_URL', async () => {
		const { stdout } = await run(tsx, [entry, 'issues', 'comment', '--help'], {
			env: { ...process.env, TINES_API_KEY: SECRET, TINES_API_URL: 'https://api.example.test' },
			timeout: 60_000
		});
		expect(stdout).not.toContain(SECRET);
		expect(stdout).not.toContain('https://api.example.test');
		expect(stdout).toContain('TINES_API_KEY');
	}, 60_000);

	/**
	 * The bin's five lines of try/catch are the only thing turning a thrown
	 * CliError back into the `error: …` line and exit 1 that every parser
	 * diagnostic now rides on (PR 1 converted them from self-terminating
	 * die()). Nothing in-process can see that wiring: program.test.ts imports
	 * program.ts, not the bin.
	 */
	it('reports a parse error on stderr and exits 1', async () => {
		const err = await run(tsx, [entry, 'issues', 'show', 'badref'], {
			env: { ...process.env, TINES_API_KEY: SECRET, TINES_API_URL: 'https://api.example.test' },
			timeout: 60_000
		}).catch((e: Error & { code?: number; stderr?: string }) => e);

		expect(err).toBeInstanceOf(Error);
		const failure = err as Error & { code?: number; stderr?: string };
		expect(failure.code).toBe(1);
		expect(failure.stderr).toContain('error: issue reference must look like');
		expect(failure.stderr).not.toContain('CliError');
	}, 60_000);
});
