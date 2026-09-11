<script lang="ts">
	import {
		usageCostLabel,
		type Project,
		type UsageBy,
		type UsageReport,
		type UsageWindow
	} from '@tines/shared';
	import { page } from '$app/state';
	import { pushState, replaceState } from '$app/navigation';
	import { api } from '$lib/api';
	import { sortUsageGroups } from '$lib/usage-view';
	import UsageCostCell from './UsageCostCell.svelte';

	let {
		projects,
		archivedProjects,
		focusId
	}: { projects: Project[]; archivedProjects: Project[]; focusId: string | null } = $props();
	let report = $state<UsageReport | null>(null);
	let loading = $state(true),
		refreshing = $state(false),
		error = $state<string | null>(null);
	let requestId = 0;
	let expanded = $state(new Set<string>());
	let customFrom = $state(page.url.searchParams.get('spend_from') ?? ''),
		customTo = $state(page.url.searchParams.get('spend_to') ?? '');
	const selectedProject = $derived(page.url.searchParams.get('spend_project') ?? focusId ?? 'all');
	const window = $derived(
		(page.url.searchParams.get('spend_window') ?? '7d') as UsageWindow | 'custom'
	);
	const view = $derived((page.url.searchParams.get('spend_view') ?? 'workflow') as UsageBy);
	const workflow = $derived(page.url.searchParams.get('spend_workflow') ?? 'all');
	const sort = $derived((page.url.searchParams.get('spend_sort') ?? 'desc') as 'asc' | 'desc');
	const sorted = $derived(report ? sortUsageGroups(report.groups, sort) : []);
	const allProjects = $derived([...projects, ...archivedProjects]);

	function update(values: Record<string, string | null>, replace = false) {
		const url = new URL(page.url);
		for (const [key, value] of Object.entries(values))
			value === null ? url.searchParams.delete(key) : url.searchParams.set(key, value);
		(replace ? replaceState : pushState)(url, {});
		expanded = new Set();
	}

	async function load(refresh = false) {
		if (
			window === 'custom' &&
			(!page.url.searchParams.get('spend_from') || !page.url.searchParams.get('spend_to'))
		)
			return;
		const id = ++requestId;
		if (refresh && report) refreshing = true;
		else {
			loading = true;
			report = null;
		}
		error = null;
		try {
			const next = await api.getUsage({
				...(window === 'custom'
					? {
							from: page.url.searchParams.get('spend_from') ?? '',
							to: page.url.searchParams.get('spend_to') ?? ''
						}
					: { window }),
				project: selectedProject === 'all' ? undefined : selectedProject,
				workflow: workflow === 'all' ? undefined : workflow,
				by: view
			});
			if (id === requestId) report = next;
		} catch (e) {
			if (id === requestId) error = e instanceof Error ? e.message : 'Unable to load usage';
		} finally {
			if (id === requestId) {
				loading = false;
				refreshing = false;
			}
		}
	}

	$effect(() => {
		const signature = [
			selectedProject,
			window,
			view,
			workflow,
			page.url.searchParams.get('spend_from'),
			page.url.searchParams.get('spend_to')
		].join('|');
		void signature;
		void load();
	});
	$effect(() => {
		if (!page.url.searchParams.has('spend_project'))
			update(
				{
					spend_project: selectedProject,
					spend_window: window,
					spend_view: view,
					spend_sort: sort
				},
				true
			);
	});
	const stat = (value: number | null) => usageCostLabel(value);
</script>

<section class="spend" aria-labelledby="spend-heading">
	<div class="toolbar">
		<label
			>Spend project<select
				value={selectedProject}
				onchange={(e) => update({ spend_project: e.currentTarget.value })}
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
					aria-pressed={window === choice[0]}
					onclick={() => update({ spend_window: choice[0], spend_from: null, spend_to: null })}
					>{choice[1]}</button
				>
			{/each}
			<button
				type="button"
				aria-pressed={window === 'custom'}
				onclick={() => update({ spend_window: 'custom' })}>Custom</button
			>
		</div>
		{#if window === 'custom'}<form
				class="custom"
				onsubmit={(e) => {
					e.preventDefault();
					update({ spend_from: customFrom, spend_to: customTo });
				}}
			>
				<label>From<input bind:value={customFrom} placeholder="2026-09-01 or ISO + offset" /></label
				>
				<label>To<input bind:value={customTo} placeholder="2026-09-08 or ISO + offset" /></label
				><button>Apply</button>
			</form>{/if}
		<div class="views" aria-label="Breakdown">
			{#each [['workflow', 'Workflow'], ['state', 'Starting state'], ['outcome', 'Outcome']] as choice}
				<button
					type="button"
					aria-pressed={view === choice[0]}
					onclick={() => update({ spend_view: choice[0] })}>{choice[1]}</button
				>
			{/each}
		</div>
		<button type="button" onclick={() => load(true)}
			>{refreshing ? 'Refreshing…' : 'Refresh'}</button
		>
	</div>

	<div aria-live="polite">
		{#if loading}<p>Loading spend…</p>
		{:else if error && !report}<p class="error">Spend unavailable: {error}</p>
		{:else if report}
			{#if error}<p class="error">Refresh failed · showing previous report: {error}</p>{/if}
			<header class="statement">
				<div>
					<p id="spend-heading">Project total · all workflows</p>
					<strong
						>{usageCostLabel(
							report.scope_total.cost_usd,
							report.scope_total.finalized_run_count
						)}</strong
					>
				</div>
				<p>
					{report.scope_total.coverage} · {report.scope_total.finalized_run_count} finalized · {report
						.scope_total.priced_run_count} priced · {report.scope_total.unpriced_run_count +
						report.scope_total.unreported_run_count} without price
				</p>
				<small
					>{new Date(report.from).toISOString()} — {new Date(report.to).toISOString()} · {report.timezone}
					· generated {new Date(report.generated_at).toISOString()}</small
				>
			</header>
			{#if workflow !== 'all'}<p class="subtotal">
					Matching subtotal: {usageCostLabel(
						report.matching_total.cost_usd,
						report.matching_total.finalized_run_count
					)} · {report.matching_total.coverage}
				</p>{/if}
			<label
				>Workflow narrowing<select
					value={workflow}
					onchange={(e) => update({ spend_workflow: e.currentTarget.value })}
					><option value="all">All workflows</option
					>{#each report.workflow_options as option}<option value={option.id ?? 'unknown'}
							>{option.name}</option
						>{/each}</select
				></label
			>
			<div class="sort">
				<button
					type="button"
					onclick={() => update({ spend_sort: sort === 'desc' ? 'asc' : 'desc' })}
					>Cost {sort === 'desc' ? 'descending' : 'ascending'}</button
				>
			</div>
			{#if sorted.length === 0}<p>No finalized runs</p>{/if}
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
										.priced_run_count} priced · {group.aggregate.unpriced_run_count +
										group.aggregate.unreported_run_count} without price</small
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
