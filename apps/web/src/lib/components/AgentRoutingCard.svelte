<script lang="ts">
	import type { RoutingRule } from '@tines/shared';
	import IconArrowRight from '@tabler/icons-svelte/icons/arrow-right';
	import IconRobot from '@tabler/icons-svelte/icons/robot';
	import ContextScopeChips from '$lib/components/ContextScopeChips.svelte';

	/**
	 * The inline "agent routing" rows on project and workflow-state detail
	 * surfaces: the rules that would apply there, with a link to the Agents
	 * tab where they are edited.
	 */
	let {
		rules,
		emptyMessage = 'No routing rule applies here — issues will not dispatch to agents.'
	}: { rules: RoutingRule[]; emptyMessage?: string } = $props();
</script>

<div class="mb-8">
	<div class="mb-3 flex items-center justify-between">
		<h2 class="flex items-center gap-1.5 text-sm font-semibold">
			<IconRobot size={16} stroke={1.75} /> Agent routing
		</h2>
		<a href="/agents" class="text-muted-foreground hover:text-foreground text-xs">Edit on the Agents tab</a>
	</div>
	{#if rules.length === 0}
		<div class="text-muted-foreground rounded-lg border border-dashed p-4 text-center text-sm">
			{emptyMessage}
		</div>
	{:else}
		<ul class="divide-y rounded-lg border">
			{#each rules as rule (rule.id)}
				<li class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
					<ContextScopeChips scope={rule.scope} />
					{#if rule.targets.length === 0}
						<span class="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
							no targets
						</span>
					{:else}
						<span class="flex flex-wrap items-center gap-1">
							{#each rule.targets as target, i (target.runner_id + (target.tier ?? '') + i)}
								{#if i > 0}
									<IconArrowRight size={12} class="text-muted-foreground" />
								{/if}
								<span class="bg-muted rounded-full px-2 py-0.5 text-xs {target.runner_status === 'paused' ? 'opacity-60' : ''}">
									{target.runner_name}{target.tier ? `:${target.tier}` : ''}
								</span>
							{/each}
						</span>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>
