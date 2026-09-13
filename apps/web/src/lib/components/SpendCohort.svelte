<script lang="ts">
	import {
		ApiError,
		usageCostLabel,
		type CohortUsageReport,
		type Workflow,
		type UsageWindow
	} from '@tines/shared';
	import { api } from '$lib/api';
	import SpendEvidence from './SpendEvidence.svelte';
	let {
		workflows,
		project,
		window,
		from,
		to,
		workflow,
		selected,
		onnavigate,
		scope,
		kind,
		member,
		population,
		sort,
		direction,
		cursor,
		onclose
	}: {
		workflows: Workflow[];
		project: string;
		window: UsageWindow | 'custom';
		from: string;
		to: string;
		workflow: string;
		selected: string[] | null;
		onnavigate: (changes: Record<string, string | null>) => void;
		scope: string | null;
		kind: 'issues' | 'runs' | 'entries';
		member: string | null;
		population: 'all' | 'finalized' | 'pending';
		sort: 'cost' | 'time';
		direction: 'asc' | 'desc';
		cursor: string | null;
		onclose: () => void;
	} = $props();
	let report = $state<CohortUsageReport | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let generation = 0;
	const choice = $derived(workflows.find((item) => item.id === workflow) ?? null);
	const terminals = $derived(choice?.states.filter((state) => state.category === 'done') ?? []);
	const effective = $derived(selected ?? terminals.map((state) => state.id));
	const requestKey = $derived(JSON.stringify([project, window, from, to, workflow, effective]));
	async function load() {
		if (!workflow || !effective.length) return;
		const mine = ++generation;
		loading = true;
		error = null;
		report = null;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error('The completed-issues request timed out.')),
					30_000
				);
			});
			const next = await Promise.race([
				api.getCohortUsage({
					workflow,
					...(project === 'all' ? {} : { project }),
					...(window === 'custom' ? { from, to } : { window }),
					...(selected === null ? {} : { done_state: effective })
				}),
				timeout
			]);
			if (mine === generation) report = next;
		} catch (value) {
			if (mine === generation)
				error =
					value instanceof ApiError || value instanceof Error
						? value.message
						: 'Unable to load cohort';
		} finally {
			if (timer) clearTimeout(timer);
			if (mine === generation) loading = false;
		}
	}
	$effect(() => {
		void requestKey;
		if (workflow && effective.length) void load();
		else {
			generation++;
			report = null;
			loading = false;
		}
		return () => {
			generation++;
		};
	});
</script>

