<script lang="ts">
	import { fade, scale } from 'svelte/transition';
	import { prefersReducedMotion } from '$lib/format';
	import type { Snippet } from 'svelte';

	let {
		open = $bindable(false),
		title,
		children,
		onclose
	}: { open?: boolean; title: string; children: Snippet; onclose?: () => void } = $props();

	const dur = () => (prefersReducedMotion() ? 0 : 150);

	function close() {
		open = false;
		onclose?.();
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && open) close();
	}
</script>

<svelte:window {onkeydown} />

{#if open}
	<div
		class="fixed inset-0 z-50 bg-black/50"
		transition:fade={{ duration: dur() }}
		onclick={close}
		aria-hidden="true"
	></div>
	<div
		class="bg-background fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border p-6 shadow-lg"
		transition:scale={{ duration: dur(), start: 0.96 }}
		role="dialog"
		aria-modal="true"
		aria-label={title}
	>
		<h2 class="mb-4 text-lg font-semibold">{title}</h2>
		{@render children()}
	</div>
{/if}
