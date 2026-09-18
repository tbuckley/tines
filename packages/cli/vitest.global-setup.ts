import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Builds dist/index.js once per run, for the tests that spawn the CLI. */
export default function setup(): void {
	execFileSync('pnpm', ['run', 'build'], {
		cwd: dirname(fileURLToPath(import.meta.url)),
		stdio: 'inherit'
	});
}
