<script lang="ts">
	import type { QuotaPolicy, StageStats, StageStatsReport } from '@tines/shared';
	import { deltaLabel, durationLabel, shareLabel } from '@tines/shared';

	let {
		report,
		quota,
		onsentback
	}: {
		report: StageStatsReport;
		quota: QuotaPolicy;
		onsentback?: (stage: StageStats) => void;
	} = $props();

	const outcomeDeltasAvailable = (stage: StageStats) =>
		stage.previous !== null &&
		(report.outcome_recorded_since === null ||
			stage.previous.since >= report.outcome_recorded_since);

	const rosterHref = (stateId: string) =>
		quota.type === 'state_roster' ? `#roster-limit-${stateId}` : '#quota-policy';
</script>

<section class="mb-10" id="this-week" aria-labelledby="stage-stats-heading">
	<h2 id="stage-stats-heading" class="mb-3 text-sm font-semibold">
		This week — vs the 7 days before
	</h2>
	{#if report.states.length === 0}
		<p class="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
			No agent stage saw work in the last 7 days.
		</p>
	{:else}
		{#if report.markers.length > 0}
			<div class="mb-3 flex flex-wrap gap-2" aria-label="Changes this week">
				{#each report.markers as marker (marker.id)}
					<details class="bg-muted rounded-md px-2 py-1">
						<summary class="cursor-pointer text-xs">{marker.label}</summary>
						<div class="mt-2 space-y-1 text-xs">
							{#each marker.effects as effect (effect.state_id)}
								{@const state = report.states.find((row) => row.state_id === effect.state_id)}
								<p>
									{state?.state_name ?? effect.state_id}: since {effect.after?.exits ?? 0} exits,
									{shareLabel(effect.after?.sent_back_share)} sent back, queue {durationLabel(effect.after?.queue_wait_p50)}
									· before {effect.before?.exits ?? 0} exits, {shareLabel(effect.before?.sent_back_share)} sent back, queue {durationLabel(effect.before?.queue_wait_p50)}
								</p>
							{/each}
						</div>
					</details>
				{/each}
			</div>
		{/if}
		<div class="overflow-x-auto rounded-lg border">
			<table class="w-full min-w-[1050px] text-left text-xs">
				<thead class="bg-muted/50 text-muted-foreground">
					<tr>
						<th class="px-3 py-2 font-medium">Stage</th>
						<th class="px-3 py-2 font-medium">Visits · exits</th>
						<th class="px-3 py-2 font-medium">Queue p50 / p90</th>
						<th class="px-3 py-2 font-medium">Work p50 / p90</th>
						<th class="px-3 py-2 font-medium">Runs / visit</th>
						<th class="px-3 py-2 font-medium">Ended</th>
						<th class="px-3 py-2 font-medium">Sent back</th>
						<th class="px-3 py-2 font-medium">Received</th>
					</tr>
				</thead>
				<tbody class="divide-y">
					{#each report.states as stage (stage.state_id)}
						<tr class="align-top">
							<td class="px-3 py-3">
								<a class="font-medium hover:underline" href={`/workflows/${stage.workflow_id}?state=${stage.state_id}#state-${stage.state_id}`}>
									{stage.workflow_name}/{stage.state_name}
								</a>
							</td>
							<td class="px-3 py-3">
								<span>{stage.current.visits} · {stage.current.exits}</span>
								<span class="text-muted-foreground ml-1">{deltaLabel(stage.delta.visits, 'count')}</span>
								{#if stage.current.waiting_now > 0}
									<div class="text-muted-foreground mt-1">{stage.current.waiting_now} waiting, not timed</div>
								{/if}
							</td>
							<td class="px-3 py-3">
								<a class="hover:underline" href={rosterHref(stage.state_id)}>
									{durationLabel(stage.current.queue_wait?.p50)} / {durationLabel(stage.current.queue_wait?.p90)}
								</a>
								<div class="text-muted-foreground">{deltaLabel(stage.delta.queue_wait_p50, 'ms')}</div>
							</td>
							<td class="px-3 py-3">
								<a class="hover:underline" href={`/agents?runs_state=${stage.state_id}#runs`}>
									{durationLabel(stage.current.work?.p50)} / {durationLabel(stage.current.work?.p90)}
								</a>
								<div class="text-muted-foreground">{deltaLabel(stage.delta.work_p50, 'ms')}</div>
							</td>
							<td class="px-3 py-3">
								<a class="hover:underline" href={`/agents?runs_state=${stage.state_id}#runs`}>
									{stage.current.runs.per_visit?.toFixed(1) ?? '—'}
								</a>
								<span class="text-muted-foreground ml-1">{deltaLabel(stage.delta.runs_per_visit, 'ratio')}</span>
								{#if stage.current.runs.top_runner}
									<div class="text-muted-foreground mt-1">
										<a class="hover:underline" href={`#runner-${stage.current.runs.top_runner.id}`}>{stage.current.runs.top_runner.name}</a>
									</div>
								{/if}
							</td>
							<td class="px-3 py-3">
								<a class="hover:underline" href={`/agents?runs_state=${stage.state_id}#runs`}>
									adv {stage.current.runs.outcomes.advanced} · stalled {stage.current.runs.outcomes.stalled}<br />
									failed {stage.current.runs.outcomes.failed} · intr {stage.current.runs.outcomes.interrupted}
								</a>
								{#if stage.current.runs.outcomes.unrecorded > 0}<div class="text-muted-foreground">unrecorded {stage.current.runs.outcomes.unrecorded}</div>{/if}
								{#if outcomeDeltasAvailable(stage)}<div class="text-muted-foreground">failed {deltaLabel(stage.delta.outcomes.failed, 'count')}</div>{/if}
							</td>
							<td class="px-3 py-3">
								<button type="button" class="text-left hover:underline" onclick={() => onsentback?.(stage)}>
									{stage.current.sent_back.count} of {stage.current.exits} ({shareLabel(stage.current.sent_back.share)})
									<div class="text-muted-foreground">agents {stage.current.sent_back.agent} · humans {stage.current.sent_back.human}</div>
									<div class="text-muted-foreground">{deltaLabel(stage.delta.sent_back_share, 'share')}</div>
								</button>
							</td>
							<td class="px-3 py-3">{stage.current.received_back}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>
