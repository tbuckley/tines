<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * Long content held to a height until asked for. The toggle appears only
	 * when the content really overflows the cap — measured, so a short comment
	 * never grows a pointless "Show more" — and stays once opened so the
	 * reader can fold it back. With `phoneOnly`, the cap applies below `sm`
	 * and desktop shows everything, toggle-free.
	 */
	let {
		maxHeight,
		phoneOnly = false,
		children,
		class: className = ''
	}: {
		/** A CSS length, e.g. `24rem`. */
		maxHeight: string;
		phoneOnly?: boolean;
		children: Snippet;
		class?: string;
	} = $props();

	let el: HTMLElement | undefined = $state();
	let expanded = $state(false);
	/** Measured while clamped; irrelevant (but remembered) once expanded. */
	let overflows = $state(false);
	const showToggle = $derived(expanded || overflows);

	$effect(() => {
		if (!el) return;
		const measure = () => {
			if (!el || expanded) return;
			overflows = el.scrollHeight > el.clientHeight + 1;
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	});
</script>

<div class={className}>
	<div
		bind:this={el}
		class="relative {expanded
			? ''
			: phoneOnly
				? 'max-sm:max-h-(--clamp) max-sm:overflow-hidden'
				: 'max-h-(--clamp) overflow-hidden'}"
		style:--clamp={maxHeight}
	>
		{@render children()}
		{#if !expanded && overflows}
			<!-- A fade instead of a hard cut, so the clamp reads as "more below". -->
			<div
				class="from-background pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t to-transparent"
				aria-hidden="true"
			></div>
		{/if}
	</div>
	{#if showToggle}
		<button
			type="button"
			class="text-muted-foreground hover:text-foreground mt-1 text-xs underline underline-offset-2"
			aria-expanded={expanded}
			onclick={() => (expanded = !expanded)}
		>
			{expanded ? 'Show less' : 'Show more'}
		</button>
	{/if}
</div>
