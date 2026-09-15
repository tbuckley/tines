<script lang="ts">
	import type { PublicTextSpan } from '@tines/shared';

	let {
		spans,
		linkMode,
		onlink
	}: {
		spans: PublicTextSpan[];
		linkMode: 'confirm' | 'inert';
		onlink: (href: string, trigger: HTMLElement) => void;
	} = $props();
</script>

{#each spans as span}
	{#if span.href && linkMode === 'confirm'}<button
			type="button"
			class="text-primary text-left underline"
			class:font-bold={span.strong}
			class:italic={span.emphasis}
			class:line-through={span.deleted}
			class:font-mono={span.code}
			title={`Open external destination: ${span.href}`}
			onclick={(event) => onlink(span.href!, event.currentTarget)}>{span.text}</button
		>{:else}<span
			class:font-bold={span.strong}
			class:italic={span.emphasis}
			class:line-through={span.deleted}
			class:font-mono={span.code}>{span.text}</span
		>{/if}
{/each}
