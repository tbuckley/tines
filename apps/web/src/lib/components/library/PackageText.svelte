<script lang="ts">
	import { tick } from 'svelte';
	import Markdown from '$lib/components/Markdown.svelte';
	import { declaredOccurrences, markDeclaredOccurrences, splitMarkers } from './package-text';

	let {
		text,
		tokens = [],
		onToken,
		format = 'text',
		forceExpanded = false
	}: {
		text: string;
		tokens?: { token: string; inputId: string }[];
		onToken?: (id: string, trigger: HTMLElement) => void;
		format?: 'markdown' | 'text';
		forceExpanded?: boolean;
	} = $props();
	let expanded = $state(false);
	let markdownRoot = $state<HTMLElement | null>(null);
	const words = $derived(renderedWordCount(text, format));
	const shown = $derived.by(() => {
		if (expanded || forceExpanded || words <= 115) return text;
		const matches = [...text.matchAll(/\S+/g)];
		const end = matches[Math.min(99, matches.length - 1)];
		let offset = (end?.index ?? 0) + (end?.[0].length ?? 0);
		for (const item of tokens) {
			const start = text.lastIndexOf(item.token, offset);
			if (start >= 0 && start < offset && start + item.token.length > offset)
				offset = start + item.token.length;
		}
		if (format === 'markdown') offset = balancedMarkdownEnd(text, offset);
		return text.slice(0, offset);
	});
	const pieces = $derived.by(() => {
		const result: Array<{ text: string; inputId?: string }> = [];
		let at = 0;
		for (const match of declaredOccurrences(shown, tokens)) {
			result.push({ text: shown.slice(at, match.start) });
			result.push({ text: match.token, inputId: match.inputId });
			at = match.end;
		}
		result.push({ text: shown.slice(at) });
		return result;
	});
	// Substitutable occurrences become indexed markers before Markdown parsing, so
	// escaped literals (`\{{…}}`) render as ordinary text and a token's own
	// characters never reach the parser.
	const marked = $derived(markDeclaredOccurrences(shown, tokens));

	function renderedWordCount(value: string, kind: 'markdown' | 'text') {
		const visible =
			kind === 'text'
				? value
				: value
						.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
						.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
						.replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, '')
						.replace(/[`*_~]/g, '');
		return visible.trim() ? visible.trim().split(/\s+/).length : 0;
	}

	function balancedMarkdownEnd(value: string, initial: number) {
		let end = initial;
		const before = value.slice(0, end);
		const fences = [...before.matchAll(/^\s{0,3}(```+|~~~+)/gm)];
		if (fences.length % 2 === 1) {
			const marker = fences.at(-1)![1][0];
			const closing = new RegExp(`^\\s{0,3}${marker}{3,}\\s*$`, 'gm');
			closing.lastIndex = end;
			const match = closing.exec(value);
			if (match) end = match.index + match[0].length;
		}
		const codeRuns = [...value.slice(0, end).matchAll(/`+/g)];
		if (codeRuns.length % 2 === 1) {
			const run = codeRuns.at(-1)![0];
			const close = value.indexOf(run, end);
			if (close >= 0) end = close + run.length;
		}
		const openLink = value.lastIndexOf('[', end);
		const closedLabel = value.lastIndexOf('](', end);
		const closedLink = value.lastIndexOf(')', end);
		if (openLink > value.lastIndexOf(']', end) || closedLabel > closedLink) {
			const close = value.indexOf(')', end);
			if (close >= 0) end = close + 1;
		}
		return end;
	}

	async function toggle() {
		expanded = !expanded;
		await tick();
		(document.activeElement as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
	}

	function decorateMarkdown() {
		if (!markdownRoot || marked.occurrences.length === 0) return;
		const walker = document.createTreeWalker(markdownRoot, NodeFilter.SHOW_TEXT);
		const nodes: Text[] = [];
		while (walker.nextNode()) nodes.push(walker.currentNode as Text);
		for (const node of nodes) {
			const pieces = splitMarkers(node.data);
			if (!pieces.some((piece) => 'index' in piece)) continue;
			const fragment = document.createDocumentFragment();
			for (const piece of pieces) {
				if ('text' in piece) {
					fragment.append(piece.text);
					continue;
				}
				const occurrence = marked.occurrences[piece.index];
				if (!occurrence) continue;
				if (!onToken) {
					fragment.append(occurrence.token);
					continue;
				}
				const button = document.createElement('button');
				button.type = 'button';
				button.className = 'package-token';
				button.textContent = occurrence.token;
				button.setAttribute('aria-label', `Show declaration for ${occurrence.token}`);
				button.addEventListener('click', () => onToken(occurrence.inputId, button));
				fragment.append(button);
			}
			node.replaceWith(fragment);
		}
	}

	$effect(() => {
		marked;
		queueMicrotask(decorateMarkdown);
	});
</script>

<div class="bg-muted/20 rounded-md border">
	{#if format === 'markdown'}
		<div class="package-markdown min-w-0 p-3 text-sm wrap-break-word" bind:this={markdownRoot}>
			<Markdown source={marked.source} inertImages />
			{#if words > 115 && !expanded && !forceExpanded}<span aria-hidden="true">…</span>{/if}
		</div>
	{:else}
		<pre
			class="max-w-full p-3 font-mono text-xs leading-5 break-words whitespace-pre-wrap">{#each pieces as piece}{#if piece.inputId}<button
						type="button"
						class="bg-primary/10 text-primary rounded px-0.5 font-mono underline underline-offset-2"
						onclick={(event) => onToken?.(piece.inputId!, event.currentTarget)}
						aria-label="Show declaration for {piece.text}">{piece.text}</button
					>{:else}{piece.text}{/if}{/each}{#if words > 115 && !expanded && !forceExpanded}<span
					aria-hidden="true">…</span
				>{/if}</pre>
	{/if}
	{#if words > 115 && !forceExpanded}
		<button
			type="button"
			class="text-primary min-h-10 border-t px-3 text-xs font-medium hover:underline"
			onclick={toggle}
			>{expanded || forceExpanded ? 'Show snippet' : `Show all ${words} words`}</button
		>
	{/if}
</div>

<style>
	:global(.package-token) {
		border-radius: 0.25rem;
		background: color-mix(in oklab, var(--primary) 10%, transparent);
		color: var(--primary);
		font-family: var(--font-mono);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	:global(.markdown-inert-image) {
		border: 1px dashed var(--border);
		border-radius: 0.25rem;
		padding: 0 0.25rem;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		overflow-wrap: anywhere;
	}
	:global(.package-markdown pre),
	:global(.package-markdown code) {
		max-width: 100%;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}
</style>
