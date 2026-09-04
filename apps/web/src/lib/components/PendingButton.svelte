<script lang="ts">
	import { Button, type ButtonProps } from '$lib/components/ui/button/index.js';
	import IconLoader2 from '@tabler/icons-svelte/icons/loader-2';
	import { cn } from '$lib/utils.js';

	let {
		pending = false,
		pendingLabel = 'Working…',
		disabled,
		class: className,
		children,
		...rest
	}: ButtonProps & {
		/** While true the label is hidden in place, a spinner takes its cell, and the button is disabled. */
		pending?: boolean;
		/** Screen-reader-only text while pending (the visible label is hidden). */
		pendingLabel?: string;
	} = $props();
</script>

<!-- One grid cell holds both layers, so the box is sized by the label in every
     state and the swap to the spinner cannot reflow the row it sits in
     (Tines/153). `max-w-full` + `truncate` cap a label longer than the row —
     transition names are user-authored and unbounded. -->
<Button
	{...rest}
	class={cn('inline-grid max-w-full', className)}
	disabled={disabled || pending}
	aria-busy={pending || undefined}
>
	<span
		class="inline-flex min-w-0 items-center justify-center gap-2 truncate [grid-area:1/1]"
		class:invisible={pending}
		aria-hidden={pending || undefined}
	>
		{@render children?.()}
	</span>
	{#if pending}
		<span class="inline-flex items-center justify-center [grid-area:1/1]">
			<IconLoader2 class="animate-spin motion-reduce:[animation-duration:1.5s]" />
			<span class="sr-only">{pendingLabel}</span>
		</span>
	{/if}
</Button>
