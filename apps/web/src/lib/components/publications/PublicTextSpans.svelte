<script lang="ts">
	import type { PublicTextSpan } from '@tines/shared';

	let {
		spans,
		linkMode,
		onlink,
		ontoken
	}: {
		spans: PublicTextSpan[];
		linkMode: 'confirm' | 'inert';
		onlink: (href: string, trigger: HTMLElement) => void;
		ontoken?: (inputId: string, useId: string, trigger: HTMLElement) => void;
	} = $props();
</script>

{#each spans as span}
	{#if span.token && linkMode === 'confirm'}<button
			type="button"
			id="token-{span.token.use_id}"
			class="bg-primary/10 text-primary rounded px-0.5 text-left font-mono underline underline-offset-2"
			class:font-bold={span.strong}
			class:italic={span.emphasis}
			class:line-through={span.deleted}
			aria-label={`Show declaration for ${span.text}`}
			onclick={(event) => ontoken?.(span.token!.input_id, span.token!.use_id, event.currentTarget)}
			>{span.text}</button
		>{:else if span.href && linkMode === 'confirm'}<button
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
		>{#if span.href && linkMode === 'inert'}<span class="font-mono text-xs break-all">
				— {span.href}</span
			>{/if}{/if}
{/each}
