<script lang="ts">
	import { tick } from 'svelte';
	import { page } from '$app/state';
	import { durationLabel, shareLabel, type StageStats, type StageStatsReport } from '@tines/shared';
	import {
		comparisonText,
		markersForState,
		selectStageHighlights,
		stageRunsHref
	} from '$lib/stage-stats-view';
	import StageStatsDetails from './StageStatsDetails.svelte';
	import StageStatsChanges from './StageStatsChanges.svelte';
	import Modal from './Modal.svelte';
	import IconChevronDown from '@tabler/icons-svelte/icons/chevron-down';
	let {
		report,
		boardProject,
		oncapacity,
		onsentback
	}: {
		report: StageStatsReport;
		boardProject: string | null;
		oncapacity: (id: string) => void;
		onsentback: (stage: StageStats) => void;
	} = $props();
	let selected = $state<string | null>(null),
		section = $state('timing'),
		changesOpen = $state(false);
	const highlights = $derived(selectStageHighlights(report));
	$effect(() => {
		boardProject;
		selected = null;
		section = 'timing';
		changesOpen = false;
	});
	$effect(() => {
		if (selected && !report.states.some((s) => s.state_id === selected)) selected = null;
	});
	async function reveal(id: string, tab = 'timing') {
		selected = id;
		section = tab;
		changesOpen = false;
		await tick();
		const target = document.getElementById(`stats-${id}-${tab}`);
		target?.scrollIntoView({ block: 'center' });
		target?.focus({ preventScroll: true });
	}
	const date = (n: number) => new Date(n).toLocaleString();
</script>

