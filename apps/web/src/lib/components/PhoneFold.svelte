<script lang="ts">
	import IconChevronRight from '@tabler/icons-svelte/icons/chevron-right';
	import type { Snippet } from 'svelte';

	/**
	 * A section that folds to one row on a phone and is simply itself from
	 * `sm` up. The row is the section's heading there — the card's own `h2`
	 * inside is hidden at that width — and carries a short summary (a count,
	 * a status) so a closed fold still says what it holds. Rendered closed on
	 * the server and opened by the reader; desktop never sees the row.
	 */
	let {
		title,
		summary = '',
		open = $bindable(false),
		children
	}: {
		title: string;
		summary?: string;
		open?: boolean;
		children: Snippet;
	} = $props();
</script>

<div class="min-w-0 max-sm:border-t">
	<button
		type="button"
		class="flex w-full items-center gap-2 py-3 text-left text-sm font-semibold sm:hidden"
		aria-expanded={open}
		onclick={() => (open = !open)}
	>
		<IconChevronRight
			size={14}
			stroke={2}
			class="text-muted-foreground shrink-0 transition-transform {open ? 'rotate-90' : ''}"
		/>
		{title}
		{#if summary}
			<span class="text-muted-foreground min-w-0 truncate font-normal">{summary}</span>
		{/if}
	</button>
	<!-- On a phone the fold row is the heading, so the card's own is hidden and
	     its border dropped: one list of rows, not cards inside a list. -->
	<div
		class="max-sm:pb-4 max-sm:[&_h2]:hidden max-sm:[&>section]:border-0 max-sm:[&>section]:p-0 {open
			? ''
			: 'max-sm:hidden'}"
	>
		{@render children()}
	</div>
</div>
