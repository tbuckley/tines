import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';
import { BASE_URL } from './e2e/constants.mjs';

// Prefer a preinstalled Chromium (e.g. sandboxed environments expose one at
// /opt/pw-browsers/chromium); otherwise fall back to Playwright's own
// browser resolution (`pnpm exec playwright install chromium`).
const chromiumPath =
	process.env.PLAYWRIGHT_CHROMIUM_PATH ??
	(existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

export default defineConfig({
	testDir: 'e2e',
	timeout: 30_000,
	// The suite shares one local D1 database; a single worker keeps state
	// deterministic (specs still use per-run unique names).
	workers: 1,
	reporter: [['list']],
	use: {
		baseURL: BASE_URL,
		// Reduced motion is the suite default. Every Svelte transition in the app
		// consults prefersReducedMotion() (dur() → 0) and app.css does the same
		// for view transitions and the AlertDialog, so specs assert state, not
		// motion. The two specs that exercise animation opt out at file level
		// with test.use({ reducedMotion: 'no-preference' }). See e2e/README.md.
		reducedMotion: 'reduce',
		...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {})
	},
	webServer: {
		command: 'bash e2e/server.sh',
		url: `${BASE_URL}/api/time`,
		timeout: 240_000,
		reuseExistingServer: !process.env.CI
	}
});
