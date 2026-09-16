<script lang="ts">
	import type { PublicTextSpan } from '@tines/shared';

	let {
		spans,
		linkMode,
		occurrenceScope,
		onlink,
		ontoken,
		tokenDetails
	}: {
		spans: PublicTextSpan[];
		linkMode: 'confirm' | 'inert';
		occurrenceScope?: string;
		onlink: (href: string, trigger: HTMLElement) => void;
		ontoken?: (inputId: string, useId: string, trigger: HTMLElement) => void;
		tokenDetails?: (
			inputId: string,
			useId: string
		) => {
			text: string;
			label: string;
			count: number;
			changed?: boolean;
		};
	} = $props();
</script>

{#each spans as span}
	{@const details = span.token ? tokenDetails?.(span.token.input_id, span.token.use_id) : undefined}
	{#if span.token && linkMode === 'confirm'}<button
			type="button"
			data-input-id={span.token.input_id}
			id={occurrenceScope
				? `${occurrenceScope}-${span.token.occurrence_id}`
				: span.token.occurrence_id}
			class="text-primary rounded px-0.5 text-left font-mono underline underline-offset-2 transition-colors duration-150 motion-reduce:transition-none {(details?.changed ??
			!tokenDetails)
				? 'bg-primary/10'
				: ''}"
			class:font-bold={span.strong}
			class:italic={span.emphasis}
			class:line-through={span.deleted}
			aria-label={details
				? `${details.label}: ${details.text} · ${details.count} ${details.count === 1 ? 'use' : 'uses'}. Edit variable`
				: `Show declaration for ${span.text}`}
			onclick={(event) => ontoken?.(span.token!.input_id, span.token!.use_id, event.currentTarget)}
			>{details?.text ?? span.text}</button
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
