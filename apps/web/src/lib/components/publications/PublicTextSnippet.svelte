<script lang="ts">
	import { renderedPublicTextWordCount, type PublicTextUse } from '@tines/shared';
	import PublicText from './PublicText.svelte';
	let {
		source,
		linkMode = 'confirm',
		format = 'markdown',
		uses = [],
		onToken,
		fieldId,
		expanded = $bindable<boolean | undefined>()
	}: {
		source: string;
		linkMode?: 'confirm' | 'inert';
		format?: 'markdown' | 'text';
		uses?: PublicTextUse[];
		onToken?: (inputId: string, useId: string, trigger: HTMLElement) => void;
		fieldId?: string;
		expanded?: boolean;
	} = $props();
	const wordCount = $derived(renderedPublicTextWordCount(source, { format, uses }));
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	class="min-w-0 overflow-hidden rounded-md border p-3"
	id={fieldId}
	tabindex={fieldId ? -1 : undefined}
>
	<PublicText
		{source}
		{linkMode}
		{format}
		{uses}
		occurrenceScope={fieldId}
		{onToken}
		maxWords={!expanded && wordCount > 115 ? 100 : undefined}
	/>
	{#if wordCount > 115}
		<button
			id={fieldId ? `${fieldId}-toggle` : undefined}
			class="text-primary mt-2 min-h-10 text-sm underline"
			type="button"
			onclick={() => (expanded = !expanded)}
		>
			{expanded ? 'Show snippet' : `Show all ${wordCount} words`}
		</button>
	{/if}
</div>
