<script lang="ts">
	import { TEMPLATE_PLACEHOLDERS } from '@tines/shared';

	let { class: className = '' }: { class?: string } = $props();
</script>

<div class="text-muted-foreground space-y-1 text-xs {className}">
	<p>
		Use these in the title and description — each instance gets the values for its own run, with
		dates and times in the timezone selected above:
	</p>
	<ul class="flex flex-wrap gap-x-3 gap-y-1">
		{#each TEMPLATE_PLACEHOLDERS as placeholder (placeholder.key)}
			<li>
				<code class="bg-muted rounded px-1 py-0.5 font-mono">{`{{${placeholder.key}}}`}</code>
				<span class="ml-0.5">{placeholder.description}</span>
			</li>
		{/each}
	</ul>
</div>
