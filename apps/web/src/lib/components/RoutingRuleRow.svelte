<script lang="ts">
	import type { RoutingRuleWithWarnings, ShadowWarning } from '@tines/shared';
	import IconArrowRight from '@tabler/icons-svelte/icons/arrow-right';
	import ContextScopeChips from '$lib/components/ContextScopeChips.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { queueAge } from '$lib/format';

	/**
	 * The one routing-rule row, shared by every surface that lists rules (the
	 * Agents tab, and the project / workflow detail cards). Every warning a
	 * rule carries is unconditional here; only the edit affordances are
	 * contextual, so the read-only surfaces cannot fall behind again.
	 *
	 * The parent owns the surrounding `<ul class="divide-y rounded-lg border">`.
	 */
	let {
		rule,
		activeStateIds,
		projectArchived = false,
		waiting,
		onedit,
		ondelete
	}: {
		rule: RoutingRuleWithWarnings;
		/**
		 * Ids of active-category states. Required rather than optional: every
		 * surface has the workflows to hand, and a default would silently drop
		 * the "never dispatches" warning.
		 */
		activeStateIds: Set<string>;
		/** The rule is scoped to a project that is archived — kept, editable, never matching. */
		projectArchived?: boolean;
		/**
		 * Eligible issues this rule matches that are waiting for an agent, from
		 * the Now row's queue (Tines/256). Omitted → nothing renders, so the
		 * read-only surfaces are unaffected.
		 */
		waiting?: { count: number; oldest: number; href: string };
		/** Omitted → read-only row (no Edit button). */
		onedit?: (rule: RoutingRuleWithWarnings) => void;
		/** Omitted → read-only row (no Delete button). */
		ondelete?: (rule: RoutingRuleWithWarnings) => void;
	} = $props();

	/** Scoped to a state that is no longer active — the rule can never match. */
	const dead = $derived(
		rule.scope.workflow_state_id !== null && !activeStateIds.has(rule.scope.workflow_state_id)
	);

	/**
	 * One pill per warning *kind*, not per warning: a broad rule can be
	 * shadowed by every rule above it, and four amber pills on one row is
	 * worse to read than the unsorted list this replaced. The names go in the
	 * pill while there is one of them, the count when there are more, and the
	 * server's full sentences always go in the tooltip.
	 */
	function pill(warnings: ShadowWarning[], verb: string) {
		if (warnings.length === 0) return null;
		return {
			text:
				warnings.length === 1
					? `${verb} ${warnings[0].scope_label}`
					: `${verb} ${warnings.length} rules`,
			title: warnings.map((w) => w.message).join('\n')
		};
	}

	const shadowed = $derived(
		pill(
			rule.warnings.filter((w) => w.kind === 'shadowed'),
			'shadowed by'
		)
	);
	const ties = $derived(
		pill(
			rule.warnings.filter((w) => w.kind === 'ambiguous'),
			'ties with'
		)
	);
</script>

<li class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-sm">
	<ContextScopeChips scope={rule.scope} />
	{#if waiting}
		<a
			class="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400"
			href={waiting.href}
			title="{waiting.count} eligible {waiting.count === 1
				? 'issue matches'
				: 'issues match'} this rule and are waiting for an agent"
		>
			{waiting.count} waiting · oldest {queueAge(waiting.oldest)}
		</a>
	{/if}
	{#if dead}
		<span
			class="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400"
			title="This state is no longer categorized active; agents only pick up issues in active states, so this rule never matches"
		>
			never dispatches
		</span>
	{/if}
	{#if projectArchived}
		<span
			class="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400"
			title="This project is archived — nothing dispatches on it. The rule is kept and matches again after unarchive."
		>
			project archived
		</span>
	{/if}
	{#each [ties, shadowed].filter((p) => p !== null) as p (p.text)}
		<span
			class="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400"
			title={p.title}
		>
			{p.text}
		</span>
	{/each}
	{#if rule.targets.length === 0}
		<span
			class="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400"
			title="A forced runner removal emptied this rule; add targets or delete it"
		>
			no targets
		</span>
	{:else}
		<span class="flex flex-wrap items-center gap-1">
			{#each rule.targets as target, i (target.runner_id + (target.tier ?? '') + i)}
				{#if i > 0}
					<IconArrowRight size={12} class="text-muted-foreground" />
				{/if}
				<span
					class="bg-muted rounded-full px-2 py-0.5 text-xs {target.runner_status === 'paused'
						? 'opacity-60'
						: ''}"
					title={target.runner_status === 'paused' ? 'paused' : undefined}
				>
					{target.runner_name}{target.tier ? `:${target.tier}` : ''}
				</span>
			{/each}
		</span>
	{/if}
	{#if onedit || ondelete}
		<span class="ml-auto flex gap-1">
			{#if onedit}
				<Button size="sm" variant="ghost" onclick={() => onedit(rule)}>Edit</Button>
			{/if}
			{#if ondelete}
				<Button size="sm" variant="ghost" class="text-destructive" onclick={() => ondelete(rule)}>
					Delete
				</Button>
			{/if}
		</span>
	{/if}
</li>
