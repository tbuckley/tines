<script lang="ts">
	import { renderedPublicTextWordCount } from '@tines/shared';
	import { tick } from 'svelte';
	import PublicText from '$lib/components/publications/PublicText.svelte';

	export type PackageTextToken = {
		id: string;
		token: string;
		inputId: string;
		label?: string;
		value?: string;
		count?: number;
		changed?: boolean;
	};

	let {
		text,
		tokens = [],
		onToken,
		format = 'text',
		forceExpanded = false,
		occurrenceScope
	}: {
		text: string;
		tokens?: PackageTextToken[];
		onToken?: (id: string, trigger: HTMLElement) => void;
		format?: 'markdown' | 'text';
		forceExpanded?: boolean;
		occurrenceScope?: string;
	} = $props();
	let expanded = $state(false);
	const uses = $derived(
		tokens.map((item) => ({ id: item.id, input_id: item.inputId, token: item.token }))
	);
	const words = $derived(renderedPublicTextWordCount(text, { format, uses }));

	function details(inputId: string, useId: string) {
		const token = tokens.find((item) => item.id === useId && item.inputId === inputId);
		return {
			text: token?.value ?? token?.token ?? '',
			label: token?.label ?? token?.token ?? 'Variable',
			count: token?.count ?? 1,
			changed: token?.changed
		};
	}

	async function toggle() {
		expanded = !expanded;
		await tick();
		(document.activeElement as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
	}
</script>

<div class="bg-muted/20 rounded-md border">
	<div class="package-text min-w-0 p-3 text-sm wrap-break-word">
		<PublicText
			source={text}
			{format}
			{uses}
			{occurrenceScope}
			maxWords={words > 115 && !expanded && !forceExpanded ? 100 : undefined}
			tokenDetails={details}
			onToken={(inputId, _useId, trigger) => onToken?.(inputId, trigger)}
		/>
	</div>
	{#if words > 115 && !forceExpanded}
		<button
			type="button"
			class="text-primary min-h-10 border-t px-3 text-xs font-medium hover:underline"
			onclick={toggle}>{expanded ? 'Show snippet' : `Show all ${words} words`}</button
		>
	{/if}
</div>

<style>
	:global(.package-text pre),
	:global(.package-text code) {
		max-width: 100%;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}
</style>
