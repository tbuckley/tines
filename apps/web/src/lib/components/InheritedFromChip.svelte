<script lang="ts">
	import type { InheritedFrom } from '@tines/shared';
	import IconHierarchy from '@tabler/icons-svelte/icons/hierarchy';
	import { chipClass, textClass } from '$lib/chip-classes';

	/**
	 * "via <workflow> / <state>" — the base an inherited layer reached this
	 * issue through (Tines/238's `inherited_from`). Dashed, because it names a
	 * state the item is *not* scoped to: the scope chip beside it already says
	 * where the item lives.
	 */
	let { from, link = false }: { from: InheritedFrom; link?: boolean } = $props();

	const label = $derived(`${from.workflow_name} / ${from.state_name}`);
	const title = $derived(
		`inherited from state ${from.state_name} (workflow “${from.workflow_name}”)`
	);
	const dashed = `${chipClass} border border-dashed bg-transparent`;
</script>

{#if link}
	<a
		href="/workflows/{from.workflow_id}#state-{from.state_id}"
		class="{dashed} hover:text-foreground"
		{title}
	>
		<IconHierarchy size={12} stroke={1.75} class="shrink-0" />
		<span class={textClass}>via {label}</span>
	</a>
{:else}
	<span class={dashed} {title}>
		<IconHierarchy size={12} stroke={1.75} class="shrink-0" />
		<span class={textClass}>via {label}</span>
	</span>
{/if}
