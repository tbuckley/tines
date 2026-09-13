<script lang="ts">
	import {
		ApiError,
		usageCostLabel,
		type AgentRunUsageEvidence,
		type CohortEntry,
		type CohortIssueUsage,
		type IssueAttemptUsage,
		type IssueUsageReport,
		type UsageDiagnostics,
		type UsageEvidencePage
	} from '@tines/shared';
	import { api } from '$lib/api';
	import IssueUsage from './IssueUsage.svelte';
	import UsageCostCell from './UsageCostCell.svelte';

	let {
		scope,
		kind = 'issues',
		member = null,
		population = 'finalized',
		sort = 'cost',
		direction = 'desc',
		cursor = null,
		onnavigate,
		onclose
	}: {
		scope: string;
		kind?: 'issues' | 'runs' | 'entries';
		member?: string | null;
		population?: 'all' | 'finalized' | 'pending';
		sort?: 'cost' | 'time';
		direction?: 'asc' | 'desc';
		cursor?: string | null;
		onnavigate?: (changes: Record<string, string | null>) => void;
		onclose?: () => void;
	} = $props();
	let page = $state<UsageEvidencePage | null>(null);
	let error = $state<string | null>(null);
	let loading = $state(true);
	let lifetime = $state<IssueUsageReport | null>(null);
	let lifetimeError = $state<string | null>(null);
	let lifetimeLoading = $state<string | null>(null);
	let generation = 0;
	const key = $derived(JSON.stringify([scope, kind, member, population, sort, direction, cursor]));

	function change(changes: Record<string, string | null>) {
		onnavigate?.(changes);
	}
	function counts(values: UsageDiagnostics) {
		return (
			Object.entries(values)
				.filter(([, count]) => count > 0)
				.map(([name, count]) => `${name.replaceAll('_', ' ')} ${count}`)
				.join(' · ') || 'none'
		);
	}
	function present(value: unknown) {
		return value === null || value === undefined || value === '' ? 'unavailable' : String(value);
	}
	function instant(value: unknown) {
		return typeof value === 'number' && Number.isFinite(value)
			? new Date(value).toISOString()
			: present(value);
	}
	async function load() {
		const mine = ++generation;
		loading = true;
		error = null;
		try {
			const result = await api.getUsageEvidence({
				scope,
				kind,
				member: member ?? undefined,
				population,
				sort: population === 'pending' ? 'time' : sort,
				direction,
				cursor: cursor ?? undefined,
				limit: 10
			});
			if (mine === generation) page = result;
		} catch (value) {
			if (mine === generation)
				error =
					value instanceof ApiError || value instanceof Error
						? value.message
						: 'Unable to load evidence';
		} finally {
			if (mine === generation) loading = false;
		}
	}
	async function loadLifetime(issueId: string) {
		lifetimeLoading = issueId;
		lifetimeError = null;
		try {
			lifetime = await api.getIssueUsage(issueId);
		} catch (value) {
			lifetimeError =
				value instanceof ApiError || value instanceof Error
					? value.message
					: 'Unable to load lifetime usage';
		} finally {
			lifetimeLoading = null;
		}
	}
	$effect(() => {
		void key;
		void load();
		return () => {
			generation++;
		};
	});
</script>

