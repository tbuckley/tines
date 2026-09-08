<script lang="ts">
	import { ageLabel, type IssueListItem, type IssueRef } from '@tines/shared';
	import IconAlertTriangle from '@tabler/icons-svelte/icons/alert-triangle';
	import IconBan from '@tabler/icons-svelte/icons/ban';
	import IconCopy from '@tabler/icons-svelte/icons/copy';
	import IconRepeat from '@tabler/icons-svelte/icons/repeat';
	import { flip } from 'svelte/animate';
	import { fade } from 'svelte/transition';
	import { goto } from '$app/navigation';
	import { buttonVariants } from '$lib/components/ui/button';
	import LabelStrip from '$lib/components/LabelStrip.svelte';
	import StateGlyph from '$lib/components/StateGlyph.svelte';
	import {
		CATEGORY_LABELS,
		categoryVar,
		prefersReducedMotion,
		relativeTimeShort
	} from '$lib/format';

	let {
		issues,
		showProject = true,
		emptyMessage = 'No issues here.',
		emptyAction
	}: {
		issues: IssueListItem[];
		showProject?: boolean;
		emptyMessage?: string;
		/** The next step, when the empty list has one — rendered as a link under the message. */
		emptyAction?: { label: string; href: string };
	} = $props();

	const dur = () => (prefersReducedMotion() ? 0 : 220);

	const refLabel = (ref: IssueRef) => `${ref.project_name}/#${ref.number} — ${ref.title}`;

	/** "Blocked by demo/#3 — Fix schema review; web/#5 — Login broken". */
	const blockedTooltip = (blockers: IssueRef[]) =>
		`Blocked by ${blockers.map(refLabel).join('; ')}`;

	const hasSignal = (issue: IssueListItem) =>
		issue.scheduled_task_id !== null ||
		issue.open_blockers.length > 0 ||
		issue.duplicate_of !== null ||
		issue.needs_attention ||
		issue.active_run !== null;
	const prNumber = (url: string) => url.split('/').at(-1);

	/**
	 * The row, in reading order: state, ref, title, then what the eye needs
	 * only after the title — signals, labels, time. The title has first claim
	 * on width; the label strip yields to a count before the title loses a
	 * character (see `LabelStrip`).
	 *
	 * On a phone the title is the whole first line, wrapping to two, and the
	 * rest share one metadata line beneath it. From `sm` up the metadata
	 * wrapper dissolves (`sm:contents`) and its children take their places in
	 * one 40px line via `order`, so one DOM serves both layouts with no
	 * matchMedia and no hydration mismatch.
	 */
</script>

