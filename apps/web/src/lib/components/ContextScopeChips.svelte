<script lang="ts">
	import type { ContextScope } from '@tines/shared';
	import IconFolder from '@tabler/icons-svelte/icons/folder';
	import IconListDetails from '@tabler/icons-svelte/icons/list-details';
	import IconSitemap from '@tabler/icons-svelte/icons/sitemap';

	/**
	 * Compact chips for a scope, in the canonical project · state · issue
	 * order. `link` renders project/issue chips as links to their pages.
	 */
	let { scope, link = false }: { scope: ContextScope; link?: boolean } = $props();

	const chipClass =
		'bg-muted text-muted-foreground inline-flex max-w-48 items-center gap-1 truncate rounded-full px-2 py-0.5 text-xs';
</script>

<span class="inline-flex flex-wrap items-center gap-1">
	{#if scope.project_id}
		{#if link}
			<a href="/projects/{scope.project_id}" class="{chipClass} hover:text-foreground" title="project {scope.project_name}">
				<IconFolder size={12} stroke={1.75} /> {scope.project_name}
			</a>
		{:else}
			<span class={chipClass} title="project {scope.project_name}">
				<IconFolder size={12} stroke={1.75} /> {scope.project_name}
			</span>
		{/if}
	{/if}
	{#if scope.workflow_state_id}
		<span class={chipClass} title="state {scope.workflow_state_name} (workflow “{scope.workflow_name}”)">
			<IconSitemap size={12} stroke={1.75} /> {scope.workflow_state_name}
		</span>
	{/if}
	{#if scope.issue_id && scope.issue_ref}
		{#if link}
			<a
				href="/issues/{encodeURIComponent(scope.issue_ref.project_name)}/{scope.issue_ref.number}"
				class="{chipClass} hover:text-foreground"
				title="issue {scope.issue_ref.project_name}/{scope.issue_ref.number}"
			>
				<IconListDetails size={12} stroke={1.75} /> {scope.issue_ref.project_name}/{scope.issue_ref.number}
			</a>
		{:else}
			<span class={chipClass} title="issue {scope.issue_ref.project_name}/{scope.issue_ref.number}">
				<IconListDetails size={12} stroke={1.75} /> {scope.issue_ref.project_name}/{scope.issue_ref.number}
			</span>
		{/if}
	{/if}
</span>
