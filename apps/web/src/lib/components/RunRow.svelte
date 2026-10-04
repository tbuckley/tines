<script lang="ts">
	import type { AgentRun, RunEndOutcome } from '@tines/shared';
	import { isActiveRun } from '@tines/shared';
	import { slide } from 'svelte/transition';
	import RunLogViewer from '$lib/components/RunLogViewer.svelte';
	import RunCostCell from '$lib/components/RunCostCell.svelte';
	import RunOutcomeIcon from '$lib/components/RunOutcomeIcon.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import {
		prefersReducedMotion,
		relativeTime,
		runElapsedLabel,
		runModelLabel,
		runOutcomePresentation,
		runStatusClass
	} from '$lib/format';

	/**
	 * The one run row, shared by every surface that lists runs (the Agents tab,
	 * an issue's agent-activity card and the first-run checklist). It shows what
	 * a person scanning runs needs — who ran, on what, how it ended, what it
	 * cost — and leaves the rest (session id, effort provenance) to
	 * `tines runs show`. What it does show is unconditional here — the props
	 * cover only what is genuinely contextual, so a new run field is added once
	 * rather than per surface.
	 *
	 * The parent owns the surrounding `<ul class="divide-y rounded-lg border">`.
	 */
	let {
		run,
		showIssueRef = false,
		showLogs = true,
		showCost = true,
		oncancel
	}: {
		run: AgentRun;
		/** The Agents tab links out to the issue; an issue page already is the issue. */
		showIssueRef?: boolean;
		/** Run logs are the owner's: a shared project's members see status only. */
		showLogs?: boolean;
		/** Account spend stays private when the issue is shared with a member. */
		showCost?: boolean;
		/** Omitted → no Cancel button. */
		oncancel?: (run: AgentRun) => void;
	} = $props();

	const dur = () => (prefersReducedMotion() ? 0 : 180);

	/** Log-tail viewer expansion — nothing outside the row reads it. */
	let expanded = $state(false);
	let now = $state(Date.now());
	let active = $derived(isActiveRun(run.status));
	let model = $derived(runModelLabel(run));
	/** Same glyph and color as the run's Activity-feed entry; null while live. */
	let outcomeView = $derived(active ? null : runOutcomePresentation(run.status, run.outcome));
	/** A failure's error reads red; any other error stays amber and never turns green. */
	let errorClass = $derived(
		outcomeView?.tone === 'failure' ? 'text-destructive' : 'text-amber-700 dark:text-amber-400'
	);

	$effect(() => {
		const clockKey = `${run.id}:${active ? 1 : 0}:${run.ended_at ?? ''}`;
		if (!clockKey || !active || run.ended_at !== null) return;
		const update = () => (now = Date.now());
		update();
		const timer = setInterval(update, 1000);
		const onVisibility = () => {
			if (document.visibilityState === 'visible') update();
		};
		document.addEventListener('visibilitychange', onVisibility);
		return () => {
			clearInterval(timer);
			document.removeEventListener('visibilitychange', onVisibility);
		};
	});

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
	data-run-id={run.id}
	transition:slide={{ duration: dur() }}
>
	{#if active}
		<span
			class="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500 motion-reduce:animate-none"
			aria-hidden="true"
			data-testid="run-live-dot"
		></span>
	{:else if outcomeView}
		<RunOutcomeIcon tone={outcomeView.tone} class={outcomeView.colorClass} />
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
	<span class="text-muted-foreground text-xs" title={model.title} data-testid="run-model">
		{model.text}
	</span>
	{#if run.effort_application_status === 'legacy_not_applied'}
		<span
			class="text-xs text-amber-700 dark:text-amber-400"
			title="Actual provider effort is unknown"
		>
			tier effort {run.resolved_effort} not delivered · upgrade pending
		</span>
	{/if}
	<span class="text-xs whitespace-nowrap">
		<span class="font-medium {runStatusClass(run.status, run.outcome)}" data-testid="run-status">
			{run.status.replaceAll('_', ' ')}
		</span>
		{#if run.outcome}
			<!-- How the end was judged, subordinate to the status: "failed · interrupted"
			     says the run failed but the issue was not charged for it. Absent on
			     active runs and on rows that ended before outcomes were recorded. -->
			<span class="text-muted-foreground" title={outcomeTitle(run.outcome)}>
				· {run.outcome}
			</span>
		{/if}
	</span>
	<span
		class="text-muted-foreground text-xs whitespace-nowrap tabular-nums"
		title="Elapsed since assignment"
		data-testid="run-duration">{runElapsedLabel(run, now)}</span
	>
	{#if run.resumed_from_run_id}
		<span class="text-muted-foreground text-xs" title="Predecessor run ID">
			resumed run {run.resumed_from_run_id}
		</span>
	{/if}
	{#if showCost}<RunCostCell {run} />{/if}
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
			class="line-clamp-2 max-w-64 text-xs break-words {errorClass}"
			title={run.error}
			data-testid="run-error"
		>
			{run.error}
		</span>
	{/if}
	<!-- One group, so the time and its buttons wrap together and stay at the
	     right edge instead of Logs dropping alone to the left of the next line. -->
	<div class="ml-auto flex shrink-0 items-center gap-x-1" data-testid="run-trailing">
		<span
			class="text-muted-foreground text-xs whitespace-nowrap"
			title={new Date(run.created_at).toLocaleString()}
		>
			{relativeTime(run.created_at)}
		</span>
		{#if showLogs}
			<Button
				size="sm"
				variant="ghost"
				class="h-7"
				aria-expanded={expanded}
				onclick={() => (expanded = !expanded)}
			>
				{expanded ? 'Hide logs' : 'Logs'}
			</Button>
		{/if}
		{#if oncancel && isActiveRun(run.status)}
			<Button size="sm" variant="ghost" class="text-destructive h-7" onclick={() => oncancel(run)}>
				Cancel
			</Button>
		{/if}
	</div>
	{#if expanded && showLogs}
		<div class="w-full" transition:slide={{ duration: dur() }}>
			<RunLogViewer runId={run.id} runError={run.error} {errorClass} />
		</div>
	{/if}
</li>
