import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['src/**/*.test.ts'],
		// The navigation-cost probe is a measurement tool, not a gate: it spends
		// seconds deliberately sleeping. `pnpm perf:nav` sets NAVPERF=1 to opt in.
		exclude: [
			...configDefaults.exclude,
			...(process.env.NAVPERF === '1' ? [] : ['**/nav-perf.test.ts'])
		],
		environment: 'node'
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
			csrf: { checkOrigin: false }
		})
	]
});
