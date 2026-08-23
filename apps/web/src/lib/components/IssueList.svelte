<script lang="ts">
	import type { Issue } from '@tines/shared';
	import IconRepeat from '@tabler/icons-svelte/icons/repeat';
	import { flip } from 'svelte/animate';
	import { fade } from 'svelte/transition';
	import { goto } from '$app/navigation';
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
					<span class="min-w-0 flex-1 text-sm font-medium">
						<!-- Inner inline-block: the transition snapshot hugs the text
						     instead of the full-width cell, so the shared-element
						     morph to the detail heading keeps its proportions. -->
						<span
							class="vt-shared inline-block max-w-full truncate align-middle"
							style:view-transition-name="issue-title-{issue.id}"
							style:view-transition-class="vt-fit"
						>
							{issue.title}
						</span>
						{#if issue.scheduled_task_id}
							<!-- Nested anchors are invalid inside the row link, so the
							     badge navigates via a button. -->
							<button
								type="button"
								class="text-muted-foreground hover:text-foreground ml-1.5 inline-flex align-middle"
								title="From schedule “{issue.scheduled_task_name}”"
								aria-label="From schedule {issue.scheduled_task_name}"
								onclick={(e) => {
									e.preventDefault();
									e.stopPropagation();
									goto(`/projects/${issue.project_id}?schedule=${issue.scheduled_task_id}`);
								}}
							>
								<IconRepeat size={14} stroke={1.75} />
							</button>
						{/if}
					</span>
					{#if showProject}
						<span class="text-muted-foreground hidden shrink-0 text-xs sm:inline">{issue.project_name}</span>
					{/if}
					<span
						class="vt-shared"
						style:view-transition-name="issue-state-{issue.id}"
						style:view-transition-class="vt-fit"
					>
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
