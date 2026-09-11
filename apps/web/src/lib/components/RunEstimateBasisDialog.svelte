<script lang="ts">
	import type { AgentRun } from '@tines/shared';
	import { Button } from '$lib/components/ui/button/index.js';

	let { run, open, onclose }: { run: AgentRun; open: boolean; onclose: () => void } = $props();
	let dialog: HTMLDialogElement;
	const usage = $derived(run.usage);
	const pricing = $derived(usage?.pricing);
	const basis = $derived(pricing?.status === 'calculated' ? pricing.basis : null);
	const evidence = $derived(pricing?.evidence);

	$effect(() => {
		if (open && dialog && !dialog.open) dialog.showModal();
		if (!open && dialog?.open) dialog.close();
	});

	const reasonText: Record<string, string> = {
		pricing_evidence_missing:
			'This daemon did not report the evidence required to calculate a price.',
		invalid_pricing_evidence:
			'The reported pricing evidence used an unsupported or invalid format.',
		model_missing: 'The requested model identity was not recorded.',
		model_mismatch: 'The launch model did not match the model stored on this run.',
		model_rerouted:
			'Codex reported a model reroute, so mixed-model totals cannot be priced safely.',
		unsupported_model: 'This exact model is not in the reviewed rate catalog.',
		missing_rate: 'No reviewed rate applied when this run was claimed.',
		missing_token_dimension: 'At least one required token dimension was not measured.',
		invalid_token_dimension:
			'The token dimensions were invalid or did not reproduce the normalized totals.',
		long_context_band_unknown:
			'The aggregate input exceeded the range whose rate can be selected safely.',
		attempt_scope_unknown: 'A resumed cumulative total cannot yet be isolated to this attempt.',
		incomplete_attempt: 'A later turn started without a final cumulative usage snapshot.',
		nonmonotonic_usage: 'Cumulative usage decreased during the attempt.',
		multiple_threads: 'More than one Codex thread appeared in this attempt.',
		cost_out_of_range:
			'The exact result could not be represented by the compatibility dollar field.'
	};
	const count = (value: number | undefined) =>
		value === undefined ? 'unknown' : value.toLocaleString();
</script>

<dialog
	bind:this={dialog}
	aria-labelledby="run-cost-title-{run.id}"
	{onclose}
	class="bg-background text-foreground m-auto max-h-[calc(100dvh-32px)] w-[520px] max-w-[calc(100%-32px)] overflow-auto rounded-lg border p-0 shadow-xl backdrop:bg-black/40"
>
	<div class="space-y-4 p-5">
		<div class="flex items-start justify-between gap-4">
			<div>
				<h2 id="run-cost-title-{run.id}" class="text-base font-semibold">Cost evidence</h2>
				<p class="text-muted-foreground mt-1 text-xs">Run {run.id}</p>
			</div>
			<Button size="sm" variant="ghost" class="h-7" onclick={() => dialog.close()}>Close</Button>
		</div>

		{#if basis}
			<div class="space-y-1 text-sm">
				<p><strong>Estimated standard API list-price equivalent</strong></p>
				<p class="break-all">Requested model: <code>{basis.model}</code></p>
				<p class="text-muted-foreground text-xs">
					Identity: requested launch argument, with no observed reroute
				</p>
				<p class="text-xs break-all">
					Rate: <code>{basis.rate_id}</code> · version {basis.rate_version}
				</p>
				<p class="text-xs">
					Selected at claim {new Date(basis.rate_selected_at).toISOString()}; adopted by Tines {new Date(
						basis.rate_adopted_at
					).toISOString()}{basis.source_effective_at
						? `; provider effective ${basis.source_effective_at}`
						: '; provider effective date not published'}
				</p>
				{#if basis.source_url.startsWith('https://')}
					<a
						class="text-xs break-all underline"
						href={basis.source_url}
						target="_blank"
						rel="noreferrer">Official pricing source ↗</a
					>
				{:else}<p class="text-xs break-all">Source: {basis.source_url}</p>{/if}
			</div>
			<div class="grid grid-cols-2 gap-2 text-xs tabular-nums">
				{#each ['input_tokens', 'cache_read_tokens', 'cache_write_tokens', 'output_tokens'] as field}
					<div class="rounded border p-2">
						<span class="text-muted-foreground block">{field.replaceAll('_', ' ')}</span>{count(
							usage?.[field as keyof typeof usage] as number | undefined
						)} × {basis.rates[field as keyof typeof basis.rates] ?? 'unpublished'} / 1M
					</div>
				{/each}
			</div>
			<p class="font-mono text-xs break-all">Exact estimated dollars: {basis.cost_usd_exact}</p>
			<p class="text-muted-foreground text-xs">
				Standard API list-price estimate; not an invoice or subscription usage.
			</p>
		{:else if pricing?.status === 'unpriced'}
			<p class="text-sm">{reasonText[pricing.reason] ?? 'Pricing basis unavailable.'}</p>
			<div class="grid grid-cols-2 gap-2 text-xs tabular-nums">
				<div>Input: {count(usage?.input_tokens)}</div>
				<div>Cache read: {count(usage?.cache_read_tokens)}</div>
				<div>Cache write: {count(usage?.cache_write_tokens)}</div>
				<div>Output: {count(usage?.output_tokens)}</div>
			</div>
			{#if evidence?.model}<p class="text-xs break-all">
					Reported launch model: {evidence.model}
				</p>{/if}
		{:else if usage?.cost_source === 'priced'}
			<p class="text-sm">This historical estimate has no recorded rate basis.</p>
		{:else if usage?.cost_source === 'provider'}
			<p class="text-sm">
				The provider-reported amount is authoritative for this run. Tines did not calculate or add a
				separate estimate.
			</p>
		{:else}
			<p class="text-sm">No cost was reported for this run.</p>
		{/if}
	</div>
</dialog>
