<script lang="ts">
	import { usageCostLabel, type UsageAggregate } from '@tines/shared';
	let { aggregate }: { aggregate: UsageAggregate } = $props();
	let open = $state(false);
	let dialog = $state<HTMLDialogElement>();
	const estimated = $derived(aggregate.portions.calculated.priced_run_count > 0);
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
		{#if aggregate.rate_portions.length}
			{#each aggregate.rate_portions as portion}
				<p>{portion.basis?.model ?? 'Missing historical basis'} · {portion.cost_usd_exact} USD</p>
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
	}
	dialog::backdrop {
		background: rgb(0 0 0 / 0.45);
	}
</style>
