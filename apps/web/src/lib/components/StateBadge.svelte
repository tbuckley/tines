<script lang="ts">
	import type { WorkflowState } from '@tines/shared';
	import { categoryVar } from '$lib/format';

	let {
		state,
		showDot = true,
		class: className = ''
	}: {
		state: Pick<WorkflowState, 'name' | 'category'>;
		showDot?: boolean;
		class?: string;
	} = $props();
</script>

<span
	class="state-badge {className}"
	style="--cat: {categoryVar(state.category)}"
	title={state.category}
>
	{#if showDot}<span class="dot"></span>{/if}
	{state.name}
</span>
