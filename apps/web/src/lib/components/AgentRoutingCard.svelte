<script lang="ts">
	import type { RoutingRule } from '@tines/shared';
	import IconRobot from '@tabler/icons-svelte/icons/robot';
	import RoutingRuleRow from '$lib/components/RoutingRuleRow.svelte';

	/**
	 * The inline "agent routing" rows on project and workflow-state detail
	 * surfaces: the rules that would apply there, with a link to the Agents
	 * tab where they are edited.
	 */
	let {
		rules,
		activeStateIds,
		emptyMessage = 'No routing rule applies here — issues will not dispatch to agents.'
	}: {
		rules: RoutingRule[];
		/** Ids of active-category states, for the "never dispatches" warning on dead rules. */
		activeStateIds: Set<string>;
		emptyMessage?: string;
	} = $props();
</script>

<div class="mb-8">
	<div class="mb-3 flex items-center justify-between">
		<h2 class="flex items-center gap-1.5 text-sm font-semibold">
			<IconRobot size={16} stroke={1.75} /> Agent routing
		</h2>
		<a href="/agents" class="text-muted-foreground hover:text-foreground text-xs"
			>Edit on the Agents tab</a
		>
	</div>
	{#if rules.length === 0}
		<div class="text-muted-foreground rounded-lg border border-dashed p-4 text-center text-sm">
			{emptyMessage}
		</div>
	{:else}
		<ul class="divide-y rounded-lg border">
			{#each rules as rule (rule.id)}
				<RoutingRuleRow {rule} {activeStateIds} />
			{/each}
		</ul>
	{/if}
</div>
