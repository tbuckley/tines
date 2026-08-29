<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import { fade, scale } from 'svelte/transition';
	import IconX from '@tabler/icons-svelte/icons/x';
	import { prefersReducedMotion } from '$lib/format';

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

	const titleId = $props.id();
	const dur = () => (prefersReducedMotion() ? 0 : 150);

	let closeButton = $state<HTMLButtonElement | null>(null);

	function close() {
		open = false;
		onclose?.();
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && open && !e.defaultPrevented) close();
	}

	// While open: lock the page behind so a touch drag that reaches the end of
	// the dialog's scroller doesn't scroll the document instead, and park focus
	// on the close button so a keyboard user's next Tab starts inside. Cleanup
	// runs on close *and* on destroy, so navigating away can't leave <body>
	// locked. Two modals are never open at once here, so save/restore of the
	// single previous value is enough (no ref counting).
	$effect(() => {
		if (!open) return;
		const previousOverflow = document.body.style.overflow;
		const previouslyFocused = document.activeElement as HTMLElement | null;
		document.body.style.overflow = 'hidden';
		tick().then(() => closeButton?.focus({ preventScroll: true }));
		return () => {
			document.body.style.overflow = previousOverflow;
			if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true });
		};
	});

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
	     the dialog's fields; centered on larger screens. A column of a fixed
	     header and one scrolling body: content of any length scrolls under a
	     close button that is always on screen. -->
	<div
		class="bg-background fixed top-4 left-1/2 z-50 flex w-[calc(100%-2rem)] {size === 'xl'
			? 'max-w-4xl'
			: 'max-w-md'} -translate-x-1/2 flex-col overflow-hidden rounded-xl border shadow-lg sm:top-1/2 sm:-translate-y-1/2"
		style="max-height: calc(100dvh - 2rem - env(safe-area-inset-bottom, 0px))"
		use:portal
		transition:scale={{ duration: dur(), start: 0.96 }}
		role="dialog"
		aria-modal="true"
		aria-labelledby={titleId}
	>
		<div class="flex shrink-0 items-start justify-between gap-3 px-6 pt-5 pb-3">
			<h2 id={titleId} class="text-lg font-semibold">{title}</h2>
			<button
				type="button"
				bind:this={closeButton}
				class="text-muted-foreground hover:text-foreground hover:bg-muted -mt-1 -mr-2 inline-flex size-9 shrink-0 items-center justify-center rounded-md"
				aria-label="Close"
				onclick={close}
			>
				<IconX size={18} />
			</button>
		</div>
		<div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-6">
			{@render children()}
		</div>
	</div>
{/if}
