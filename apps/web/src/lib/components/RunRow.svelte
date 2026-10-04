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
	 * Every fact has a fixed cell, so the same fact sits at the same place on
	 * every row and a list scans as a table: one line where the row is wide
	 * (the Agents tab), three fixed lines where it is narrow (an issue's
	 * sidebar, a phone). Only the occasional extras — error, resume lineage,
	 * console link — flow freely, on a line of their own under the cells.
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
	let issueRef = $derived(showIssueRef ? run.issue_ref : null);
	let legacyEffort = $derived(run.effort_application_status === 'legacy_not_applied');
	let managedLive = $derived(Boolean(run.provider_session_id) && run.status === 'running');
	/** The free-flowing line exists only when a row has something to put on it. */
	let hasDetail = $derived(
		legacyEffort ||
			Boolean(run.resumed_from_run_id) ||
			managedLive ||
			Boolean(run.provider_url) ||
			Boolean(run.error)
	);
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

<li class="run-row px-4 py-2.5 text-sm" data-run-id={run.id} transition:slide={{ duration: dur() }}>
	<div class="run-grid" class:with-ref={issueRef}>
		<!-- One flex line on a narrow row; on a wide one it dissolves and its
		     children take their own columns. -->
		<div class="run-head">
			<span class="run-glyph">
				{#if active}
					<span
						class="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500 motion-reduce:animate-none"
						aria-hidden="true"
						data-testid="run-live-dot"
					></span>
				{:else if outcomeView}
					<RunOutcomeIcon tone={outcomeView.tone} class={outcomeView.colorClass} />
				{/if}
			</span>
			{#if issueRef}
				<a
					href="/issues/{encodeURIComponent(issueRef.project_name)}/{issueRef.number}"
					class="run-ref truncate font-medium hover:underline"
					title="{issueRef.project_name}/#{issueRef.number}"
				>
					{issueRef.project_name}/#{issueRef.number}
				</a>
			{/if}
			<span
				class="run-runner text-muted-foreground truncate"
				title={run.runner_name}
				data-testid="run-runner"
			>
				{run.runner_name}
			</span>
			<span
				class="run-time text-muted-foreground text-xs whitespace-nowrap"
				title={new Date(run.created_at).toLocaleString()}
				data-testid="run-time"
			>
				{relativeTime(run.created_at)}
			</span>
			<div class="run-actions flex shrink-0 items-center gap-x-1" data-testid="run-trailing">
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
					<Button
						size="sm"
						variant="ghost"
						class="text-destructive h-7"
						onclick={() => oncancel(run)}
					>
						Cancel
					</Button>
				{/if}
			</div>
		</div>
		<span class="run-status text-xs whitespace-nowrap">
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
		<span class="run-cost" data-testid="run-cost">
			{#if showCost}<RunCostCell {run} />{/if}
		</span>
		<span
			class="run-model text-muted-foreground truncate text-xs"
			title={model.model ? `${model.model} · ${model.title}` : model.title}
			data-testid="run-model"
		>
			{model.model ?? '—'}
		</span>
		<span
			class="run-effort text-muted-foreground truncate text-xs"
			title={model.title}
			data-testid="run-effort"
		>
			{model.effort ?? ''}
		</span>
		<span
			class="run-tier text-muted-foreground truncate text-xs"
			title="Tier {run.tier}"
			data-testid="run-tier"
		>
			{run.tier}
		</span>
		<span
			class="run-duration text-muted-foreground text-xs whitespace-nowrap tabular-nums"
			title="Elapsed since assignment"
			data-testid="run-duration">{runElapsedLabel(run, now)}</span
		>
		{#if hasDetail}
			<div class="run-detail flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="run-detail">
				{#if legacyEffort}
					<span
						class="text-xs text-amber-700 dark:text-amber-400"
						title="Actual provider effort is unknown"
					>
						tier effort {run.resolved_effort} not delivered · upgrade pending
					</span>
				{/if}
				{#if run.resumed_from_run_id}
					<span class="text-muted-foreground text-xs" title="Predecessor run ID">
						resumed run {run.resumed_from_run_id}
					</span>
				{/if}
				{#if managedLive}
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
			</div>
		{/if}
	</div>
	{#if expanded && showLogs}
		<div class="mt-1 w-full" transition:slide={{ duration: dur() }}>
			<RunLogViewer runId={run.id} runError={run.error} {errorClass} />
		</div>
	{/if}
</li>

<style>
	/* The row measures itself, not the viewport: the same component is a
	   285px sidebar card on a desktop issue page and a full-width table row
	   on the Agents tab. */
	.run-row {
		container-type: inline-size;
	}

	/* Narrow: three fixed lines. Left cells start at the left edge, the
	   numbers (cost, duration) end at the right edge. */
	.run-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 3rem 3.75rem 3rem;
		grid-template-areas:
			'head   head   head head'
			'status status cost cost'
			'model  effort tier duration'
			'detail detail detail detail';
		align-items: center;
		column-gap: 0.5rem;
		row-gap: 0.125rem;
	}
	.run-head {
		grid-area: head;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}
	.run-glyph {
		grid-area: glyph;
		display: flex;
		width: 1rem;
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
	}
	.run-ref {
		grid-area: ref;
		min-width: 0;
		flex-shrink: 0;
		max-width: 50%;
	}
	.run-runner {
		grid-area: runner;
		min-width: 0;
		flex: 1 1 0;
	}
	.run-time {
		grid-area: time;
	}
	.run-actions {
		grid-area: actions;
	}
	.run-status {
		grid-area: status;
		min-width: 0;
	}
	.run-cost {
		grid-area: cost;
		display: flex;
		min-width: 0;
		justify-content: flex-end;
		white-space: nowrap;
	}
	.run-model {
		grid-area: model;
	}
	.run-effort {
		grid-area: effort;
	}
	.run-tier {
		grid-area: tier;
	}
	.run-duration {
		grid-area: duration;
		justify-self: end;
	}
	.run-detail {
		grid-area: detail;
		min-width: 0;
	}

	/* Wide: one line, one column per fact. The widths are fixed, not `auto`:
	   each row is its own grid, so only a fixed track lands at the same x on
	   every row. */
	@container (min-width: 66rem) {
		.run-grid {
			grid-template-columns: 1rem 8rem 7.5rem 3rem 3.5rem 8.5rem 3rem 6.25rem 3.75rem minmax(
					0,
					1fr
				) auto;
			grid-template-areas:
				'glyph runner model effort tier status duration cost time . actions'
				'.     detail detail detail detail detail detail detail detail detail detail';
			row-gap: 0.25rem;
		}
		.run-grid.with-ref {
			grid-template-columns: 1rem 7.5rem 8rem 7.5rem 3rem 3.5rem 8.5rem 3rem 6.25rem 3.75rem minmax(
					0,
					1fr
				) auto;
			grid-template-areas:
				'glyph ref    runner model effort tier status duration cost time . actions'
				'.     detail detail detail detail detail detail detail detail detail detail detail';
		}
		.run-head {
			display: contents;
		}
		.run-ref {
			max-width: none;
		}
		.run-cost {
			justify-content: flex-start;
		}
		.run-duration {
			justify-self: start;
		}
	}
</style>
