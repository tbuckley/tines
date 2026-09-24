<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import { LOADING_STATES, type LoadingStateId } from '$lib/perf/loading-states';
	import { record } from '$lib/perf/telemetry';

	/**
	 * The one way to show a loading placeholder (see lib/perf/loading-states.ts):
	 * renders its children and reports how long they were on screen, so
	 * production telemetry says how often each placeholder appears and for how
	 * long. Placeholders gone within a frame are not reported.
	 */
	let { id, children }: { id: LoadingStateId; children: Snippet } = $props();

	$effect(() => {
		if (!(id in LOADING_STATES)) return;
		const shownAt = performance.now();
		const route = page.route.id ?? '';
		return () => {
			const ms = performance.now() - shownAt;
			if (ms >= 16) record({ k: 'loading', id, route, ms: Math.round(ms) });
		};
	});
</script>

{@render children()}