<section class="evidence" aria-labelledby="evidence-heading">
	<header>
		<div>
			<h3 id="evidence-heading">
				{kind === 'entries' ? 'Completion entry history' : `Contributing ${kind}`}
			</h3>
			<small>Frozen report scope · direct attempts only</small>
		</div>
		{#if onclose}<button type="button" onclick={onclose}>Close detail</button>{/if}
	</header>
	<nav aria-label="Evidence view">
		{#if kind !== 'issues'}<button
				type="button"
				onclick={() =>
					change({
						spend_kind: 'issues',
						spend_member: null,
						spend_population: 'all',
						spend_evidence_sort: 'cost',
						spend_cursor: null
					})}>Issues</button
			>{/if}
		{#if kind !== 'entries'}<button
				type="button"
				aria-pressed={population === 'finalized'}
				onclick={() =>
					change({
						spend_kind: 'runs',
						spend_population: 'finalized',
						spend_evidence_sort: 'cost',
						spend_cursor: null
					})}>Finalized</button
			>
			<button
				type="button"
				aria-pressed={population === 'pending'}
				onclick={() =>
					change({
						spend_kind: 'runs',
						spend_population: 'pending',
						spend_evidence_sort: 'time',
						spend_cursor: null
					})}>Pending</button
			>{/if}
		{#if kind !== 'entries' && population === 'finalized'}<button
				type="button"
				onclick={() =>
					change({ spend_evidence_sort: sort === 'cost' ? 'time' : 'cost', spend_cursor: null })}
				>Sort: {sort}</button
			>{/if}
		<button
			type="button"
			onclick={() =>
				change({ spend_direction: direction === 'desc' ? 'asc' : 'desc', spend_cursor: null })}
			>{direction === 'desc' ? 'Descending' : 'Ascending'}</button
		>
	</nav>
	<div aria-live="polite" aria-busy={loading}>
		{#if loading}<p>Loading evidence…</p>
		{:else if error}<p class="error">
				Evidence unavailable: {error} <button type="button" onclick={load}>Retry</button>
			</p>
		{:else if page}
			<p class="total">
				Whole selection: {usageCostLabel(
					page.matching_total.cost_usd,
					page.matching_total.finalized_run_count
				)} · {page.total_count}
				{kind} · {page.pending_count} pending
			</p>
			{#if page.items.length === 0}<p>
					{population === 'pending' ? 'No pending runs at this cutoff.' : 'No contributing runs.'}
				</p>{/if}
			<div class="rows">
				{#each page.items as raw ((raw as { event_id?: string; id?: string; issue_id?: string }).event_id ?? (raw as { id?: string }).id ?? (raw as IssueAttemptUsage).issue_id)}
					{#if kind === 'issues'}
						{@const item = raw as CohortIssueUsage}
						<article>
							<button
								type="button"
								onclick={() =>
									change({
										spend_kind: 'runs',
										spend_member: item.issue_id ?? 'unknown',
										spend_population: 'finalized',
										spend_cursor: null
									})}
								><strong
									>{item.issue_ref
										? `${item.issue_ref.project_name}/${item.issue_ref.number}`
										: item.issue_id
											? `Unavailable issue (${item.issue_id})`
											: 'Unknown issue'}</strong
								><small
									>{item.issue_ref?.title ?? 'Metadata unavailable'} · {item.attempt_count} runs ·
									{item.chosen_entry.state_name ?? item.chosen_entry.state_id} at {new Date(
										item.chosen_entry.created_at
									).toISOString()} · {item.reopening.value === true
										? 'reopened since entry'
										: item.reopening.value === null
											? 'reopening history unknown'
											: 'not reopened in available history'}</small
								></button
							>
							<div class="issue-actions">
								<UsageCostCell aggregate={item.aggregate} />
								<button
									type="button"
									disabled={lifetimeLoading === item.issue_id}
									onclick={() => loadLifetime(item.issue_id)}
									>{lifetimeLoading === item.issue_id
										? 'Loading lifetime…'
										: 'Lifetime through now'}</button
								>
							</div>
						</article>
					{:else if kind === 'entries'}
						{@const item = raw as CohortEntry}
						<article>
							<div>
								<strong>{item.state_name ?? item.state_id ?? 'Unclassifiable entry'}</strong>
								<small
									>{item.event_type} · {item.issue_id ?? 'unknown issue'} · {new Date(
										item.created_at
									).toISOString()}</small
								>
							</div>
							<strong class="cost"
								>{item.chosen
									? 'Chosen'
									: item.reopening_relevant
										? 'Reopened'
										: item.qualifies
											? 'Qualifies'
											: 'Excluded'}</strong
							>
						</article>
						{#if item.unavailable_reason}<small
								>{item.unavailable_reason.replaceAll('_', ' ')}</small
							>{/if}
					{:else}
						{@const run = raw as AgentRunUsageEvidence}
						<article class="run-row">
							<div>
								<strong>{run.id}</strong><small
									>{run.issue_id} · {run.runner_name} · {new Date(
										run.ended_at ?? run.created_at
									).toISOString()}</small
								>
							</div>
							<strong class="cost"
								>{population === 'pending'
									? 'Pending'
									: usageCostLabel(run.usage_accounting?.cost ?? null)}</strong
							>
						</article>
						{#if population === 'finalized' && run.usage_accounting}
							<details class="accounting">
								<summary>Accounting details for {run.id}</summary>
								<p>
									{run.usage_accounting.status} · source {run.usage_accounting.source ??
										'unavailable'}
									· exact cost {run.usage_accounting.cost_exact ?? 'unavailable'}{run
										.usage_accounting.pricing_reason
										? ` · reason ${run.usage_accounting.pricing_reason.replaceAll('_', ' ')}`
										: ''}
								</p>
								<p>Diagnostics: {counts(run.usage_accounting.diagnostics)}</p>
								<p>
									Tokens: {Object.entries(run.usage_accounting.tokens)
										.map(
											([name, value]) =>
												`${name.replaceAll('_', ' ')} ${value ?? 'unknown'}${run.usage_accounting.invalid_tokens.includes(name as never) ? ' (invalid)' : ''}`
										)
										.join(' · ')}
								</p>
								{#if run.usage_accounting.source === 'calculated'}
									{@const basis = run.usage_accounting.basis}
									<p>
										Rate basis: calculation {present(basis?.calculation_version)} · provider {present(
											basis?.provider
										)} · id {present(basis?.rate_id)} · version {present(basis?.rate_version)} · model
										{present(basis?.model)} · model identity {present(basis?.model_identity)} · usage
										scope {present(basis?.usage_scope)} · plan {present(basis?.plan)} · context {present(
											basis?.context_band
										)} · source {present(basis?.source_url)} · checked {present(
											basis?.source_checked_at
										)} · effective {present(basis?.source_effective_at)} · adopted {instant(
											basis?.rate_adopted_at
										)} · valid to {instant(basis?.rate_valid_to)} · selected {instant(
											basis?.rate_selected_at
										)} · rates input={present(basis?.rates?.input_tokens)} cache-read={present(
											basis?.rates?.cache_read_tokens
										)} cache-write={present(basis?.rates?.cache_write_tokens)} output={present(
											basis?.rates?.output_tokens
										)} per {present(basis?.unit_tokens)} tokens
									</p>
								{/if}
							</details>
						{/if}
					{/if}
				{/each}
			</div>
			<footer>
				<button
					type="button"
					disabled={!page.previous_cursor}
					onclick={() => change({ spend_cursor: page?.previous_cursor ?? null })}>Previous</button
				><button
					type="button"
					disabled={!page.next_cursor}
					onclick={() => change({ spend_cursor: page?.next_cursor ?? null })}>Next</button
				>
			</footer>
			{#if lifetimeError}<p class="error">Lifetime usage unavailable: {lifetimeError}</p>{/if}
			{#if lifetime}<IssueUsage initial={lifetime} />{/if}
		{/if}
	</div>
</section>

<style>
	.evidence {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 1rem;
		margin: 1rem 0;
	}
	.evidence > header,
	nav,
	footer,
	article {
		display: flex;
		gap: 0.6rem;
		align-items: center;
		justify-content: space-between;
	}
	.evidence > header div {
		min-width: 0;
	}
	h3,
	p {
		margin: 0.2rem 0;
	}
	small {
		display: block;
		color: var(--muted-foreground);
		overflow-wrap: anywhere;
	}
	.rows {
		border-block: 1px solid var(--border);
		margin: 0.75rem 0;
	}
	article {
		padding: 0.75rem 0;
	}
	article + article {
		border-top: 1px solid var(--border);
	}
	.accounting {
		padding: 0 0 0.75rem;
		border-bottom: 1px solid var(--border);
		overflow-wrap: anywhere;
	}
	article > button,
	article > div {
		min-width: 0;
		text-align: left;
	}
	.cost {
		min-width: 82px;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.issue-actions {
		display: grid;
		justify-items: end;
		gap: 0.35rem;
	}
	.total {
		background: var(--muted);
		padding: 0.6rem;
		border-radius: 6px;
	}
	.error {
		color: var(--destructive);
	}
	button {
		min-height: 28px;
	}
	@media (max-width: 390px) {
		.evidence {
			padding: 0.75rem;
		}
		nav {
			flex-wrap: wrap;
		}
		article {
			align-items: start;
		}
		.cost {
			min-width: 76px;
		}
	}
	@media (max-width: 350px) {
		.run-row {
			align-items: stretch;
			flex-direction: column;
		}
		.run-row .cost {
			align-self: flex-end;
			min-width: 0;
		}
	}
</style>
