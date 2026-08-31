<script lang="ts">
	import type { AgentRunDetail } from '@tines/shared';
	import { ACTIVE_RUN_STATUSES } from '@tines/shared';
	import { api } from '$lib/api';

	let { runId }: { runId: string } = $props();

	let detail = $state<AgentRunDetail | null>(null);
	let error = $state<string | null>(null);
	let pre = $state<HTMLPreElement | undefined>();
	/** Auto-follow while running; scrolling up pauses it, back to bottom resumes. */
	let follow = $state(true);

	const active = $derived(
		detail === null || (ACTIVE_RUN_STATUSES as readonly string[]).includes(detail.status)
	);

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
						data-testid="run-log-full-link">view the full {Math.round(detail.log_full_bytes / 1024)} KB log</a
					>{:else}{' '}(past its retention window; only the tail remains){/if}
			</p>
		{/if}
		<pre
			bind:this={pre}
			onscroll={onScroll}
			class="bg-muted/50 max-h-72 overflow-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap"
			data-testid="run-log">{detail.log || (active ? '(no output yet)' : '(no log output captured)')}</pre>
	{:else}
		<p class="text-muted-foreground text-xs italic">Loading log…</p>
	{/if}
</div>
