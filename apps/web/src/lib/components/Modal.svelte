<script module lang="ts">
	// The page-behind scroll lock is shared state, so it is ref-counted at module
	// scope rather than saved and restored per instance: with focus movement but
	// no trap (Tines/29), a second modal can be opened from behind an open one,
	// and per-instance save/restore inverts when they close — the last writer
	// would write 'hidden' and leave <body> locked with no modal on screen.
	let openModals = 0;
	let previousBodyOverflow = '';

	function lockBodyScroll() {
		if (openModals++ === 0) {
			previousBodyOverflow = document.body.style.overflow;
			document.body.style.overflow = 'hidden';
		}
	}

	function unlockBodyScroll() {
		if (openModals > 0 && --openModals === 0) document.body.style.overflow = previousBodyOverflow;
	}
</script>

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

	// `defaultPrevented` skips Escape presses an AlertDialog stacked on top of
	// this modal already handled (bits-ui prevents default but lets the event
	// bubble on to window).
	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && open && !e.defaultPrevented) close();
	}

	// While open: lock the page behind so a touch drag that reaches the end of
	// the dialog's scroller doesn't scroll the document instead, and park focus
	// on the close button so a keyboard user's next Tab starts inside. Cleanup
	// runs on close *and* on destroy, so navigating away can't leave <body>
	// locked, and the ref count makes the order of one modal's cleanup against
	// another's setup irrelevant.
	$effect(() => {
		if (!open) return;
		const previouslyFocused = document.activeElement as HTMLElement | null;
		lockBodyScroll();
		tick().then(() => closeButton?.focus({ preventScroll: true }));
		return () => {
			unlockBodyScroll();
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

<!-- Both transitions are `|global`: a local transition only plays when *this*
     `{#if}` toggles, but consumers may mount a Modal inside their own `{#if}`
     with `open={true}` and close it by destroying that block — which hard-cut
     the dialog away with no outro (Tines/153). -->
{#if open}
	<div
		class="fixed inset-0 z-50 bg-black/50"
		use:portal
		transition:fade|global={{ duration: dur() }}
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
		transition:scale|global={{ duration: dur(), start: 0.96 }}
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