<section class="mb-10 min-w-0" id="this-week" aria-labelledby="stage-stats-heading">
	<div class="mb-4 flex flex-wrap items-start justify-between gap-2">
		<div>
			<h2 id="stage-stats-heading" class="text-lg font-semibold">This week</h2>
			<p class="text-muted-foreground text-sm">Last 7 days · compared with the 7 days before</p>
		</div>
		{#if report.markers.length}<button
				class="min-h-11 text-sm underline"
				onclick={() => (changesOpen = true)}
				>{report.markers.length}
				{report.markers.length === 20 ? 'displayed changes' : 'changes'} this week</button
			>{/if}
	</div>
	{#if highlights.length}
		<div
			class="mb-4 grid gap-3 md:grid-cols-{highlights.length}"
			aria-label="Weekly highlights"
			style={`--cards:${highlights.length}`}
		>
			{#each highlights as highlight (highlight.kind)}
				<button
					class="highlight bg-muted/30 hover:bg-muted min-w-0 rounded-lg border p-4 text-left"
					onclick={() =>
						highlight.kind === 'sent'
							? onsentback(highlight.stage)
							: reveal(highlight.stage.state_id, highlight.kind)}
					aria-label={`${highlight.label}: ${highlight.stage.state_name}. ${highlight.detail}. ${highlight.kind === 'sent' ? 'View send-back evidence' : 'Open stage details'}`}
				>
					<span class="text-muted-foreground block text-xs">{highlight.label}</span><strong
						class="mt-1 block text-base">{highlight.stage.state_name}</strong
					><span class="text-muted-foreground block text-xs">{highlight.stage.workflow_name}</span
					><span class="mt-2 block text-sm">{highlight.detail}</span>
				</button>
			{/each}
		</div>
	{/if}
	{#if !report.states.length}<div class="rounded-lg border border-dashed p-6">
			<p class="font-medium">No agent-stage activity in these two weeks</p>
			<p class="text-muted-foreground text-sm">
				Stages appear when visits, exits or runs are recorded in either window. Recorded changes
				remain available above.
			</p>
		</div>{:else}
		<table
			class="overview w-full rounded-lg border text-left text-sm"
			aria-label="Weekly stage statistics"
		>
			<thead class="bg-muted/40 text-muted-foreground"
				><tr
					><th scope="col">Stage</th><th scope="col"
						>Wait to start <span class="block text-xs font-normal">median</span></th
					><th scope="col"
						>Sent back <span class="block text-xs font-normal">share of exits</span></th
					><th scope="col">Runs per visit</th></tr
				></thead
			>
			<tbody>
				{#each report.states as stage (stage.state_id)}
					{@const c = stage.current}{@const p = stage.previous}{@const changes = markersForState(
						report,
						stage.state_id
					)}
					<tr class="stage-row border-t align-top">
						<th scope="row" class="font-normal"
							><button
								class="flex min-h-11 w-full items-center gap-2 text-left font-semibold"
								aria-expanded={selected === stage.state_id}
								aria-controls={`stage-detail-${stage.state_id}`}
								onclick={() => {
									selected = selected === stage.state_id ? null : stage.state_id;
									section = 'timing';
								}}><IconChevronDown size={16} class="shrink-0" />{stage.state_name}</button
							>
							<p class="text-muted-foreground text-xs">{stage.workflow_name} · {c.visits} visits</p>
							{#if !c.visits && !c.exits && !c.runs.total && !c.runs.unbound}<p
									class="text-muted-foreground mt-1 text-xs"
								>
									No activity this week
								</p>{/if}{#if c.waiting_now}<p class="text-muted-foreground mt-1 text-xs">
									{c.waiting_now} of these visits still waiting
								</p>{/if}{#if changes.length}<button
									class="min-h-11 text-xs underline"
									onclick={() => reveal(stage.state_id, 'changes')}>{changes.length} changes</button
								>{/if}</th
						>
						<td
							><span class="mobile-label">Wait to start · median</span><button
								class="metric"
								aria-label={`${stage.state_name} wait to start: view stage capacity`}
								onclick={() => oncapacity(stage.state_id)}
								><strong
									>{c.queue_wait === null
										? 'Not measured'
										: durationLabel(c.queue_wait.p50)}</strong
								><span
									>{c.queue_wait === null
										? 'No timed starts'
										: `${durationLabel(c.queue_wait.total)} total measured wait`}</span
								><span
									>{comparisonText(
										c.queue_wait?.p50,
										p?.queue_wait?.p50,
										'ms',
										report.previous !== null
									)}</span
								></button
							></td
						>
						<td
							><span class="mobile-label">Sent back · share of exits</span><button
								class="metric"
								aria-label={`${stage.state_name} sent back: view evidence`}
								onclick={() => onsentback(stage)}
								><strong
									>{c.sent_back.share === null ? 'No exits' : shareLabel(c.sent_back.share)}</strong
								><span>{c.sent_back.count} of {c.exits} exits</span><span
									>{comparisonText(
										c.sent_back.share,
										p?.sent_back.share,
										'share',
										report.previous !== null
									)}</span
								></button
							></td
						>
						<td
							><span class="mobile-label">Runs per visit</span><a
								class="metric"
								aria-label={`${stage.state_name} runs per visit: view stage runs`}
								href={stageRunsHref(page.url, stage.state_id)}
								><strong
									>{c.runs.per_visit === null ? 'No visits' : c.runs.per_visit.toFixed(1)}</strong
								><span
									>{comparisonText(
										c.runs.per_visit,
										p?.runs.per_visit,
										'ratio',
										report.previous !== null
									)}</span
								><span class:font-semibold={c.runs.outcomes.failed > 0}
									>{c.runs.outcomes.failed > 0
										? `${c.runs.outcomes.failed} failed to start`
										: `${c.runs.total} runs`}</span
								></a
							></td
						>
					</tr>
					<tr class="detail-row" hidden={selected !== stage.state_id}
						><td colspan="4" id={`stage-detail-${stage.state_id}`} class="!p-0"
							>{#if selected === stage.state_id}<StageStatsDetails
									{stage}
									{report}
									{section}
									{oncapacity}
									{onsentback}
								/>{/if}</td
						></tr
					>
				{/each}
			</tbody>
		</table>
	{/if}
	<details class="text-muted-foreground mt-4 text-xs">
		<summary class="min-h-11 cursor-pointer">How these figures are counted</summary>
		<div class="space-y-2">
			<p>
				Current: {date(report.window.since)} → {date(report.window.until)}. {#if report.previous}Previous:
					{date(report.previous.since)} → {date(report.previous.until)}.{/if} Generated {date(
					report.generated_at
				)}.
			</p>
			<p>
				Measured wait excludes visits that have not started. Work time includes gaps between runs.
				Visits count entries; send-backs count exits to earlier, non-done stages. Runs per visit
				includes visits with zero runs. Unbound runs are separate.
			</p>
			<p>
				Arrows show arithmetic changes, not quality judgments. “pp” means percentage points. Missing
				samples are not zero. Incomplete recording suppresses outcome comparisons.
			</p>
		</div>
	</details>
</section>
<Modal bind:open={changesOpen} title="Latest changes in this window" size="xl"
	><StageStatsChanges
		{report}
		markers={report.markers}
		{oncapacity}
		onstage={(id) => reveal(id, 'changes')}
	/></Modal
>

<style>
	[aria-label='Weekly highlights'] {
		grid-template-columns: repeat(var(--cards), minmax(0, 1fr));
	}
	.highlight {
		overflow-wrap: anywhere;
	}
	.overview {
		table-layout: fixed;
	}
	.overview th,
	.overview td {
		padding: 0.8rem;
	}
	.overview th:first-child {
		width: 28%;
	}
	.metric {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		min-height: 44px;
		text-align: left;
		overflow-wrap: anywhere;
	}
	.metric strong {
		font-size: 1.25rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.metric span {
		font-size: 0.75rem;
		color: var(--color-muted-foreground);
	}
	.metric:hover strong {
		text-decoration: underline;
	}
	.mobile-label {
		display: none;
	}
	@media (max-width: 759px) {
		[aria-label='Weekly highlights'] {
			grid-template-columns: 1fr;
		}
		.overview,
		.overview tbody {
			display: block;
		}
		.overview thead {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip-path: inset(50%);
		}
		.overview .stage-row {
			display: block;
			padding: 0.5rem;
		}
		.overview th:first-child {
			width: auto;
		}
		.overview th {
			display: block;
		}
		.overview td {
			display: grid;
			grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr);
			gap: 0.75rem;
		}
		.mobile-label {
			display: block;
			font-size: 0.75rem;
			color: var(--color-muted-foreground);
		}
		.metric {
			text-align: right;
			align-items: flex-end;
		}
		.overview .detail-row:not([hidden]) {
			display: block;
		}
		.overview .detail-row td {
			display: block;
		}
		.overview .detail-row[hidden] {
			display: none;
		}
	}
</style>
