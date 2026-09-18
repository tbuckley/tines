<script lang="ts">
	import { ApiError, usageCostLabel, type IssueUsageReport } from '@tines/shared';
	import { api } from '$lib/api';
	import SpendEvidence from './SpendEvidence.svelte';
	import { untrack } from 'svelte';

	let { initial }: { initial: IssueUsageReport } = $props();
	let report = $state(untrack(() => initial));
	let refreshing = $state(false);
	let error = $state<string | null>(null);
	let population = $state<'finalized' | 'pending'>('finalized');
	let cursor = $state<string | null>(null);
	let sort = $state<'cost' | 'time'>('cost');
	let direction = $state<'asc' | 'desc'>('desc');

	async function refresh() {
		refreshing = true;
		error = null;
		try {
			report = await api.getIssueUsage(report.issue.issue_id);
			cursor = null;
		} catch (value) {
			error =
				value instanceof ApiError || value instanceof Error
					? value.message
					: 'Unable to refresh lifetime usage';
		} finally {
			refreshing = false;
		}
	}
	function change(changes: Record<string, string | null>) {
		if (changes.spend_population) population = changes.spend_population as typeof population;
		if (changes.spend_evidence_sort) sort = changes.spend_evidence_sort as typeof sort;
		if (changes.spend_direction) direction = changes.spend_direction as typeof direction;
		if ('spend_cursor' in changes) cursor = changes.spend_cursor;
	}
</script>

<section class="usage" aria-labelledby="issue-usage-heading">
	<header>
		<div>
			<h3 id="issue-usage-heading">Lifetime through now</h3>
			<small>Direct retained attempts only · as of {new Date(report.cutoff).toISOString()}</small>
		</div>
		<button type="button" disabled={refreshing} onclick={refresh}
			>{refreshing ? 'Refreshing…' : 'Refresh through now'}</button
		>
	</header>
	{#if error}<p class="error">Refresh failed — showing the previous cutoff: {error}</p>{/if}
	{#if report.issue.attempt_count === 0}<p>No agent runs</p>
	{:else}<p>
			<strong
				>{usageCostLabel(
					report.issue.aggregate.cost_usd,
					report.issue.aggregate.finalized_run_count
				)}</strong
			>
			· {report.issue.aggregate.coverage} · {report.issue.aggregate.finalized_run_count} finalized · {report
				.issue.pending_count} pending at cutoff
		</p>{/if}
	{#if report.scope && report.issue.attempt_count > 0}<SpendEvidence
			scope={report.scope}
			kind="runs"
			member={report.issue.issue_id}
			{population}
			{sort}
			{direction}
			{cursor}
			onnavigate={change}
		/>{/if}
</section>

<style>
	.usage {
		border-top: 1px solid var(--border);
		margin-top: 1rem;
		padding-top: 1rem;
	}
	.usage > header {
		display: flex;
		gap: 0.5rem;
		justify-content: space-between;
		align-items: start;
	}
	h3,
	p {
		margin: 0.2rem 0;
	}
	small {
		color: var(--muted-foreground);
	}
	.error {
		color: var(--destructive);
	}
	button {
		min-height: 28px;
	}
</style>
