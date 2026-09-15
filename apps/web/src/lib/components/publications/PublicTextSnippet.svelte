<script lang="ts">
	import { renderedPublicTextWordCount } from '@tines/shared';
	import PublicText from './PublicText.svelte';
	let { source, linkMode = 'confirm' }: { source: string; linkMode?: 'confirm' | 'inert' } =
		$props();
	let expanded = $state(false);
	const wordCount = $derived(renderedPublicTextWordCount(source));
</script>

<div class="min-w-0 overflow-hidden rounded-md border p-3">
	<PublicText {source} {linkMode} maxWords={!expanded && wordCount > 115 ? 100 : undefined} />
	{#if wordCount > 115}
		<button
			class="text-primary mt-2 min-h-10 text-sm underline"
			type="button"
			onclick={() => (expanded = !expanded)}
		>
			{expanded ? 'Show snippet' : `Show all ${wordCount} words`}
		</button>
	{/if}
</div>
