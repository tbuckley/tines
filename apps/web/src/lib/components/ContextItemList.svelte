<script lang="ts">
	import type { ContextItem, InheritedFrom } from '@tines/shared';
	import { slide } from 'svelte/transition';
	import ContextKindIcon from '$lib/components/ContextKindIcon.svelte';
	import ContextScopeChips from '$lib/components/ContextScopeChips.svelte';
	import { prefersReducedMotion, relativeTime } from '$lib/format';

	let {
		items,
		showScope = true,
		shortScope = false,
		emptyMessage = 'No context items.',
		inheritedFrom = null,
		linkInheritedFrom = false,
		onselect
	}: {
		items: ContextItem[];
		showScope?: boolean;
		/** Drop the workflow from the state chip, for lists already grouped by state. */
		shortScope?: boolean;
		emptyMessage?: string;
		/**
		 * Set when this whole list is a base's items, seen from a state that
		 * inherits them: every row gets the `via <workflow> / <state>` chip.
		 */
		inheritedFrom?: InheritedFrom | null;
		/** Link the inherited provenance chip to its base workflow state. */
		linkInheritedFrom?: boolean;
		/** Row click → open the editor. */
		onselect?: (item: ContextItem) => void;
	} = $props();

	const dur = () => (prefersReducedMotion() ? 0 : 180);

	function payloadSummary(item: ContextItem): string {
		if (item.kind === 'skill') {
			const n = item.file_count ?? item.files?.length ?? 0;
			return `${n} file${n === 1 ? '' : 's'}`;
		}
		if (item.kind === 'repo') {
			return `${item.repo_url}${item.repo_branch ? ` · ${item.repo_branch}` : ''}`;
		}
		return item.description;
	}
</script>

{#snippet rowContent(item: ContextItem)}
	<span class="text-muted-foreground shrink-0" title={item.kind}>
		<ContextKindIcon kind={item.kind} />
	</span>
	<span class="min-w-0 flex-1">
		<span class="flex items-center gap-2" class:flex-wrap={inheritedFrom !== null}>
			<span
				class="truncate font-medium"
				class:min-w-24={inheritedFrom !== null}
				class:flex-1={inheritedFrom !== null}>{item.name}</span
			>
			{#if showScope}
				<ContextScopeChips
					scope={item.scope}
					short={shortScope}
					{inheritedFrom}
					{linkInheritedFrom}
				/>
			{/if}
		</span>
		{#if payloadSummary(item)}
			<span class="text-muted-foreground block truncate text-xs">{payloadSummary(item)}</span>
		{/if}
	</span>
	<span
		class="text-muted-foreground shrink-0 text-xs"
		title={new Date(item.updated_at).toLocaleString()}
	>
		{relativeTime(item.updated_at)}
	</span>
{/snippet}

{#if items.length === 0}
	<div class="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
		{emptyMessage}
	</div>
{:else}
	<ul class="divide-y rounded-lg border">
		{#each items as item (item.id)}
			<li transition:slide={{ duration: dur() }}>
				{#if onselect && !linkInheritedFrom}
					<button
						type="button"
						class="hover:bg-muted/50 flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm"
						onclick={() => onselect(item)}
					>
						{@render rowContent(item)}
					</button>
				{:else}
					<div class="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm">
						{@render rowContent(item)}
					</div>
				{/if}
			</li>
		{/each}
	</ul>
{/if}
