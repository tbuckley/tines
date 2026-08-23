<script lang="ts">
	import type { Issue } from '@tines/shared';
	import { flip } from 'svelte/animate';
	import { fade } from 'svelte/transition';
	import StateBadge from '$lib/components/StateBadge.svelte';
	import { prefersReducedMotion, relativeTime } from '$lib/format';

	let {
		issues,
		showProject = true,
		emptyMessage = 'No issues here.'
	}: { issues: Issue[]; showProject?: boolean; emptyMessage?: string } = $props();

	const dur = () => (prefersReducedMotion() ? 0 : 220);
</script>

{#if issues.length === 0}
	<div class="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">
		{emptyMessage}
	</div>
{:else}
	<ul class="divide-y rounded-lg border">
		{#each issues as issue (issue.id)}
			<li animate:flip={{ duration: dur() }} in:fade={{ duration: dur() }}>
				<a
					href="/issues/{encodeURIComponent(issue.project_name)}/{issue.number}"
					class="hover:bg-accent/50 flex items-center gap-3 px-4 py-3 transition-colors"
				>
					<span class="text-muted-foreground w-12 shrink-0 font-mono text-xs">#{issue.number}</span>
					<span
						class="min-w-0 flex-1 truncate text-sm font-medium"
						style:view-transition-name="issue-title-{issue.id}"
					>
						{issue.title}
					</span>
					{#if showProject}
						<span class="text-muted-foreground hidden shrink-0 text-xs sm:inline">{issue.project_name}</span>
					{/if}
					<span style:view-transition-name="issue-state-{issue.id}">
						<StateBadge state={issue.state} />
					</span>
					<span class="text-muted-foreground hidden w-20 shrink-0 text-right text-xs md:inline" title={new Date(issue.last_activity_at).toLocaleString()}>
						{relativeTime(issue.last_activity_at)}
					</span>
				</a>
			</li>
		{/each}
	</ul>
{/if}
