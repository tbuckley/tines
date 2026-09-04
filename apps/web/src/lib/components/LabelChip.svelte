<script lang="ts">
	import IconX from '@tabler/icons-svelte/icons/x';
	import type { IssueLabel } from '@tines/shared';
	import { labelColorVar } from '$lib/format';

	let {
		label,
		size = 'md',
		onremove,
		removeBusy = false,
		class: className = ''
	}: {
		label: Pick<IssueLabel, 'name' | 'color'>;
		size?: 'sm' | 'md';
		/** When set, the chip grows an inline remove button. */
		onremove?: () => void;
		removeBusy?: boolean;
		class?: string;
	} = $props();
</script>

<!-- Same pill as StateBadge: `.state-badge` renders entirely from `--cat`, so
     pointing it at a `--label-*` token gets correct dark mode for free. -->
<span
	class="state-badge {size === 'sm' ? 'px-1.5 py-0.5 text-[0.6875rem]' : ''} {className}"
	style="--cat: {labelColorVar(label.color)}"
>
	<!-- The name owns the overflow so a `max-w-*` on the chip ellipses the text
	     instead of clipping the pill mid-letter. -->
	<span class="truncate">{label.name}</span>
	{#if onremove}
		<button
			type="button"
			class="-mr-0.5 opacity-60 transition-opacity hover:opacity-100 disabled:opacity-30"
			aria-label="Remove label {label.name}"
			disabled={removeBusy}
			onclick={(e) => {
				e.preventDefault();
				e.stopPropagation();
				onremove?.();
			}}
		>
			<IconX size={size === 'sm' ? 11 : 13} stroke={2.25} />
		</button>
	{/if}
</span>
