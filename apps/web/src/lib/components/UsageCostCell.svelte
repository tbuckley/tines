<script lang="ts">
	import { usageCostLabel, type UsageAggregate } from '@tines/shared';
	let { aggregate }: { aggregate: UsageAggregate } = $props();
	let open = $state(false);
	let dialog = $state<HTMLDialogElement>();
	const estimated = $derived(aggregate.portions.calculated.priced_run_count > 0);
	const shown = (value: unknown) =>
		typeof value === 'string' || typeof value === 'number' ? String(value) : 'unavailable';
	const date = (value: unknown) => {
		if (typeof value !== 'string' && typeof value !== 'number') return 'unavailable';
		const parsed = new Date(value);
		return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : 'unavailable';
	};
	const safeUrl = (value: unknown) =>
		typeof value === 'string' && /^https?:\/\//.test(value) ? value : null;
	$effect(() => {
		if (open && dialog && !dialog.open) dialog.showModal();
		if (!open && dialog?.open) dialog.close();
	});
</script>

<div class="cost-cell">
	<strong>{usageCostLabel(aggregate.cost_usd, aggregate.finalized_run_count)}</strong>
	{#if estimated}<button type="button" onclick={() => (open = true)}>Estimated</button>{/if}
</div>

{#if open}
	<dialog bind:this={dialog} aria-label="Estimate basis" onclose={() => (open = false)}>
		<h3>Estimate basis</h3>
		<p>Standard API list-price estimates; not an invoice or subscription allowance.</p>
		<p>
			Provider: {aggregate.portions.provider.cost_usd_exact} USD ({aggregate.portions.provider
				.priced_run_count} runs) · Unknown source: {aggregate.portions.unknown_source
				.cost_usd_exact} USD ({aggregate.portions.unknown_source.priced_run_count} runs)
		</p>
		{#if aggregate.rate_portions.length}
			{#each aggregate.rate_portions as portion}
				<section class="basis">
					{#if portion.basis}
						<h4>{shown(portion.basis.rate_id)} v{shown(portion.basis.rate_version)}</h4>
						<p>
							{shown(portion.basis.model)} · {shown(portion.basis.plan)} · {shown(
								portion.basis.context_band
							)}
						</p>
						<p>
							Effective {date(portion.basis.source_effective_at)} · checked {date(
								portion.basis.source_checked_at
							)} · adopted {date(portion.basis.rate_adopted_at)}
						</p>
						<p>
							Selected {date(portion.rate_selected_at_min)} — {date(portion.rate_selected_at_max)} · valid
							to {date(portion.basis.rate_valid_to)}
						</p>
						<p>
							Rates per {shown(portion.basis.unit_tokens)} tokens: {Object.entries(
								portion.basis.rates ?? {}
							)
								.map(([name, rate]) => `${name.replaceAll('_', ' ')} ${shown(rate)}`)
								.join(' · ')}
						</p>
						{#if safeUrl(portion.basis.source_url)}<p>
								<a href={safeUrl(portion.basis.source_url)!} target="_blank" rel="noreferrer"
									>Pricing source</a
								>
							</p>{:else}<p>Pricing source unavailable.</p>{/if}
					{:else}<h4>Historical calculated basis unavailable</h4>
						<p>
							The persisted amount is retained, but its historical rate reference is unavailable.
						</p>
					{/if}
					<p>{portion.cost_usd_exact} USD · {portion.priced_run_count} runs</p>
				</section>
			{/each}
		{:else}<p>Historical calculated amount; detailed rate basis unavailable.</p>{/if}
		<button type="button" onclick={() => (open = false)}>Close</button>
	</dialog>
{/if}

<style>
	.cost-cell {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	strong {
		display: block;
		font-size: 1.05rem;
		white-space: nowrap;
	}
	button {
		color: var(--muted-foreground);
		text-decoration: underline;
		font-size: 0.7rem;
		min-height: 24px;
	}
	dialog {
		margin: auto;
		max-width: min(30rem, calc(100vw - 2rem));
		padding: 1.25rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--background);
		color: var(--foreground);
		max-height: calc(100vh - 2rem);
		overflow: auto;
		overflow-wrap: anywhere;
	}
	.basis {
		border-top: 1px solid var(--border);
	}
	dialog::backdrop {
		background: rgb(0 0 0 / 0.45);
	}
</style>
