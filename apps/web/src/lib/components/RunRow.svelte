<script lang="ts">
	import type { AgentRun, RunEndOutcome } from '@tines/shared';
	import { isActiveRun, runDurationLabel } from '@tines/shared';
	import { slide } from 'svelte/transition';
	import RunLogViewer from '$lib/components/RunLogViewer.svelte';
	import RunCostCell from '$lib/components/RunCostCell.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { prefersReducedMotion, relativeTime, runStatusClass } from '$lib/format';

	/**
	 * The one run row, shared by every surface that lists runs (the Agents tab
	 * and an issue's agent-activity card). Everything a run says about itself
	 * is unconditional here — the props cover only what is genuinely
	 * contextual, so a new run field is added once rather than per surface.
	 *
	 * The parent owns the surrounding `<ul class="divide-y rounded-lg border">`.
	 */
	let {
		run,
		showIssueRef = false,
		oncancel
	}: {
		run: AgentRun;
		/** The Agents tab links out to the issue; an issue page already is the issue. */
		showIssueRef?: boolean;
		/** Omitted → no Cancel button. */
		oncancel?: (run: AgentRun) => void;
	} = $props();

	const dur = () => (prefersReducedMotion() ? 0 : 180);

	/** Log-tail viewer expansion — nothing outside the row reads it. */
	let expanded = $state(false);

	/** What each judgment meant for the issue's attempt budget. */
	function outcomeTitle(outcome: RunEndOutcome): string {
		return outcome === 'advanced'
			? 'The agent transitioned the issue — attempt count reset'
			: outcome === 'interrupted'
				? 'The runner went offline, restarted, or shut down — no strike against the issue'
				: 'The run ended without transitioning the issue — one strike against its attempt budget';
	}
</script>

<li
	class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm"
	transition:slide={{ duration: dur() }}
>
	{#if isActiveRun(run.status)}
		<span class="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500"></span>
	{/if}
	{#if showIssueRef && run.issue_ref}
		<a
			href="/issues/{encodeURIComponent(run.issue_ref.project_name)}/{run.issue_ref.number}"
			class="font-medium hover:underline"
		>
			{run.issue_ref.project_name}/#{run.issue_ref.number}
		</a>
	{/if}
	<span class="text-muted-foreground">{run.runner_name}</span>
	<span class="text-muted-foreground text-xs">
		{run.tier}{run.model ? ` · ${run.model}` : ''}
	</span>
	{#if run.effort_application_status === 'legacy_not_applied'}
		<span
			class="text-xs text-amber-700 dark:text-amber-400"
			title="Actual provider effort is unknown"
		>
			tier effort {run.resolved_effort} not delivered · upgrade pending
		</span>
	{:else if run.resolved_effort}
		<span
			class="text-muted-foreground text-xs"
			title={`Requested ${run.requested_effort ?? 'from runner tier'}; application ${run.effort_application_status}`}
		>
			effort {run.resolved_effort} · {run.effort_application_status.replaceAll('_', ' ')}
		</span>
	{:else if run.effort_application_status === 'unknown'}
		<span class="text-muted-foreground text-xs">effort unknown</span>
	{:else}
		<span class="text-muted-foreground text-xs">provider default · unconfirmed</span>
	{/if}
	<span class="text-xs font-medium {runStatusClass(run.status)}">
		{run.status.replaceAll('_', ' ')}
	</span>
	{#if run.outcome}
		<!-- How the end was judged, subordinate to the status: "failed · interrupted"
		     says the run failed but the issue was not charged for it. Absent on
		     active runs and on rows that ended before outcomes were recorded. -->
		<span class="text-muted-foreground text-xs" title={outcomeTitle(run.outcome)}>
			· {run.outcome}
		</span>
	{/if}
	<span class="text-muted-foreground text-xs">{runDurationLabel(run)}</span>
	{#if run.resumed_from_run_id}
		<span class="text-muted-foreground text-xs" title="Predecessor run ID">
			resumed run {run.resumed_from_run_id}
		</span>
	{/if}
	<RunCostCell {run} />
	{#if run.provider_session_id}
		<span class="text-muted-foreground max-w-full font-mono text-xs break-all select-text">
			session: {run.provider_session_id}
		</span>
	{/if}
	{#if run.provider_session_id && run.status === 'running'}
		<!-- staleness honesty: managed logs/cost advance only at sweep cadence -->
		<span
			class="text-muted-foreground/70 text-xs"
			title="Managed runs are polled by the sweep — logs and cost can lag by up to ~5 minutes; a quiet log means “not polled yet”, not “agent stuck”."
		>
			updates every ~5m
		</span>
	{/if}
	{#if run.provider_url}
		<a
			href={run.provider_url}
			target="_blank"
			rel="noreferrer"
			class="text-muted-foreground text-xs underline-offset-2 hover:underline"
			title="Open the provider console (full transcript)"
		>
			console ↗
		</a>
	{/if}
	{#if run.error}
		<!-- The most useful line on a failed row, and the one most likely to be
		     cut mid-word ("ENOSPC: no space left on…"). Two clamped lines carry
		     roughly twice as much of the reason at every width; the tooltip and
		     the Logs disclosure below carry the rest. -->
		<span
			class="line-clamp-2 max-w-64 text-xs break-words text-amber-700 dark:text-amber-400"
			title={run.error}
			data-testid="run-error"
		>
			{run.error}
		</span>
	{/if}
	<span
		class="text-muted-foreground ml-auto text-xs"
		title={new Date(run.created_at).toLocaleString()}
	>
		{relativeTime(run.created_at)}
	</span>
	<Button
		size="sm"
		variant="ghost"
		class="h-7"
		aria-expanded={expanded}
		onclick={() => (expanded = !expanded)}
	>
		{expanded ? 'Hide logs' : 'Logs'}
	</Button>
	{#if oncancel && isActiveRun(run.status)}
		<Button size="sm" variant="ghost" class="text-destructive h-7" onclick={() => oncancel(run)}>
			Cancel
		</Button>
	{/if}
	{#if expanded}
		<div class="w-full" transition:slide={{ duration: dur() }}>
			<RunLogViewer runId={run.id} runError={run.error} />
		</div>
	{/if}
</li>
