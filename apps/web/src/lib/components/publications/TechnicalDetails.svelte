<script lang="ts">
	let {
		items
	}: {
		items: Array<{ label: string; value: string | number }>;
	} = $props();
</script>

<details class="text-muted-foreground mt-3 rounded-md border p-3 text-xs">
	<summary class="text-foreground min-h-10 cursor-pointer font-medium">Technical details</summary>
	<dl class="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 pt-2">
		{#each items as item}
			<dt>{item.label}</dt>
			<dd class="min-w-0 font-mono break-all">{item.value}</dd>
		{/each}
	</dl>
</details>
