<script lang="ts">
	import type { StageStats, StageStatsReport } from '@tines/shared';
	import { page } from '$app/state';
	import {
		markersForState,
		stageDetailComparisons,
		stageRunsHref,
		workflowHref
	} from '$lib/stage-stats-view';
	import StageStatsChanges from './StageStatsChanges.svelte';
	let {
		stage,
		report,
		section = 'timing',
		oncapacity,
		onsentback
	}: {
		stage: StageStats;
		report: StageStatsReport;
		section?: string;
		oncapacity: (id: string) => void;
		onsentback: (stage: StageStats) => void;
	} = $props();
	const rows = $derived(stageDetailComparisons(stage, report));
</script>

<div class="bg-muted/20 space-y-3 p-4">
	{#each [{ key: 'timing', label: 'Timing and visits' }, { key: 'runs', label: 'Runs and outcomes' }, { key: 'sent', label: 'Send-backs' }, { key: 'changes', label: 'Changes' }] as tab}
		<details open={section === tab.key} class="bg-background rounded-lg border p-3">
			<summary
				id={`stats-${stage.state_id}-${tab.key}`}
				tabindex="0"
				class="min-h-11 cursor-pointer scroll-mt-24 text-sm font-semibold">{tab.label}</summary
			>
			{#if tab.key === 'changes'}
				<StageStatsChanges
					{report}
					markers={markersForState(report, stage.state_id)}
					stateId={stage.state_id}
					{oncapacity}
				/>
			{:else}
				<div class="comparison-grid text-muted-foreground text-xs" aria-hidden="true">
					<span>Measure</span><span>This week</span><span>Previous</span><span>Change</span>
				</div>
				<dl class="divide-y">
					{#each rows[tab.key as 'timing' | 'runs' | 'sent'] as row}
						<div class="comparison-grid py-2 text-sm">
							<dt class="font-medium">{row.label}</dt>
							<dd><span class="mobile-label">This week: </span>{row.current}</dd>
							<dd class="text-muted-foreground">
								<span class="mobile-label">Previous: </span>{row.previous}
							</dd>
							<dd class="text-muted-foreground text-xs">{row.change}</dd>
						</div>
					{/each}
				</dl>
				{#if tab.key === 'timing'}
					<p class="text-muted-foreground mt-3 text-xs">
						Queue samples exclude visits still waiting or closed without starting. Work time is
						elapsed first start to exit, including gaps between runs; open visits are excluded.
						Visit measures use entries in the window; exits and send-backs use exits in the window.
					</p>
					{#if stage.current.work === null}<p class="text-muted-foreground text-xs">
							No completed timed visits.
						</p>{/if}
					<div class="flex flex-wrap gap-x-4 text-sm">
						<button class="min-h-11 underline" onclick={() => oncapacity(stage.state_id)}
							>View stage capacity</button
						><a
							class="inline-flex min-h-11 items-center underline"
							href={stageRunsHref(page.url, stage.state_id)}>View stage runs</a
						><a class="inline-flex min-h-11 items-center underline" href={workflowHref(stage)}
							>Open workflow state</a
						>
					</div>
				{:else if tab.key === 'runs'}
					<p class="text-muted-foreground mt-3 text-xs">
						All entered visits, including zero-run visits, form the runs-per-visit denominator.
						Bound outcomes follow that visit cohort; unbound runs and active runs are separate
						context.
					</p>
					<div class="flex flex-wrap gap-x-4 text-sm">
						<a
							class="inline-flex min-h-11 items-center underline"
							href={stageRunsHref(page.url, stage.state_id)}>View stage runs</a
						>{#if stage.current.runs.top_runner}<a
								class="inline-flex min-h-11 items-center underline"
								href={`#runner-${stage.current.runs.top_runner.id}`}
								>Most-used runner: {stage.current.runs.top_runner.name} · {stage.current.runs
									.top_runner.runs} runs</a
							>{/if}
					</div>
					{#if stage.previous?.runs.top_runner}<p class="text-muted-foreground text-xs">
							Previous most-used runner: <a
								class="underline"
								href={`#runner-${stage.previous.runs.top_runner.id}`}
								>{stage.previous.runs.top_runner.name}</a
							>
							· {stage.previous.runs.top_runner.runs} runs
						</p>{/if}
				{:else}
					<div class="flex flex-wrap gap-x-4 text-sm">
						<button class="min-h-11 underline" onclick={() => onsentback(stage)}
							>View send-back evidence</button
						><a class="inline-flex min-h-11 items-center underline" href={workflowHref(stage)}
							>Edit stage prompt</a
						><a class="inline-flex min-h-11 items-center underline" href={workflowHref(stage)}
							>View receiving workflow state</a
						>
					</div>
				{/if}
			{/if}
		</details>
	{/each}
</div>

<style>
	.comparison-grid {
		display: grid;
		grid-template-columns: 1.3fr 0.8fr 0.8fr 1.4fr;
		gap: 0.75rem;
		overflow-wrap: anywhere;
	}
	.mobile-label {
		margin-right: 0.25rem;
		display: none;
	}
	@media (max-width: 759px) {
		.comparison-grid {
			grid-template-columns: 1fr 1fr;
			gap: 0.35rem;
		}
		.comparison-grid[aria-hidden] {
			display: none;
		}
		.comparison-grid dt {
			grid-column: 1/-1;
		}
		.comparison-grid dd:last-child {
			grid-column: 1/-1;
		}
		.mobile-label {
			display: inline;
		}
	}
</style>
