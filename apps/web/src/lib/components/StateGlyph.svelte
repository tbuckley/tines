<script lang="ts">
	import type { StateCategory } from '@tines/shared';

	/**
	 * A workflow state's category as a shape, in the category colour: dashed
	 * ring (backlog), half-filled ring (active), ring with a centre dot
	 * (awaiting a human), filled check (done). The shape carries the category
	 * on its own, so a row reads without relying on colour alone; the text
	 * beside it carries the state's name.
	 */
	let {
		category,
		size = 14,
		class: className = ''
	}: { category: StateCategory; size?: number; class?: string } = $props();
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 14 14"
	class="shrink-0 {className}"
	aria-hidden="true"
	focusable="false"
>
	{#if category === 'done'}
		<circle cx="7" cy="7" r="6" fill="currentColor" />
		<path
			d="M4.3 7.2l1.8 1.8 3.7-3.8"
			fill="none"
			stroke="var(--background)"
			stroke-width="1.6"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
	{:else if category === 'active'}
		<circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5" />
		<path d="M7 7V2.2A4.8 4.8 0 0 1 7 11.8Z" fill="currentColor" />
	{:else if category === 'awaiting_human'}
		<circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5" />
		<circle cx="7" cy="7" r="2.2" fill="currentColor" />
	{:else}
		<circle
			cx="7"
			cy="7"
			r="5.5"
			fill="none"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-dasharray="2.4 2"
		/>
	{/if}
</svg>
