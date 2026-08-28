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
});
