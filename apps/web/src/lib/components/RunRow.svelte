<script lang="ts">
	import type { AgentRun } from '@tines/shared';
	import { isActiveRun, runCostLabel, runDurationLabel } from '@tines/shared';
	import { slide } from 'svelte/transition';
	import RunLogViewer from '$lib/components/RunLogViewer.svelte';
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

	const cost = $derived(runCostLabel(run));
</script>

<li class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm" transition:slide={{ duration: dur() }}>
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
	<span class="text-xs font-medium {runStatusClass(run.status)}">
		{run.status.replaceAll('_', ' ')}
	</span>
	<span class="text-muted-foreground text-xs">{runDurationLabel(run)}</span>
	{#if cost}
		<span class="text-muted-foreground text-xs">{cost}</span>
	{/if}
	{#if run.provider_session_id && run.status === 'running'}
		<!-- staleness honesty: managed logs/cost advance only at sweep cadence -->
		<span class="text-muted-foreground/70 text-xs" title="Managed runs are polled by the sweep — logs and cost can lag by up to ~5 minutes; a quiet log means “not polled yet”, not “agent stuck”.">
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
		<span class="max-w-64 truncate text-xs text-amber-700 dark:text-amber-400" title={run.error}>
			{run.error}
		</span>
	{/if}
	<span class="text-muted-foreground ml-auto text-xs" title={new Date(run.created_at).toLocaleString()}>
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
			<RunLogViewer runId={run.id} />
		</div>
	{/if}
</li>
