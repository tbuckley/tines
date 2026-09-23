<script lang="ts">
	import type { AgentRun } from '@tines/shared';
	import { Button } from '$lib/components/ui/button/index.js';
	import ModelRateDialog from './ModelRateDialog.svelte';
	import { api } from '$lib/api';
	import type { SupervisorRatesResponse } from '@tines/shared';

	let { run, open, onclose }: { run: AgentRun; open: boolean; onclose: () => void } = $props();
	let dialog: HTMLDialogElement;
	let rateDialogOpen = $state(false);
	let rates = $state<SupervisorRatesResponse | null>(null);
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
			'The runner reported token counts but not the details Tines needs to price them. It is probably running an older version of the Tines CLI.',
		invalid_pricing_evidence:
			'The runner sent pricing details in a format Tines does not recognise.',
		model_missing: 'Tines does not know which model this run used.',
		model_mismatch:
			'The model the runner launched is not the model recorded on this run, so Tines cannot tell which rate applies.',
		model_rerouted:
			'Codex switched models partway through the run. The token totals mix two rates, so they cannot be priced.',
		unsupported_model: 'Tines has no price list for this model.',
		missing_rate: 'Tines had no price for this model at the time the run started.',
		missing_token_dimension:
			'The runner did not report all four token counts (input, cache read, cache write, output).',
		invalid_token_dimension: 'The token counts the runner reported do not add up.',
		long_context_band_unknown:
			'OpenAI charges a higher rate for any request over 272,000 input tokens. This run used more than that in total, and the runner could not confirm that every individual request stayed under the limit, so Tines cannot tell which rate applies.',
		request_context_invalid:
			'The per-request breakdown the runner sent is inconsistent with the run totals, so Tines cannot use it to pick a rate.',
		long_context_rate_unsupported:
			'At least one request in this run went over 272,000 input tokens. OpenAI charges a higher rate for those, and Tines does not have that rate.',
		attempt_scope_unknown:
			'This run resumed an earlier session, and Codex reports one running total for the whole session. Tines cannot separate out what this run alone used.',
		incomplete_attempt:
			'Codex started another turn before reporting the final token counts for the previous one, so the totals are incomplete.',
		nonmonotonic_usage:
			'The running token total went down during the run, which should never happen. The counts cannot be trusted.',
		multiple_threads:
			'More than one Codex session ran inside this run, so the token totals cannot be attributed to a single model and rate.',
		cost_out_of_range: 'The calculated cost is too large to store.'
	};
	const contextReasonText: Record<string, string> = {
		unsupported_version: 'The runner is using a Codex CLI version Tines does not support.',
		not_applicable: 'A per-request breakdown was not needed for this run.',
		thread_id_missing: 'Codex did not report a session id, so its log could not be found.',
		rollout_missing: 'The Codex session log was not found on the runner.',
		rollout_ambiguous: 'More than one Codex session log matched this run.',
		unsafe_path: 'The Codex session log was outside the expected directory and was not read.',
		read_failed: 'The Codex session log could not be read.',
		limit_exceeded: 'The Codex session log was too large to read.',
		metadata_mismatch: 'The Codex session log did not match this run.',
		malformed: 'The Codex session log was not valid JSON.',
		missing_dimension: 'The Codex session log was missing some token counts.',
		nonmonotonic: 'Token totals in the Codex session log went down at some point.',
		delta_mismatch:
			'Per-request token counts in the Codex session log do not add up to the totals.',
		terminal_mismatch:
			'The final total in the Codex session log does not match what the runner reported.',
		model_mismatch: 'The Codex session log shows a different model than this run was launched with.'
	};
	const count = (value: number | undefined) =>
		value === undefined ? 'unknown' : value.toLocaleString();
	async function openRateDialog() {
		rates = await api.getSupervisorRates();
		rateDialogOpen = true;
	}
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
				<div
					id="run-cost-title-{run.id}"
					role="heading"
					aria-level="2"
					class="text-base font-semibold"
				>
					Cost evidence
				</div>
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
				{#if basis.rate_source === 'user'}
					<p class="text-xs">
						Rate entered by you on {new Date(
							basis.rate_entered_at ?? basis.rate_selected_at
						).toISOString()}
					</p>
				{:else if basis.source_url.startsWith('https://')}
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
			<p class="text-sm font-medium">Not priced</p>
			<p class="text-sm">
				{reasonText[pricing.reason] ?? 'Tines could not work out a price for this run.'}
			</p>
			<div class="grid grid-cols-2 gap-2 text-xs tabular-nums">
				<div>Input: {count(usage?.input_tokens)}</div>
				<div>Cache read: {count(usage?.cache_read_tokens)}</div>
				<div>Cache write: {count(usage?.cache_write_tokens)}</div>
				<div>Output: {count(usage?.output_tokens)}</div>
			</div>
			{#if evidence?.model}<p class="text-xs break-all">
					Reported launch model: {evidence.model}
				</p>{/if}
			{#if (pricing.reason === 'unsupported_model' || pricing.reason === 'missing_rate') && (evidence?.model || run.model)}
				<Button size="sm" onclick={() => void openRateDialog()}
					>Enter a rate for {evidence?.model ?? run.model}</Button
				>
			{/if}
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
		{#if evidence?.request_context?.status === 'complete'}
			<p class="text-muted-foreground text-xs">
				Per-request breakdown from the Codex session log: {count(
					evidence.request_context.request_count
				)} requests, largest {count(evidence.request_context.max_request_input_tokens)} input tokens.
				Codex CLI {evidence.request_context.harness_version}.
			</p>
		{:else if evidence?.request_context}
			<p class="text-muted-foreground text-xs">
				{contextReasonText[evidence.request_context.reason] ??
					`Per-request breakdown unavailable (${evidence.request_context.reason}).`}
				{#if evidence.request_context.harness_version}
					Codex CLI {evidence.request_context.harness_version}.
				{/if}
			</p>
		{/if}
	</div>
</dialog>
{#if rates}
	<ModelRateDialog
		bind:open={rateDialogOpen}
		model={evidence?.model ?? run.model ?? ''}
		modelReadonly={true}
		{rates}
		onsaved={onclose}
	/>
{/if}
