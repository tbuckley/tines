<script lang="ts">
	import { Dialog } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import IconX from '@tabler/icons-svelte/icons/x';
	import { backgroundInert } from '$lib/components/background-inert.svelte';

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

	let closeButton = $state<HTMLButtonElement | null>(null);
	let releaseInert: (() => void) | null = null;

	// Every close path (X, Escape, click outside) lands here: several consumers
	// pass `open={true}` unbound and unmount on `onclose` alone. The inert
	// release is synchronous rather than an `$effect` cleanup so the background
	// is focusable again by the time bits-ui restores focus to the opener.
	function onOpenChange(next: boolean) {
		if (next) {
			releaseInert ??= backgroundInert.acquire();
		} else {
			releaseInert?.();
			releaseInert = null;
			onclose?.();
		}
	}

	// Consumers that mount with `open={true}` never fire `onOpenChange` for the
	// initial open, and navigating away can destroy the modal without one.
	$effect(() => {
		if (!open) return;
		releaseInert ??= backgroundInert.acquire();
		return () => {
			releaseInert?.();
			releaseInert = null;
		};
	});
</script>

<!-- Renders into <body> (bits-ui's default portal target): the layout's <main>
     carries a view-transition-name, which makes it a stacking context, so no
     z-index inside it can paint above the app's sticky header / bottom tab bar
     (z-40 siblings of <main>). -->
<Dialog.Root bind:open {onOpenChange}>
	<Dialog.Portal>
		<Dialog.Overlay
			class="data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 z-50 bg-black/50 duration-150"
		/>
		<!-- Anchored near the top on phones so the on-screen keyboard doesn't cover
		     the dialog's fields; centered on larger screens. A column of a fixed
		     header and one scrolling body: content of any length scrolls under a
		     close button that is always on screen. -->
		<Dialog.Content
			class="bg-background data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 fixed top-4 left-1/2 z-50 flex w-[calc(100%-2rem)] {size ===
			'xl'
				? 'max-w-4xl'
				: 'max-w-md'} -translate-x-1/2 flex-col overflow-hidden rounded-xl border shadow-lg duration-150 sm:top-1/2 sm:-translate-y-1/2"
			style="max-height: calc(100dvh - 2rem - env(safe-area-inset-bottom, 0px))"
			onOpenAutoFocus={(e) => {
				// bits-ui would focus the first tabbable element; park focus on the
				// close button instead, so the exit is the first thing a keyboard or
				// screen-reader user meets (Tines/28).
				e.preventDefault();
				requestAnimationFrame(() => closeButton?.focus({ preventScroll: true }));
			}}
		>
			<div class="flex shrink-0 items-start justify-between gap-3 px-6 pt-5 pb-3">
				<Dialog.Title class="text-lg font-semibold">{title}</Dialog.Title>
				<Dialog.Close
					bind:ref={closeButton}
					class="text-muted-foreground hover:text-foreground hover:bg-muted -mt-1 -mr-2 inline-flex size-9 shrink-0 items-center justify-center rounded-md"
					aria-label="Close"
				>
					<IconX size={18} />
				</Dialog.Close>
			</div>
			<div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-6">
				{@render children()}
			</div>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