<section class="cohort" aria-labelledby="cohort-heading">
	<header>
		<div>
			<h3 id="cohort-heading">Completed issues</h3>
			<p>Costs are not additive to period spend.</p>
		</div>
		<button type="button" onclick={onclose}>Close</button>
	</header>
	<div class="controls">
		<label
			>Workflow<select
				value={workflow}
				onchange={(event) =>
					onnavigate({
						spend_cohort_workflow: event.currentTarget.value,
						spend_done_states: null
					})}
				><option value="">Choose a workflow</option>{#each workflows as item (item.id)}<option
						value={item.id}>{item.name}</option
					>{/each}</select
			></label
		>
		{#if workflow}<fieldset>
				<legend>Terminal states</legend>{#each terminals as state (state.id)}<label class="check"
						><input
							type="checkbox"
							checked={effective.includes(state.id)}
							onchange={(event) => {
								const next = new Set(effective);
								event.currentTarget.checked ? next.add(state.id) : next.delete(state.id);
								onnavigate({ spend_done_states: JSON.stringify([...next].sort()) });
							}}
						/>{state.name}</label
					>{/each}
			</fieldset>{/if}
		<button type="button" disabled={!workflow || !effective.length || loading} onclick={load}
			>{loading ? 'Loading…' : 'Refresh completed issues'}</button
		>
	</div>
	{#if workflow && !effective.length}<p class="error">Select at least one terminal state.</p>{/if}
	{#if error}<p class="error">
			Completed issues unavailable: {error} <button type="button" onclick={load}>Retry</button>
		</p>{/if}
	{#if report}<div aria-live="polite">
			<p>
				Entries [{new Date(report.from).toISOString()}, {new Date(report.to).toISOString()}) ·
				<strong>Costs through {new Date(report.to).toISOString()} exclusive</strong>
			</p>
			<div class="summary">
				<strong>{report.counters.distinct_issue_count} completed issues</strong><span
					>{report.counters.attempt_count}/{report.counters.distinct_issue_count} attempts/all issues</span
				><span
					>{usageCostLabel(report.counters.known_cost_per_issue.value_usd)} known USD/all issues ({report
						.counters.known_cost_per_issue.coverage})</span
				><span
					>{report.counters.priced_run_coverage.numerator}/{report.counters.priced_run_coverage
						.denominator} priced finalized runs</span
				><span
					>{report.counters.fully_priced_issue_count}/{report.counters.distinct_issue_count} fully priced
					issues</span
				><span
					>{report.counters.pending_count} pending · {report.counters.zero_run_issue_count} no-run</span
				><span
					>{report.counters.reopened_issue_count} reopened · {report.counters
						.reopening_history_unavailable_issue_count} unknown</span
				>
			</div>
			{#if report.scope}<div class="evidence-actions">
					<button
						type="button"
						onclick={() =>
							onnavigate({
								spend_scope: report!.scope!,
								spend_kind: 'issues',
								spend_population: 'all',
								spend_member: null,
								spend_evidence_sort: 'cost',
								spend_direction: 'desc',
								spend_cursor: null
							})}>View completed issues</button
					><button
						type="button"
						onclick={() =>
							onnavigate({
								spend_scope: report!.scope!,
								spend_kind: 'entries',
								spend_population: 'all',
								spend_member: null,
								spend_evidence_sort: 'time',
								spend_direction: 'desc',
								spend_cursor: null
							})}>View entry history</button
					>
				</div>{/if}
			{#if !report.counters.distinct_issue_count}<p>
					No completed issues in available history.
				</p>{/if}
			{#each report.terminal_states as item (item.state.id)}<p class="state">
					<strong>{item.state.name}</strong><span
						>{item.counters.distinct_issue_count} completed</span
					><span>{usageCostLabel(item.aggregate.cost_usd)} known cost</span>
				</p>{/each}
			<details>
				<summary>How this cohort is counted</summary>
				<p>
					Distinct issues use their latest selected terminal-state entry in the window. Direct
					attempts created before the cutoff include pre-window research and failed retries; pending
					attempts expose no later usage facts. No-run issues remain in all-issue denominators. A
					fully priced issue has finalized attempts that are all priced and no pending attempt.
				</p>
				<p>
					History is {report.history.status}. Reopening is observed through {new Date(
						report.observed_through
					).toISOString()} exclusive. Recorded provider and calculated list costs are not invoices.
				</p>
			</details>
			{#if scope}<SpendEvidence
					{scope}
					{kind}
					{member}
					{population}
					{sort}
					{direction}
					{cursor}
					{onnavigate}
					onclose={() =>
						onnavigate({
							spend_scope: null,
							spend_kind: null,
							spend_member: null,
							spend_population: null,
							spend_evidence_sort: null,
							spend_direction: null,
							spend_cursor: null
						})}
				/>{/if}
		</div>{/if}
</section>

<style>
	.cohort {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 1rem;
		margin: 1rem 0;
	}
	header,
	.controls,
	.state {
		display: flex;
		flex-wrap: wrap;
		gap: 0.65rem;
		justify-content: space-between;
	}
	header p,
	header h3 {
		margin: 0;
	}
	.controls {
		align-items: end;
		margin: 1rem 0;
	}
	label {
		display: grid;
		gap: 0.25rem;
		font-size: 0.75rem;
		color: var(--muted-foreground);
	}
	.check {
		display: inline-flex;
		margin-right: 0.75rem;
	}
	select,
	button {
		min-height: 32px;
	}
	.summary {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.65rem;
		background: var(--muted);
		padding: 0.75rem;
		border-radius: 6px;
	}
	.evidence-actions {
		display: flex;
		gap: 0.5rem;
		margin: 0.75rem 0;
	}
	.summary strong {
		grid-column: 1/-1;
	}
	.state {
		border-top: 1px solid var(--border);
		padding: 0.65rem 0;
	}
	.error {
		color: var(--destructive);
	}
	@media (max-width: 390px) {
		.summary {
			grid-template-columns: 1fr;
		}
		.summary strong {
			grid-column: auto;
		}
		.controls > label,
		.controls select,
		.controls > button {
			width: 100%;
		}
	}
</style>
