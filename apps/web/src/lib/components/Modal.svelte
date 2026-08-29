<script lang="ts">
	import { fade, scale } from 'svelte/transition';
	import { prefersReducedMotion } from '$lib/format';
	import type { Snippet } from 'svelte';

	let {
		open = $bindable(false),
		title,
		size = 'md',
		children,
		onclose
	}: {
		open?: boolean;
		title: string;
		/** 'md' for forms (default); 'xl' for content viewers. */
		size?: 'md' | 'xl';
		children: Snippet;
		onclose?: () => void;
	} = $props();

	const dur = () => (prefersReducedMotion() ? 0 : 150);

	function close() {
		open = false;
		onclose?.();
	}

	// `defaultPrevented` skips Escape presses an AlertDialog stacked on top of
	// this modal already handled (bits-ui prevents default but lets the event
	// bubble on to window).
	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && open && !e.defaultPrevented) close();
	}

	// Renders into <body>: the layout's <main> carries a view-transition-name,
	// which makes it a stacking context, so no z-index inside it can paint above
	// the app's sticky header / bottom tab bar (z-40 siblings of <main>).
	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		return {
			destroy() {
				node.remove();
			}
		};
	}
</script>

<svelte:window {onkeydown} />

{#if open}
	<div
		class="fixed inset-0 z-50 bg-black/50"
		use:portal
		transition:fade={{ duration: dur() }}
		onclick={close}
		aria-hidden="true"
	></div>
	<!-- Anchored near the top on phones so the on-screen keyboard doesn't cover
	     the dialog's fields; centered on larger screens. -->
	<div
		class="bg-background fixed top-4 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] {size === 'xl'
			? 'max-w-4xl'
			: 'max-w-md'} -translate-x-1/2 overflow-y-auto rounded-xl border p-6 shadow-lg sm:top-1/2 sm:-translate-y-1/2"
		use:portal
		transition:scale={{ duration: dur(), start: 0.96 }}
		role="dialog"
		aria-modal="true"
		aria-label={title}
	>
		<h2 class="mb-4 text-lg font-semibold">{title}</h2>
		{@render children()}
	</div>
{/if}
