import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
	server: {
		// The simulated EMAIL binding writes each message under .wrangler/tmp/,
		// and D1/R2 state lives under .wrangler/state/: neither is source, and
		// watching them made every magic-link request trigger a full page
		// reload — wiping the "Check your email" state as it appeared.
		watch: { ignored: ['**/.wrangler/**'] }
	},
	test: {
		include: ['src/**/*.test.ts'],
		// The navigation-cost probe is a measurement tool, not a gate: it spends
		// seconds deliberately sleeping. `pnpm --filter web perf:nav` sets
		// NAVPERF=1 to opt in.
		exclude: [
			...configDefaults.exclude,
			...(process.env.NAVPERF === '1' ? [] : ['**/nav-perf.test.ts']),
			...(process.env.STATSPERF === '1' ? [] : ['**/stats-perf.test.ts'])
		],
		environment: 'node',
		// The unit-test DB is node:sqlite (src/lib/server/api/test-db.ts),
		// which Node 22 still flags as experimental — once per worker, so a
		// run printed it half a dozen times. Silence just that warning, just
		// in the workers.
		execArgv: ['--disable-warning=ExperimentalWarning']
	},
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// The adapter reads its own config (not wrangler.jsonc): it writes the
			// generated worker to its config's `main`, and wrangler.jsonc's `main`
			// is the custom worker/index.ts entry wrapping that output with the
			// scheduled() handler for the scheduled-task sweep.
			adapter: adapter({ config: 'wrangler.adapter.jsonc' }),

			// Kit's blanket origin check 403s every multipart mutation whose
			// Origin doesn't match — which is every non-browser client (CLI,
			// agents), since they send no Origin at all. That blocks the
			// artifact folder-snapshot upload by design-abiding API callers.
			// hooks.server.ts re-implements the same guard scoped to where
			// CSRF actually applies: cookie-carrying requests.
			//
			// Kit deprecates this switch in favour of `csrf.trustedOrigins`,
			// but that only allowlists origins — a request with no Origin
			// header at all is still rejected — so it cannot express "skip the
			// check"; the deprecation notice stays until Kit offers a way.
			csrf: { checkOrigin: false }
		})
	]
});
