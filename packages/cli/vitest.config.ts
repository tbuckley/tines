import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// The subprocess tests (help-output, list-pagination, the daemon specs,
		// …) launch the real bin. It is built once here and run as
		// `node dist/index.js` (src/test-bin.ts): about 70 ms a launch, where
		// `tsx src/index.ts` was about 400 ms, and one file launches it dozens
		// of times.
		globalSetup: ['./vitest.global-setup.ts']
	}
});
