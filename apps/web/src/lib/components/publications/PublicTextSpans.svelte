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
			useId: string,
			occurrenceId: string
		) => {
			text: string;
			label: string;
			count: number;
			changed?: boolean;
		};
	} = $props();

	// A Markdown-valued sample splits one occurrence into several styled fragments that
	// share an occurrence id. Group them so the chip, its id and its Edit control render
	// once per occurrence while every fragment keeps its own style.
	type Group = { token: NonNullable<PublicTextSpan['token']> | null; spans: PublicTextSpan[] };
	const groups = $derived.by(() => {
		const result: Group[] = [];
		for (const span of spans) {
			const last = result.at(-1);
			if (span.token && last?.token && last.token.occurrence_id === span.token.occurrence_id)
				last.spans.push(span);
			else result.push({ token: span.token ?? null, spans: [span] });
		}
		return result;
	});
</script>

{#snippet fragments(group: Group)}{#each group.spans as span}<span
			class:font-bold={span.strong}
			class:italic={span.emphasis}
			class:line-through={span.deleted}>{span.text}</span
		>{/each}{/snippet}

{#each groups as group}
	{@const token = group.token}
	{@const details = token
		? tokenDetails?.(token.input_id, token.use_id, token.occurrence_id)
		: undefined}
	{#if token && linkMode === 'confirm' && details}<span
			data-input-id={token.input_id}
			data-occurrence-id={token.occurrence_id}
			id={occurrenceScope ? `${occurrenceScope}-${token.occurrence_id}` : token.occurrence_id}
			class="inline-flex min-h-11 flex-wrap items-center gap-x-2 rounded px-1 transition-colors duration-150 motion-reduce:transition-none {(details?.changed ??
			!tokenDetails)
				? 'bg-primary/10'
				: ''}"
			><span class="text-primary font-mono underline underline-offset-2"
				>{@render fragments(group)}</span
			><span class="text-muted-foreground font-sans text-xs"
				>{details?.label ?? 'Variable'} · {details?.count ?? 1}
				{(details?.count ?? 1) === 1 ? 'use' : 'uses'}</span
			><button
				type="button"
				class="text-primary min-h-11 px-2 text-xs font-medium underline"
				aria-label={details
					? `Edit ${details.label}`
					: `Show declaration for ${group.spans[0].text}`}
				onclick={(event) => ontoken?.(token.input_id, token.use_id, event.currentTarget)}
				>Edit</button
			></span
		>{:else if token && linkMode === 'confirm'}<button
			type="button"
			data-input-id={token.input_id}
			data-occurrence-id={token.occurrence_id}
			id={occurrenceScope ? `${occurrenceScope}-${token.occurrence_id}` : token.occurrence_id}
			class="text-primary min-h-10 rounded px-0.5 text-left font-mono underline underline-offset-2"
			aria-label={`Show declaration for ${group.spans.map((span) => span.text).join('')}`}
			onclick={(event) => ontoken?.(token.input_id, token.use_id, event.currentTarget)}
			>{@render fragments(group)}</button
		>{:else}{#each group.spans as span}{#if span.href && linkMode === 'confirm'}<button
					type="button"
					class="text-primary text-left underline"
					class:font-bold={span.strong}
					class:italic={span.emphasis}
					class:line-through={span.deleted}
					class:font-mono={span.code}
					title={`Open external destination: ${span.href}`}
					onclick={(event) => onlink(span.href!, event.currentTarget)}>{span.text}</button
				>{:else if span.image}<span
					class="markdown-inert-image"
					role="img"
					aria-label={`Image not loaded: ${span.image.label}`}
					class:font-bold={span.strong}
					class:italic={span.emphasis}
					class:line-through={span.deleted}>{span.text}</span
				>{:else}<span
					class:font-bold={span.strong}
					class:italic={span.emphasis}
					class:line-through={span.deleted}
					class:font-mono={span.code}>{span.text}</span
				>{#if span.href && linkMode === 'inert'}<span class="font-mono text-xs break-all">
						— {span.href}</span
					>{/if}{/if}{/each}{/if}
{/each}
