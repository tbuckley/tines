<script lang="ts">
	import {
		usageCostLabel,
		ApiError,
		type Project,
		type UsageReport,
		type Workflow
	} from '@tines/shared';
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import {
		canonicalSpendChanges,
		clearSpendEvidence,
		parseSpendSelection,
		spendRequest
	} from '$lib/spend-selection';
	import { sortUsageGroups } from '$lib/usage-view';
	import UsageCostCell from './UsageCostCell.svelte';
	import SpendEvidence from './SpendEvidence.svelte';
	import SpendCohort from './SpendCohort.svelte';

	let {
		projects,
		archivedProjects,
		workflows,
		focusId,
		navigate
	}: {
		projects: Project[];
		archivedProjects: Project[];
		workflows: Workflow[];
		focusId: string | null;
		navigate: (changes: Record<string, string | null>, replace?: boolean) => Promise<void>;
	} = $props();
	type RequestStatus = 'invalid' | 'loading' | 'ready' | 'refreshing' | 'error' | 'refresh-error';
	type ReportEnvelope = { key: string; report: UsageReport };
	let status = $state<RequestStatus>('loading');
	let envelope = $state<ReportEnvelope | null>(null);
	let error = $state<string | null>(null);
	let requestId = 0;
	let expanded = $state(new Set<string>());
	let customFrom = $state(''),
		customTo = $state(''),
		customSubmitted = $state(false);
	const selection = $derived(parseSpendSelection(page.url, focusId));
	const canonical = $derived(Object.keys(canonicalSpendChanges(page.url, focusId)).length === 0);
	const report = $derived(envelope?.report ?? null);
	const sorted = $derived(report ? sortUsageGroups(report.groups, selection.sort) : []);
	const allExpanded = $derived(
		sorted.length > 0 && sorted.every((group) => expanded.has(group.key))
	);
	const allProjects = $derived([...projects, ...archivedProjects]);
	const selectedProjectName = $derived(
		selection.project === 'all'
			? 'All projects (includes archived)'
			: (allProjects.find((project) => project.id === selection.project)?.name ??
					`Unavailable project (${selection.project})`)
	);
	const missingWorkflow = $derived(
		selection.workflow !== 'all' &&
			!report?.workflow_options.some((option) => (option.id ?? 'unknown') === selection.workflow)
	);
	/**
	 * One list, so the selected option exists in the same update that applies
	 * the select's value. This is defence, not a repair a test pins: reverting
	 * it to a separate `{#if}` option leaves the Spend specs green, but the
	 * fallback-to-All failure mode it guards against is silent when it happens,
	 * and a loading or failed scope is exactly where the control must hold the
	 * selection the operator has to correct.
	 */
	const workflowChoices = $derived([
		{ value: 'all', label: 'All workflows' },
		...(missingWorkflow
			? [
					{
						value: selection.workflow,
						label: report
							? `Unavailable workflow (${selection.workflow})`
							: `Selected workflow (${selection.workflow})`
					}
				]
			: []),
		...(report?.workflow_options ?? []).map((option) => ({
			value: option.id ?? 'unknown',
			label: option.name
		}))
	]);
	const appliedCustomSignature = $derived(
		selection.window === 'custom' ? `${selection.from}\u0000${selection.to}` : ''
	);
	const requestKey = $derived(selection.requestKey);
	const customDirty = $derived(
		selection.window === 'custom' &&
			selection.ready &&
			(customFrom.trim() !== selection.from || customTo.trim() !== selection.to)
	);
	let synchronizedCustomSignature = '';

	function update(values: Record<string, string | null>, replace = false) {
		const changes = Object.keys(values).some((key) =>
			[
				'spend_project',
				'spend_window',
				'spend_from',
				'spend_to',
				'spend_workflow',
				'spend_view',
				'spend_cohort_workflow',
				'spend_done_states'
			].includes(key)
		)
			? clearSpendEvidence(values)
			: values;
		void navigate(changes, replace);
		expanded = new Set();
	}
	async function closeCohort() {
		await navigate(clearSpendEvidence({ spend_mode: 'period' }));
		expanded = new Set();
		requestAnimationFrame(() => document.getElementById('completed-issues-button')?.focus());
	}

	function errorMessage(value: unknown) {
		return value instanceof ApiError || value instanceof Error
			? value.message
			: 'Unable to load usage';
	}

	async function load(refresh = false, captured = selection) {
		const id = ++requestId;
		if (!captured.ready) {
			status = 'invalid';
			envelope = null;
			error = null;
			return;
		}
		const retained = refresh && envelope?.key === captured.requestKey ? envelope : null;
		status = retained ? 'refreshing' : 'loading';
		if (!retained) envelope = null;
		error = null;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('The spend request timed out.')), 30_000);
			});
			const next = await Promise.race([api.getUsage(spendRequest(captured)), timeout]);
			if (id !== requestId || captured.requestKey !== selection.requestKey) return;
			envelope = { key: captured.requestKey, report: next };
			status = 'ready';
		} catch (e) {
			if (id !== requestId || captured.requestKey !== selection.requestKey) return;
			error = errorMessage(e);
			status = retained ? 'refresh-error' : 'error';
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	$effect(() => {
		const signature = requestKey;
		const routerReady = canonical;
		void signature;
		if (!routerReady) {
			status = 'loading';
			return;
		}
		untrack(() => void load(false, selection));
		// Deliberate defence with no browser-observable effect: a remounted
		// panel starts from `requestId = 0` and refetches anyway, so a held
		// response from the destroyed instance cannot win. Bumping the
		// generation on teardown keeps that true if the component ever gains
		// shared or reused state.
		return () => {
			requestId++;
		};
	});
	$effect(() => {
		const signature = appliedCustomSignature;
		if (signature !== synchronizedCustomSignature) {
			synchronizedCustomSignature = signature;
			customFrom = selection.window === 'custom' ? selection.from : '';
			customTo = selection.window === 'custom' ? selection.to : '';
			customSubmitted = false;
		}
	});
	const stat = (value: number | null) => usageCostLabel(value);
</script>

<section class="spend" aria-labelledby="spend-heading">
	<h2 id="spend-heading">Spend</h2>
	<p class="scope">
		{selectedProjectName} · {selection.window === 'custom' ? 'Custom range' : selection.window}
	</p>
	<div class="toolbar">
		<label
			>Spend project<select
				value={selection.project}
				onchange={(e) => update({ spend_project: e.currentTarget.value, spend_workflow: null })}
			>
				<option value="all">All projects (includes archived)</option>
				{#each allProjects as project}<option value={project.id}
						>{project.name}{project.archived_at ? ' (archived)' : ''}</option
					>{/each}
			</select></label
		>
		<div class="period" aria-label="Period">
			{#each [['today', 'Today'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days']] as choice}
				<button
					type="button"
					aria-pressed={selection.window === choice[0]}
					onclick={() => update({ spend_window: choice[0], spend_from: null, spend_to: null })}
					>{choice[1]}</button
				>
			{/each}
			<button
				type="button"
				aria-pressed={selection.window === 'custom'}
				onclick={() => update({ spend_window: 'custom' })}>Custom</button
			>
		</div>
		{#if selection.window === 'custom'}<form
				class="custom"
				onsubmit={(e) => {
					e.preventDefault();
					customSubmitted = true;
					if (!customFrom.trim() || !customTo.trim()) {
						document.getElementById(!customFrom.trim() ? 'spend-from' : 'spend-to')?.focus();
						return;
					}
					if (
						customFrom.trim() === selection.from &&
						customTo.trim() === selection.to &&
						status === 'error'
					) {
						void load();
						return;
					}
					update({ spend_from: customFrom.trim(), spend_to: customTo.trim() });
				}}
			>
				<label
					>From<input
						id="spend-from"
						bind:value={customFrom}
						aria-invalid={customSubmitted && !customFrom.trim() ? 'true' : undefined}
						aria-describedby="custom-help"
						placeholder="2026-09-01 or ISO + offset"
					/></label
				>
				<label
					>To (exclusive)<input
						id="spend-to"
						bind:value={customTo}
						aria-label="To"
						aria-invalid={customSubmitted && !customTo.trim() ? 'true' : undefined}
						aria-describedby="custom-help"
						placeholder="2026-09-08 or ISO + offset"
					/></label
				><button>Apply</button>
				<p
					id="custom-help"
					class:invalid={customSubmitted && (!customFrom.trim() || !customTo.trim())}
				>
					{customSubmitted && (!customFrom.trim() || !customTo.trim())
						? 'Enter both From and To, then Apply.'
						: customDirty
							? 'Unapplied changes — Apply to update.'
							: 'Use YYYY-MM-DD or ISO with an offset.'}
				</p>
				{#if status === 'error' && error}<p class="error">{error}</p>{/if}
			</form>{/if}
		<label
			>Workflow narrowing<select
				value={selection.workflow}
				onchange={(e) => update({ spend_workflow: e.currentTarget.value })}
			>
				{#each workflowChoices as choice (choice.value)}
					<option value={choice.value}>{choice.label}</option>
				{/each}
			</select></label
		>
		<div class="views" aria-label="Breakdown">
			{#each [['workflow', 'Workflow'], ['state', 'Starting state'], ['outcome', 'Outcome']] as choice}
				<button
					type="button"
					aria-pressed={selection.view === choice[0]}
					onclick={() => update({ spend_view: choice[0] })}>{choice[1]}</button
				>
			{/each}
		</div>
		<button
			type="button"
			disabled={status === 'loading' || status === 'refreshing'}
			onclick={() => load(true)}>{status === 'refreshing' ? 'Refreshing…' : 'Refresh'}</button
		>
	</div>

	{#if selection.mode === 'period'}<button
			id="completed-issues-button"
			type="button"
			onclick={() => update({ spend_mode: 'cohort' })}>Completed issues</button
		>{:else}<SpendCohort
			{workflows}
			project={selection.project}
			window={selection.window}
			from={selection.from}
			to={selection.to}
			workflow={selection.cohortWorkflow}
			selected={selection.doneStates}
			scope={selection.scope}
			kind={selection.kind}
			member={selection.member}
			population={selection.population}
			sort={selection.evidenceSort}
			direction={selection.evidenceDirection}
			cursor={selection.cursor}
			onnavigate={(changes) => update(changes)}
			onclose={closeCohort}
		/>{/if}

	<div aria-live="polite" aria-busy={status === 'loading' || status === 'refreshing'}>
		{#if status === 'invalid'}<p class="error">Enter both From and To, then Apply.</p>
		{:else if status === 'loading'}<p>Loading spend…</p>
		{:else if status === 'error'}<p class="error">
				Spend unavailable: {error} <button type="button" onclick={() => load()}>Retry</button>
			</p>
		{:else if report}
			{#if status === 'refresh-error'}<p class="error">
					Refresh failed — showing the report generated {new Date(
						report.generated_at
					).toISOString()} for {new Date(report.from).toISOString()} — {new Date(
						report.to
					).toISOString()}: {error}
					<button type="button" onclick={() => load(true)}>Retry refresh</button>
				</p>{/if}
			<header class="statement">
				<div>
					<p>Project total · all workflows</p>
					<strong
						>{usageCostLabel(
							report.scope_total.cost_usd,
							report.scope_total.finalized_run_count
						)}</strong
					>
				</div>
				<p>
					{report.scope_total.coverage} · {report.scope_total.finalized_run_count} finalized · {report
						.scope_total.priced_run_count} priced · {report.scope_total.unpriced_run_count} unpriced ·
					{report.scope_total.unreported_run_count} unreported
				</p>
				<small
					>{new Date(report.from).toISOString()} — {new Date(report.to).toISOString()} · {report.timezone}
					· generated {new Date(report.generated_at).toISOString()}</small
				>
			</header>
			{#if report.scope_total_scope}<button
					type="button"
					onclick={() =>
						update({
							spend_scope: report.scope_total_scope!,
							spend_kind: 'issues',
							spend_member: null,
							spend_population: 'finalized',
							spend_evidence_sort: 'cost',
							spend_direction: 'desc',
							spend_cursor: null
						})}>View contributing issues and runs</button
				>{/if}
			{#if selection.workflow !== 'all'}<p class="subtotal">
					Matching subtotal: {usageCostLabel(
						report.matching_total.cost_usd,
						report.matching_total.finalized_run_count
					)} · {report.matching_total.coverage}
				</p>{/if}
			<div class="sort">
				<button
					type="button"
					onclick={() => update({ spend_sort: selection.sort === 'desc' ? 'asc' : 'desc' })}
					>Cost {selection.sort === 'desc' ? 'descending' : 'ascending'}</button
				>
				{#if sorted.length > 0}<button
						type="button"
						onclick={() => {
							expanded = allExpanded ? new Set() : new Set(sorted.map((group) => group.key));
						}}>{allExpanded ? 'Collapse all' : 'Expand all'}</button
					>{/if}
			</div>
			{#if report.scope_total.finalized_run_count === 0 && report.pending.scope_count === 0}<p>
					No runs — no finalized runs ended in this period.
				</p>
			{:else if report.scope_total.finalized_run_count === 0}<p>
					No finalized runs yet — {report.pending.scope_count} pending at cutoff.
				</p>
			{:else if report.scope_total.priced_run_count === 0 && report.scope_total.unpriced_run_count === 0}<p
				>
					Unknown — {report.scope_total.unreported_run_count} unreported; no usage reported.
				</p>
			{:else if report.scope_total.priced_run_count === 0}<p>
					Unknown dollars — {report.scope_total.unpriced_run_count} unpriced and {report.scope_total
						.unreported_run_count} unreported.
				</p>
			{:else if sorted.length === 0}<p>No finalized runs match this workflow and period.</p>{/if}
			<div class="groups">
				{#each sorted as group (group.key)}
					<article>
						<div class="row">
							<button
								type="button"
								aria-expanded={expanded.has(group.key)}
								onclick={() => {
									const next = new Set(expanded);
									next.has(group.key) ? next.delete(group.key) : next.add(group.key);
									expanded = next;
								}}
								><span>{group.dimension.name}</span><small
									>{group.aggregate.finalized_run_count} finalized · {group.aggregate
										.priced_run_count} priced · {group.aggregate.unpriced_run_count} unpriced · {group
										.aggregate.unreported_run_count}
									unreported</small
								></button
							>
							<UsageCostCell aggregate={group.aggregate} />
							<div class="stats">
								<span>Median {stat(group.aggregate.distribution.median_cost_usd)}</span><span
									>P95 {stat(group.aggregate.distribution.p95_cost_usd)}</span
								><span>Max {stat(group.aggregate.distribution.max_cost_usd)}</span>
							</div>
						</div>
						{#if expanded.has(group.key)}<div class="detail">
								{#if group.scope}<button
										type="button"
										onclick={() =>
											update({
												spend_scope: group.scope!,
												spend_kind: 'issues',
												spend_member: null,
												spend_population: 'finalized',
												spend_evidence_sort: 'cost',
												spend_direction: 'desc',
												spend_cursor: null
											})}>View contributing issues and runs</button
									>{/if}
								<p>
									Per-run cost · priced subset: {group.aggregate.distribution.sample_count} samples; {group
										.aggregate.distribution.missing_price_count} missing price.
								</p>
								<p>
									Mean {stat(group.aggregate.distribution.mean_cost_usd)} · nearest-rank p95{group
										.aggregate.distribution.low_sample
										? ' · Small sample; p95 equals maximum'
										: ''}
								</p>
								<p>
									Sources: provider {group.aggregate.portions.provider.cost_usd_exact} ({group
										.aggregate.portions.provider.priced_run_count}) · calculated {group.aggregate
										.portions.calculated.cost_usd_exact} ({group.aggregate.portions.calculated
										.priced_run_count}) · unknown {group.aggregate.portions.unknown_source
										.cost_usd_exact} ({group.aggregate.portions.unknown_source.priced_run_count})
								</p>
								{#if Object.values(group.aggregate.diagnostics).some(Boolean)}<p>
										Diagnostics: {Object.entries(group.aggregate.diagnostics)
											.filter(([, count]) => count > 0)
											.map(([name, count]) => `${name.replaceAll('_', ' ')} ${count}`)
											.join(' · ')}
									</p>{/if}
								{#if Object.keys(group.aggregate.pricing_reasons).length}<p>
										Pricing: {Object.entries(group.aggregate.pricing_reasons)
											.map(([name, count]) => `${name.replaceAll('_', ' ')} ${count}`)
											.join(' · ')}
									</p>{/if}
								<p>
									Tokens: {Object.entries(group.aggregate.tokens)
										.map(
											([key, value]) =>
												`${key} ${value.value ?? 'unknown'} (${value.reported_runs}/${group.aggregate.finalized_run_count})`
										)
										.join(' · ')}
								</p>
							</div>{/if}
					</article>
				{/each}
			</div>
			<p class="pending">
				{report.pending.matching_count} pending at cutoff; excluded from finalized totals{report
					.pending.unapplied_filters.length
					? ` and counted before ${report.pending.unapplied_filters.join('/')} filters`
					: ''}.
			</p>
			{#if selection.mode === 'period' && selection.scope}{#key `${selection.scope}:${selection.kind}:${selection.member}:${selection.population}:${selection.evidenceSort}:${selection.evidenceDirection}:${selection.cursor}`}
					<SpendEvidence
						scope={selection.scope}
						kind={selection.kind}
						member={selection.member}
						population={selection.population}
						sort={selection.evidenceSort}
						direction={selection.evidenceDirection}
						cursor={selection.cursor}
						onnavigate={(changes) => update(changes)}
						onclose={() =>
							update({
								spend_scope: null,
								spend_kind: null,
								spend_member: null,
								spend_population: null,
								spend_evidence_sort: null,
								spend_direction: null,
								spend_cursor: null
							})}
					/>
				{/key}{/if}
			<details>
				<summary>How this statement is counted</summary>
				<p>
					Runs are attributed when they end. Pending runs are excluded. Per-run statistics use the
					priced subset. Project and workflow labels reflect current retained metadata, including
					archived projects. Provider amounts and calculated list-cost estimates are not an invoice
					or subscription allowance. <strong>Budgets are not enforced.</strong>
				</p>
			</details>
		{/if}
	</div>
</section>

<style>
	.spend {
		max-width: 1040px;
		padding-bottom: 2rem;
		font-size: 14px;
	}
	.toolbar,
	.period,
	.views {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: end;
	}
	.toolbar {
		margin-bottom: 1.25rem;
	}
	.scope {
		overflow-wrap: anywhere;
	}
	.toolbar > label,
	.toolbar select {
		min-width: 0;
		max-width: 100%;
	}
	label {
		display: grid;
		gap: 0.25rem;
		color: var(--muted-foreground);
		font-size: 0.75rem;
	}
	select,
	input,
	.toolbar button,
	.sort button {
		min-height: 32px;
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.25rem 0.55rem;
		background: var(--background);
		color: var(--foreground);
	}
	button[aria-pressed='true'] {
		background: var(--accent);
		font-weight: 600;
	}
	.custom {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: end;
		width: 100%;
	}
	.statement {
		border-block: 1px solid var(--border);
		padding: 1rem 0;
		margin-bottom: 1rem;
	}
	.statement p {
		color: var(--muted-foreground);
	}
	.statement strong {
		display: block;
		font-size: 3rem;
		line-height: 1.05;
		font-variant-numeric: tabular-nums;
	}
	.statement small {
		color: var(--muted-foreground);
		overflow-wrap: anywhere;
	}
	.subtotal,
	.pending {
		padding: 0.65rem;
		background: var(--muted);
		border-radius: 6px;
		margin: 0.75rem 0;
	}
	.sort {
		text-align: right;
		margin: 0.5rem 0;
	}
	article {
		border-top: 1px solid var(--border);
	}
	.row {
		display: grid;
		grid-template-columns: minmax(12rem, 1fr) minmax(82px, auto);
		gap: 0.5rem 1rem;
		padding: 0.8rem 0;
		align-items: center;
	}
	.row > button {
		text-align: left;
		min-height: 36px;
		min-width: 0;
	}
	.row > button span {
		overflow-wrap: anywhere;
	}
	.row > button span,
	.row > button small {
		display: block;
	}
	.row > button small,
	.stats,
	.detail {
		color: var(--muted-foreground);
		font-size: 0.75rem;
	}
	.stats {
		grid-column: 1 / -1;
		display: flex;
		gap: 1rem;
		font-variant-numeric: tabular-nums;
	}
	.detail {
		padding: 0.75rem;
		margin-bottom: 0.5rem;
		background: var(--muted);
		border-radius: 6px;
		overflow-wrap: anywhere;
	}
	.error {
		color: var(--destructive);
	}
	details {
		margin-top: 1rem;
	}
	button:focus-visible,
	select:focus-visible,
	input:focus-visible,
	summary:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
	@media (max-width: 390px) {
		.spend {
			font-size: 13px;
		}
		.toolbar,
		.toolbar > label,
		.toolbar select,
		.custom label,
		.custom input {
			width: 100%;
		}
		.statement strong {
			font-size: 2.4rem;
		}
		.row {
			grid-template-columns: minmax(0, 1fr) minmax(76px, auto);
		}
		.stats {
			justify-content: space-between;
			gap: 0.25rem;
		}
	}
</style>
