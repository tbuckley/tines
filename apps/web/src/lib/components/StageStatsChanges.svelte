<script lang="ts">
	import type { StageStatsReport, ChangeMarker } from '@tines/shared';
	import { durationLabel, shareLabel } from '@tines/shared';
	import { workflowHref } from '$lib/stage-stats-view';
	let {
		report,
		markers,
		stateId,
		oncapacity,
		onstage,
		onnavigate
	}: {
		report: StageStatsReport;
		markers: ChangeMarker[];
		stateId?: string;
		oncapacity: (id: string) => void;
		onstage?: (id: string) => void;
		onnavigate?: () => void;
	} = $props();
	const names = {
		prompt: 'Prompt',
		quota: 'Quota',
		automation: 'Automation',
		runner_cap: 'Runner cap',
		rule: 'Routing rule'
	};
	const date = (at: number) => new Date(at).toLocaleString();
</script>

<p class="text-muted-foreground mb-3 text-xs">
	These windows have different lengths. Other changes may also affect the figures; this is not
	evidence of cause.
</p>
{#if !markers.length}<p class="text-muted-foreground text-sm">
		No recorded changes for this stage in this window.
	</p>{/if}
<div class="space-y-3">
	{#each [...markers].sort((a, b) => b.at - a.at) as marker (marker.id)}
		<details class="rounded-lg border p-3">
			<summary class="min-h-11 cursor-pointer text-sm"
				><strong>{names[marker.kind]}</strong> · {marker.label}<span
					class="text-muted-foreground block text-xs"
					>{date(marker.at)} · {marker.state_ids.length
						? 'Affected stages'
						: 'Applies across the board'}</span
				></summary
			>
			<a
				onclick={onnavigate}
				class="inline-flex min-h-11 items-center text-sm underline"
				href={`/activity/recorded?${new URLSearchParams(marker.event_ids.map((id) => ['event', id]))}`}
				>View recorded events</a
			>
			<div class="flex flex-wrap gap-x-4 text-sm">
				{#if marker.kind === 'automation' || marker.kind === 'quota'}<a
						onclick={onnavigate}
						class="inline-flex min-h-11 items-center underline"
						href="#quota-policy">Open supervisor controls</a
					>{:else if marker.kind === 'runner_cap'}<a
						onclick={onnavigate}
						class="inline-flex min-h-11 items-center underline"
						href="#runners">View runner caps</a
					>{:else if marker.kind === 'rule'}<a
						onclick={onnavigate}
						class="inline-flex min-h-11 items-center underline"
						href="#routing">View routing rules</a
					>{/if}
			</div>
			{#each marker.effects.filter((e) => !stateId || e.state_id === stateId) as effect (effect.state_id)}
				{@const stage = report.states.find((s) => s.state_id === effect.state_id)}
				<div class="mt-3 border-t pt-3">
					{#if onstage && stage}<button
							class="min-h-11 text-left text-sm font-medium underline"
							onclick={() => onstage?.(effect.state_id)}
							>{stage.workflow_name} / {stage.state_name}</button
						>{:else}<p class="text-sm font-medium">{stage?.state_name ?? effect.state_id}</p>{/if}
					<div class="grid gap-3 sm:grid-cols-2">
						{#each [{ label: 'Before', figures: effect.before, since: report.window.since, until: marker.at }, { label: 'Since', figures: effect.after, since: marker.at, until: report.window.until }] as side}
							<div class="bg-muted/40 rounded-md p-3 text-sm">
								<strong>{side.label}</strong>
								<p class="text-muted-foreground mb-2 text-xs">
									{date(side.since)} → {date(side.until)}
								</p>
								{#if side.figures}<p>{side.figures.visits} visits · {side.figures.exits} exits</p>
									<p>
										{side.figures.sent_back_share === null
											? 'No exits'
											: `${shareLabel(side.figures.sent_back_share)} of ${side.figures.exits} exits sent back`}
									</p>
									<p>
										Median wait: {side.figures.queue_wait_p50 === null
											? 'Not measured'
											: durationLabel(side.figures.queue_wait_p50)}
									</p>{:else}<p>No measured activity</p>{/if}
							</div>
						{/each}
					</div>
					{#if marker.kind === 'prompt' && stage}<a
							onclick={onnavigate}
							class="inline-flex min-h-11 items-center text-sm underline"
							href={workflowHref(stage)}>Edit current stage prompt</a
						>{:else if marker.kind === 'quota'}<button
							class="min-h-11 text-sm underline"
							onclick={() => oncapacity(effect.state_id)}>View stage capacity</button
						>{/if}
				</div>
			{/each}
		</details>
	{/each}
</div>
