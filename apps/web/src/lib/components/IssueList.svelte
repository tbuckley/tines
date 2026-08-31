<script lang="ts">
	import type { Issue, IssueLabel, IssueRef } from '@tines/shared';
	import IconAlertTriangle from '@tabler/icons-svelte/icons/alert-triangle';
	import IconBan from '@tabler/icons-svelte/icons/ban';
	import IconCopy from '@tabler/icons-svelte/icons/copy';
	import IconRepeat from '@tabler/icons-svelte/icons/repeat';
	import { flip } from 'svelte/animate';
	import { fade } from 'svelte/transition';
	import { goto } from '$app/navigation';
	import LabelChip from '$lib/components/LabelChip.svelte';
	import StateBadge from '$lib/components/StateBadge.svelte';
	import { prefersReducedMotion, relativeTime } from '$lib/format';

	let {
		issues,
		showProject = true,
		emptyMessage = 'No issues here.'
	}: { issues: Issue[]; showProject?: boolean; emptyMessage?: string } = $props();

	const dur = () => (prefersReducedMotion() ? 0 : 220);

	const refLabel = (ref: IssueRef) => `${ref.project_name}/${ref.number} — ${ref.title}`;

	/**
	 * A row is one line at every width: the title truncates and everything after
	 * it holds its size, so labels can never grow a row taller. That makes the
	 * chip budget width-dependent — one chip on a phone, three from `sm` up.
	 * Both variants are rendered and CSS picks, so there is no matchMedia and no
	 * hydration mismatch. The full set always lives on the detail page.
	 */
	const MAX_CHIPS_NARROW = 1;
	const MAX_CHIPS = 3;

	/** "urgent, backend" — what the "+N" is standing in for. */
	const hiddenTooltip = (labels: IssueLabel[], shown: number) =>
		labels
			.slice(shown)
			.map((l) => l.name)
			.join(', ');

	/** "Blocked by demo/3 — Fix schema review; web/5 — Login broken". */
	const blockedTooltip = (blockers: IssueRef[]) =>
		`Blocked by ${blockers.map(refLabel).join('; ')}`;
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
					class="hover:bg-accent/50 flex items-center gap-3 px-4 py-3 transition-[opacity,background-color] duration-200 {issue.duplicate_of
						? 'opacity-60'
						: ''}"
				>
					<span class="text-muted-foreground w-12 shrink-0 font-mono text-xs">#{issue.number}</span>
					<!-- One line, never two: the title is the only thing that shrinks,
					     every chip after it is `shrink-0`. -->
					<span class="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-sm font-medium">
						<!-- The transition snapshot hugs the text instead of the
						     full-width cell, so the shared-element morph to the detail
						     heading keeps its proportions. -->
						<span
							class="vt-shared truncate"
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
								class="text-muted-foreground hover:text-foreground inline-flex shrink-0"
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
						{#each issue.labels.slice(0, MAX_CHIPS) as label, i (label.id)}
							<LabelChip
								{label}
								size="sm"
								class="max-w-28 shrink-0 truncate {i < MAX_CHIPS_NARROW ? '' : 'hidden sm:inline-flex'}"
							/>
						{/each}
						{#if issue.labels.length > MAX_CHIPS_NARROW}
							<span
								class="text-muted-foreground shrink-0 text-[0.6875rem] font-medium sm:hidden"
								title={hiddenTooltip(issue.labels, MAX_CHIPS_NARROW)}
							>
								+{issue.labels.length - MAX_CHIPS_NARROW}
							</span>
						{/if}
						{#if issue.labels.length > MAX_CHIPS}
							<span
								class="text-muted-foreground hidden shrink-0 text-[0.6875rem] font-medium sm:inline"
								title={hiddenTooltip(issue.labels, MAX_CHIPS)}
							>
								+{issue.labels.length - MAX_CHIPS}
							</span>
						{/if}
						<!-- Link markers are informational (title tooltip), never nested
						     links: the row itself already navigates. -->
						{#if issue.open_blockers.length > 0}
							<span
								class="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[0.6875rem] leading-none font-medium text-amber-700 dark:text-amber-400"
								title={blockedTooltip(issue.open_blockers)}
								transition:fade={{ duration: dur() }}
							>
								<IconBan size={12} stroke={1.75} />
								{issue.open_blockers.length}
							</span>
						{/if}
						{#if issue.duplicate_of}
							<span
								class="bg-muted text-muted-foreground inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.6875rem] leading-none font-medium"
								title="Duplicate of {refLabel(issue.duplicate_of)}"
								transition:fade={{ duration: dur() }}
							>
								<IconCopy size={12} stroke={1.75} />
								dup
							</span>
						{/if}
						<!-- The supervisor's two markers: "given up, needs you" and
						     "being worked right now" must never look alike. -->
						{#if issue.needs_attention}
							<span
								class="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[0.6875rem] leading-none font-medium text-amber-700 dark:text-amber-400"
								title="Parked — agents struck out {issue.attempt_count} time{issue.attempt_count === 1 ? '' : 's'}; needs attention"
								transition:fade={{ duration: dur() }}
							>
								<IconAlertTriangle size={12} stroke={1.75} />
								parked
							</span>
						{/if}
						{#if issue.active_run}
							<span
								class="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[0.6875rem] leading-none font-medium text-emerald-700 dark:text-emerald-400"
								title="{issue.active_run.runner_name} is on it ({issue.active_run.status})"
								transition:fade={{ duration: dur() }}
							>
								<span class="size-1.5 animate-pulse rounded-full bg-emerald-500"></span>
								{issue.active_run.runner_name}
							</span>
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
						<!-- Effective state: a duplicate displays its canonical issue's
						     state, so lists and the detail header always agree. -->
						<StateBadge state={issue.effective_state} />
					</span>
					<span class="text-muted-foreground hidden w-20 shrink-0 text-right text-xs md:inline" title={new Date(issue.last_activity_at).toLocaleString()}>
						{relativeTime(issue.last_activity_at)}
					</span>
				</a>
			</li>
		{/each}
	</ul>
{/if}
