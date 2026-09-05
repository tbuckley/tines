import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * How the subprocess tests launch the CLI: the bundle vitest's global setup
 * builds before any test file runs (vitest.global-setup.ts), under the node
 * running the tests. The same artifact `pnpm build` ships, so a test that
 * passes here passes against the published bin — and it starts in ~70 ms,
 * where `tsx src/index.ts` needed ~400 ms per launch.
 */
export const CLI_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
export const NODE = process.execPath;
