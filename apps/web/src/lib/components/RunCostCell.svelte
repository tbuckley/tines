<script lang="ts">
	import type { AgentRun } from '@tines/shared';
	import { isActiveRun, runCostLabel } from '@tines/shared';
	import RunEstimateBasisDialog from './RunEstimateBasisDialog.svelte';

	let { run }: { run: AgentRun } = $props();
	let open = $state(false);
	let trigger = $state<HTMLButtonElement>();
	const usage = $derived(run.usage);
	const label = $derived(isActiveRun(run.status) ? 'Pending' : runCostLabel(run));
	const inspectable = $derived(
		usage?.pricing?.status === 'calculated' ||
			usage?.pricing?.status === 'unpriced' ||
			usage?.cost_source === 'priced' ||
			usage?.cost_source === 'provider'
	);
	function close() {
		open = false;
		queueMicrotask(() => trigger?.focus());
	}
</script>

{#if label}
	{#if inspectable}
		<button
			bind:this={trigger}
			type="button"
			class="text-muted-foreground min-h-6 text-xs underline decoration-dotted underline-offset-2"
			onclick={() => (open = true)}>{label}</button
		>
	{:else}
		<span class="text-muted-foreground text-xs">{label}</span>
	{/if}
{/if}
<RunEstimateBasisDialog {run} {open} onclose={close} />
