<script lang="ts">
	import type { IssueLabel } from '@tines/shared';
	import LabelChip from '$lib/components/LabelChip.svelte';

	let {
		labels,
		class: className = ''
	}: { labels: IssueLabel[]; class?: string } = $props();

	/** `gap-1.5`, in px — the gap the strip lays its chips out with. */
	const GAP = 6;

	let stripEl: HTMLElement | undefined = $state();
	let measureEl: HTMLElement | undefined = $state();

	/**
	 * Natural widths of every chip plus the "+N", read off the out-of-flow copy
	 * below. Measuring a separate row is what keeps this stable: the visible row
	 * only holds the chips that fit, so measuring *it* would feed the result of
	 * the last calculation back into the next one.
	 */
	let chipWidths: number[] = $state([]);
	let overflowWidth = $state(0);
	let stripWidth = $state(0);

	/**
	 * How many chips fit whole on one line. When any are left over, room for the
	 * "+N" is reserved as well — so a single label too wide for the row shows as
	 * a bare "+1" rather than a chip clipped mid-name.
	 */
	const visibleCount = $derived.by(() => {
		// Pre-measurement (SSR, first paint): render them all and let the strip
		// clip. The count settles on the first frame after mount.
		if (stripWidth === 0 || chipWidths.length !== labels.length) return labels.length;
		const all = chipWidths.reduce((sum, w) => sum + w, 0) + GAP * (labels.length - 1);
		if (all <= stripWidth) return labels.length;
		let used = 0;
		for (let i = 0; i < labels.length; i++) {
			const next = used + (i === 0 ? 0 : GAP) + chipWidths[i];
			if (next + GAP + overflowWidth > stripWidth) return i;
			used = next;
		}
		return labels.length;
	});
	const hiddenCount = $derived(labels.length - visibleCount);

	const remeasure = () => {
		if (!stripEl || !measureEl) return;
		const widths = [...measureEl.children].map((el) => el.getBoundingClientRect().width);
		// The measurement row ends with the "+N"; everything before it is a chip.
		overflowWidth = widths.pop() ?? 0;
		chipWidths = widths;
		stripWidth = stripEl.clientWidth;
	};

	$effect(() => {
		// Re-read whenever the set changes; a rename changes a width too.
		labels;
		if (!stripEl) return;
		remeasure();
		const observer = new ResizeObserver(remeasure);
		// Widths only change with the strip's own width — including the jump from
		// `display: none` to visible when the viewport crosses `sm`.
		observer.observe(stripEl);
		// A late web font resizes every chip under us.
		void document.fonts?.ready.then(remeasure);
		return () => observer.disconnect();
	});
</script>

<div
	bind:this={stripEl}
	data-testid="label-strip"
	class="relative flex min-w-0 items-center gap-1.5 overflow-hidden {className}"
>
	<!-- Out of flow (`absolute`), so it costs no width and no height: this is
	     the full set at natural size, purely to be measured. -->
	<div
		bind:this={measureEl}
		aria-hidden="true"
		class="pointer-events-none invisible absolute top-0 left-0 flex items-center gap-1.5"
	>
		{#each labels as label (label.id)}
			<LabelChip {label} size="sm" />
		{/each}
		<span class="bg-muted text-muted-foreground rounded-full px-1.5 py-0.5 text-[0.6875rem] leading-none font-medium">+{labels.length}</span>
	</div>
	{#each labels.slice(0, visibleCount) as label (label.id)}
		<LabelChip {label} size="sm" class="shrink-0" />
	{/each}
	{#if hiddenCount > 0}
		<span
			class="bg-muted text-muted-foreground rounded-full px-1.5 py-0.5 text-[0.6875rem] leading-none font-medium shrink-0"
			title={labels
				.slice(visibleCount)
				.map((l) => l.name)
				.join(', ')}
		>
			+{hiddenCount}
		</span>
	{/if}
</div>
