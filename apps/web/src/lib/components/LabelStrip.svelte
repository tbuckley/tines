<script lang="ts">
	import type { IssueLabel } from '@tines/shared';
	import LabelChip from '$lib/components/LabelChip.svelte';
	import { labelColorVar } from '$lib/format';

	let { labels, class: className = '' }: { labels: IssueLabel[]; class?: string } = $props();

	/**
	 * A row's labels, whole or counted: every chip when they all fit the width
	 * the row gives the strip, otherwise one chip — the first few colours as
	 * stacked dots and "N labels" — with the names in its tooltip. Never a chip
	 * cut mid-name, and never an arbitrary subset (which label survives a
	 * "c1 +4" is noise; the count is the information). The full set always
	 * lives on the detail page.
	 *
	 * Two things keep the decision stable. The measurement copy of the full set
	 * is *in flow* (invisible, stacked under the visible row in a one-cell
	 * grid), so the strip's natural width is always the full set's, whatever
	 * is currently shown — measuring the visible row would feed each decision
	 * into the next. And the collapsed chip's width becomes the strip's
	 * `min-width`, so a flex row can squeeze the strip down to it and no
	 * further: the chip is never clipped, and what the row does with the
	 * remaining overflow (truncating the title, say) is the row's call.
	 */
	let stripEl: HTMLElement | undefined = $state();
	let measureEl: HTMLElement | undefined = $state();

	/** The full set's natural width, and the collapsed chip's. */
	let allWidth = $state(0);
	let collapsedWidth = $state(0);
	let stripWidth = $state(0);

	// Pre-measurement (SSR, first paint): render them all and let the strip
	// clip. The decision settles on the first frame after mount.
	const collapsed = $derived(stripWidth > 0 && allWidth > 0 && allWidth > stripWidth);

	const names = $derived(labels.map((l) => l.name).join(', '));
	/** Up to four colours, in label order, for the stacked dots. */
	const dots = $derived(labels.slice(0, 4).map((l) => labelColorVar(l.color)));

	const remeasure = () => {
		if (!stripEl || !measureEl) return;
		const children = [...measureEl.children] as HTMLElement[];
		// The measurement row is the full set of chips, then the collapsed chip.
		const chips = children.slice(0, -1).map((el) => el.getBoundingClientRect().width);
		const gap = parseFloat(getComputedStyle(measureEl).columnGap) || 0;
		allWidth = chips.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, chips.length - 1);
		collapsedWidth = children.at(-1)?.getBoundingClientRect().width ?? 0;
		stripWidth = stripEl.clientWidth;
	};

	$effect(() => {
		// Re-read whenever the set changes; a rename changes a width too.
		labels;
		if (!stripEl) return;
		remeasure();
		const observer = new ResizeObserver(remeasure);
		// The strip's own width is what the row hands it, so watch that —
		// including the jump from `display: none` to visible at a breakpoint.
		observer.observe(stripEl);
		// A late web font resizes every chip under us.
		void document.fonts?.ready.then(remeasure);
		return () => observer.disconnect();
	});
</script>

{#snippet stack()}
	<span
		class="bg-background text-muted-foreground inline-flex h-5 items-center gap-1.5 rounded-full border px-1.5 text-[0.6875rem] leading-none font-medium whitespace-nowrap"
		title={names}
	>
		<span class="flex items-center">
			{#each dots as color, i (i)}
				<span
					class="ring-background size-[7px] rounded-full ring-[1.5px] {i > 0 ? '-ml-[3px]' : ''}"
					style="background: {color}"
				></span>
			{/each}
		</span>
		{labels.length}
		{labels.length === 1 ? 'label' : 'labels'}
	</span>
{/snippet}

<div
	bind:this={stripEl}
	data-testid="label-strip"
	class="grid min-w-0 overflow-hidden {className}"
	style:grid-template-columns="minmax(0, 1fr)"
	style:min-width={collapsedWidth > 0 ? `${collapsedWidth}px` : undefined}
>
	<!-- The visible row comes first in the DOM, so a text lookup finds what
	     renders before the measurement copy of the same names. -->
	<div class="col-start-1 row-start-1 flex min-w-0 items-center justify-end gap-1.5">
		{#if collapsed}
			{@render stack()}
		{:else}
			{#each labels as label (label.id)}
				<LabelChip {label} variant="dot" class="shrink-0" />
			{/each}
		{/if}
	</div>
	<!-- In flow but invisible: this row sets the strip's natural width (the
	     full set) and costs no height of its own, since it shares the visible
	     row's grid cell. -->
	<div
		bind:this={measureEl}
		aria-hidden="true"
		class="pointer-events-none invisible relative col-start-1 row-start-1 flex min-w-0 items-center gap-1.5"
	>
		{#each labels as label (label.id)}
			<LabelChip {label} variant="dot" class="shrink-0" />
		{/each}
		<!-- Out of flow, so the collapsed chip is measured without adding its
		     width to the strip's natural size. -->
		<span class="absolute top-0 left-0">{@render stack()}</span>
	</div>
</div>