{#if issues.length === 0}
	<div class="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">
		{emptyMessage}
		{#if emptyAction}
			<div class="mt-3">
				<a href={emptyAction.href} class={buttonVariants({ variant: 'outline', size: 'sm' })}>
					{emptyAction.label}
				</a>
			</div>
		{/if}
	</div>
{:else}
	<ul class="divide-y rounded-lg border">
		{#each issues as issue (issue.id)}
			{@const state = issue.effective_state}
			<li animate:flip={{ duration: dur() }} in:fade={{ duration: dur() }}>
				<a
					href="/issues/{encodeURIComponent(issue.project_name)}/{issue.number}"
					class="hover:bg-accent/50 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 transition-[opacity,background-color] duration-200 {state.category ===
					'awaiting_human'
						? 'sm:min-h-17 sm:py-2'
						: 'sm:h-10 sm:flex-nowrap sm:py-0'} {issue.duplicate_of ? 'opacity-60' : ''}"
				>
					<span class="w-full min-w-0 text-sm font-medium sm:order-3 sm:w-auto sm:flex-[1_1_auto]">
						<!-- The transition name sits on the text itself: on desktop an
						     inline-block that hugs the title, so the morph to the detail
						     heading keeps its proportions. -->
						<span
							class="vt-shared title"
							style:view-transition-name="issue-title-{issue.id}"
							style:view-transition-class="vt-fit"
							title={issue.title}
						>
							{issue.title}
						</span>
					</span>
					<!-- A fixed 20px line on a phone: the chips are 20px too, so a label
				     costs a row no height. -->
					<div
						class="flex w-full min-w-0 items-center gap-x-3 overflow-hidden max-sm:h-5 sm:contents"
					>
						<!-- Effective state: a duplicate displays its canonical issue's
						     state, so lists and the detail header always agree. The
						     category shows as a shape, the name as text; a fixed column
						     on desktop keeps every title starting at the same x. -->
						<span
							class="vt-shared flex min-w-0 shrink items-center gap-1.5 text-xs font-medium max-sm:max-w-36 sm:order-1 sm:w-28 sm:shrink-0"
							style:color={categoryVar(state.category)}
							style:view-transition-name="issue-state-{issue.id}"
							style:view-transition-class="vt-fit"
							title="{state.name} · {CATEGORY_LABELS[state.category] ?? state.category}"
						>
							<StateGlyph category={state.category} />
							<span class="truncate">{state.name}</span>
						</span>
						<!-- The ref the rest of the app uses (project/#number); the
						     project drops out when every row would repeat it. -->
						<span
							class="text-muted-foreground flex min-w-0 shrink-0 font-mono text-xs tabular-nums sm:order-2 sm:w-20"
						>
							{#if showProject}
								<span class="truncate">{issue.project_name}/</span>
							{/if}
							<span class="shrink-0">#{issue.number}</span>
							{#if showProject && issue.project_archived_at !== null}
								<span
									class="bg-muted text-muted-foreground ml-1 shrink-0 rounded-full px-1.5 py-px font-sans text-[0.625rem] font-medium"
									title="Project archived"
								>
									archived
								</span>
							{/if}
						</span>
						{#if hasSignal(issue)}
							<!-- Signals are informational (tooltips), never nested links:
							     the row itself already navigates. The supervisor's two
							     markers, "given up, needs you" and "being worked right
							     now", must never look alike. -->
							<span
								class="flex shrink-0 items-center gap-2.5 text-[0.6875rem] leading-none font-medium sm:order-4"
							>
								{#if issue.scheduled_task_id}
									<!-- Nested anchors are invalid inside the row link, so
									     the badge navigates via a button. -->
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
										<IconRepeat size={13} stroke={2} />
									</button>
								{/if}
								{#if issue.open_blockers.length > 0}
									<span
										class="inline-flex shrink-0 items-center gap-1 text-amber-700 dark:text-amber-400"
										title={blockedTooltip(issue.open_blockers)}
										transition:fade={{ duration: dur() }}
									>
										<IconBan size={13} stroke={2} />
										{issue.open_blockers.length}
									</span>
								{/if}
								{#if issue.duplicate_of}
									<span
										class="text-muted-foreground inline-flex shrink-0 items-center gap-1"
										title="Duplicate of {refLabel(issue.duplicate_of)}"
										transition:fade={{ duration: dur() }}
									>
										<IconCopy size={13} stroke={2} />
										dup
									</span>
								{/if}
								{#if issue.needs_attention}
									<span
										class="inline-flex shrink-0 items-center gap-1 text-amber-700 dark:text-amber-400"
										title="Parked — agents struck out {issue.attempt_count} time{issue.attempt_count ===
										1
											? ''
											: 's'}; needs attention"
										transition:fade={{ duration: dur() }}
									>
										<IconAlertTriangle size={13} stroke={2} />
										parked
									</span>
								{/if}
								{#if issue.active_run}
									<span
										class="inline-flex max-w-28 shrink-0 items-center gap-1.5 text-emerald-700 dark:text-emerald-400"
										title="{issue.active_run.runner_name} is on it ({issue.active_run.status})"
										transition:fade={{ duration: dur() }}
									>
										<span class="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500"
										></span>
										<span class="truncate">{issue.active_run.runner_name}</span>
									</span>
								{/if}
							</span>
						{/if}
						<!-- Labels, then the time, hugging the right edge. The strip
						     grows from nothing into the line's free space (never shrinking
						     the state name by a subpixel into an ellipsis), floored at its
						     collapsed chip and capped at the full set, both measured. On
						     desktop the title's basis is its own text, so labels get only
						     what the title leaves, and a title that outgrows the row
						     truncates only once the strip is down to its floor. -->
						{#if issue.labels.length > 0}
							<LabelStrip labels={issue.labels} class="ml-auto flex-1 sm:order-5" />
						{/if}
						{#if state.category !== 'awaiting_human'}
							<span
								class="text-muted-foreground shrink-0 text-right text-xs whitespace-nowrap tabular-nums sm:order-6 {issue
									.labels.length === 0
									? 'ml-auto'
									: ''}"
								title={new Date(issue.last_activity_at).toLocaleString()}
							>
								{relativeTimeShort(issue.last_activity_at)}
							</span>
						{/if}
					</div>
					{#if state.category === 'awaiting_human'}
						<div
							class="text-muted-foreground flex w-full flex-wrap items-center gap-1.5 text-xs sm:order-7 sm:ml-60"
						>
							<time
								datetime={new Date(issue.state_entered_at).toISOString()}
								title={new Date(issue.state_entered_at).toLocaleString()}
							>
								waiting {ageLabel(issue.state_entered_at)}
							</time>
							{#if issue.arrived_via}
								<span aria-hidden="true">·</span>
								<span
									>{issue.arrived_via.action
										? `via ${issue.arrived_via.action}`
										: 'moved directly'}</span
								>
							{/if}
							{#if issue.round_summary?.pr_url}
								<span aria-hidden="true">·</span>
								<span class="bg-muted rounded-full border px-2 py-0.5"
									>PR #{prNumber(issue.round_summary.pr_url)}</span
								>
							{/if}
							{#each issue.round_summary?.artifacts ?? [] as artifact (`${artifact.name}-${artifact.version}`)}
								<span aria-hidden="true">·</span>
								<span class="bg-muted rounded-full border px-2 py-0.5 font-mono"
									>{artifact.name} v{artifact.version}</span
								>
							{/each}
						</div>
					{/if}
				</a>
			</li>
		{/each}
	</ul>
{/if}

<style>
	/* Two lines on a phone, one from `sm` (Tailwind's 40rem) up. A pasted URL
	   or a 400-character token breaks inside the box instead of widening the
	   page. */
	.title {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
		overflow-wrap: anywhere;
		line-height: 1.35;
	}
	@media (min-width: 40rem) {
		.title {
			display: inline-block;
			max-width: 100%;
			vertical-align: middle;
			white-space: nowrap;
			text-overflow: ellipsis;
			line-height: 1.25;
		}
	}
</style>
