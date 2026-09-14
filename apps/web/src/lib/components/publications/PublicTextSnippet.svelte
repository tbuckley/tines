<script lang="ts">
	import PublicText from './PublicText.svelte';
	let { source }: { source: string } = $props();
	let expanded = $state(false);
	const words = $derived(source.match(/\S+/g) ?? []);
</script>

<div class="min-w-0 overflow-hidden rounded-md border p-3">
	<PublicText {source} maxWords={expanded ? undefined : 100} />
	{#if words.length > 115}
		<button
			class="text-primary mt-2 min-h-10 text-sm underline"
			type="button"
			onclick={() => (expanded = !expanded)}
		>
			{expanded ? 'Show snippet' : `Show all ${words.length} words`}
		</button>
	{/if}
</div>
