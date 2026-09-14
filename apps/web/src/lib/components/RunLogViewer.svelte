<script lang="ts">
	import type { AgentRunDetail } from '@tines/shared';
	import { isActiveRun } from '@tines/shared';
	import { api } from '$lib/api';

	let {
		runId,
		runError = null
	}: {
		runId: string;
		/**
		 * The run's failure reason, passed in rather than read off `detail`:
		 * the row clamps it to two lines, so this disclosure is where the
		 * whole string is read — and it must be there the moment the row
		 * expands, including when the log fetch itself fails.
		 */
		runError?: string | null;
	} = $props();

	let detail = $state<AgentRunDetail | null>(null);
	let error = $state<string | null>(null);
	let pre = $state<HTMLPreElement | undefined>();
	/** Auto-follow while running; scrolling up pauses it, back to bottom resumes. */
	let follow = $state(true);

	const active = $derived(detail === null || isActiveRun(detail.status));

	async function refresh() {
		try {
			detail = await api.getRun(runId);
			error = null;
			if (follow && pre) {
				requestAnimationFrame(() => {
					if (pre && follow) pre.scrollTop = pre.scrollHeight;
				});
			}
		} catch {
			error = 'Could not load the log — retrying.';
		}
	}

	// Local runs stream continuously: refresh while the run is active.
	$effect(() => {
		void refresh();
		if (!active) return;
		const timer = setInterval(() => void refresh(), 3000);
		return () => clearInterval(timer);
	});

	function onScroll() {
		if (!pre) return;
		follow = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 24;
	}
</script>

<div class="mt-1 w-full min-w-0">
	{#if runError}
		<p
			class="mb-1 text-xs break-words whitespace-pre-wrap text-amber-700 dark:text-amber-400"
			data-testid="run-error-full"
		>
			{runError}
		</p>
	{/if}
	{#if error}
		<p class="text-muted-foreground text-xs italic">{error}</p>
	{:else if detail}
		{#if detail.log_bytes_dropped > 0}
			<p class="text-muted-foreground mb-1 text-xs">
				{Math.round(detail.log_bytes_dropped / 1024)} KB truncated from the head{#if !detail.log_expired}
					{' '}—{' '}<a
						class="underline underline-offset-2"
						href="/api/v1/runs/{detail.id}/log"
						target="_blank"
						rel="noopener"
						data-testid="run-log-full-link"
						>view the full {Math.round(detail.log_full_bytes / 1024)} KB log</a
					>{:else}{' '}(past its retention window; only the tail remains){/if}
			</p>
		{/if}
		<pre
			bind:this={pre}
			onscroll={onScroll}
			class="bg-muted/50 max-h-72 overflow-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap"
			data-testid="run-log">{#if detail.log}{detail.log}{:else if active}<span
					class="text-muted-foreground"
					data-testid="run-log-waiting"
					>waiting for the harness<span aria-hidden="true" class="motion-safe:animate-pulse">…</span
					></span
				>{:else}(no log output captured){/if}</pre>
	{:else}
		<p class="text-muted-foreground text-xs italic">Loading log…</p>
	{/if}
</div>
