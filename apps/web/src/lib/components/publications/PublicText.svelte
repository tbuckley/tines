<script lang="ts">
	import { publicTextModel, type PublicTextBlock, type PublicTextSpan } from '@tines/shared';
	import Modal from '$lib/components/Modal.svelte';

	let {
		source,
		maxWords,
		linkMode = 'confirm'
	}: { source: string; maxWords?: number; linkMode?: 'confirm' | 'inert' } = $props();
	const fullBlocks = $derived(publicTextModel(source));
	const blocks = $derived(maxWords ? truncateBlocks(fullBlocks, maxWords) : fullBlocks);
	let destination = $state<string | null>(null);
	let destinationOpen = $state(false);

	function linkTitle(span: PublicTextSpan) {
		return span.href ? `Open external destination: ${span.href}` : undefined;
	}

	function confirmDestination(href: string) {
		destination = href;
		destinationOpen = true;
	}

	function truncateSpans(items: PublicTextSpan[], limit: number) {
		const result: PublicTextSpan[] = [];
		let remaining = limit;
		for (const span of items) {
			if (remaining <= 0) break;
			const matches = [...span.text.matchAll(/\S+/g)];
			if (matches.length <= remaining) {
				result.push(span);
				remaining -= matches.length;
				continue;
			}
			const last = matches[remaining - 1];
			result.push({
				...span,
				text: `${span.text.slice(0, (last.index ?? 0) + last[0].length)}…`
			});
			remaining = 0;
		}
		return { spans: result, remaining };
	}

	function truncateBlocks(items: PublicTextBlock[], limit: number): PublicTextBlock[] {
		const result: PublicTextBlock[] = [];
		let remaining = limit;
		for (const block of items) {
			if (remaining <= 0) break;
			if ('spans' in block) {
				const cut = truncateSpans(block.spans, remaining);
				result.push({ ...block, spans: cut.spans });
				remaining = cut.remaining;
				continue;
			}
			const words = block.kind === 'code' ? (block.value.match(/\S+/g) ?? []).length : 0;
			if (words > remaining) {
				if (block.kind === 'code') {
					const match = [...block.value.matchAll(/\S+/g)][remaining - 1];
					result.push({
						...block,
						value: `${block.value.slice(0, (match.index ?? 0) + match[0].length)}…`
					});
				}
				break;
			}
			result.push(block);
			remaining -= words;
		}
		return result;
	}
</script>

<div class="space-y-3 wrap-break-word">
	{#each blocks as block}
		{#if block.kind === 'heading'}
			<div class="font-semibold" role="heading" aria-level={block.depth}>
				{#each block.spans as span}{#if span.href && linkMode === 'confirm'}<button
							type="button"
							class="text-primary text-left underline"
							title={linkTitle(span)}
							onclick={() => confirmDestination(span.href!)}
							>{span.text} <span class="text-xs">({span.href})</span></button
						>{:else if span.href}<span>{span.text} <span class="text-xs">({span.href})</span></span
						>{:else}<span
							class:font-bold={span.strong}
							class:italic={span.emphasis}
							class:line-through={span.deleted}
							class:font-mono={span.code}>{span.text}</span
						>{/if}{/each}
			</div>
		{:else if block.kind === 'paragraph'}
			<p
				class="whitespace-pre-wrap"
				class:border-l-2={block.quote_depth > 0}
				class:pl-3={block.quote_depth > 0}
			>
				{#each block.spans as span}{#if span.href && linkMode === 'confirm'}<button
							type="button"
							class="text-primary text-left underline"
							title={linkTitle(span)}
							onclick={() => confirmDestination(span.href!)}
							>{span.text} <span class="text-xs">({span.href})</span></button
						>{:else if span.href}<span>{span.text} <span class="text-xs">({span.href})</span></span
						>{:else}<span
							class:font-bold={span.strong}
							class:italic={span.emphasis}
							class:line-through={span.deleted}
							class:font-mono={span.code}>{span.text}</span
						>{/if}{/each}
			</p>
		{:else if block.kind === 'code'}
			<pre
				class="bg-muted max-w-full overflow-x-auto rounded p-3 font-mono text-xs whitespace-pre-wrap">{block.value}</pre>
		{:else if block.kind === 'list_item'}
			<div class="flex gap-2" style:padding-left="{block.depth * 1.25}rem">
				<span aria-hidden="true">{block.ordered ? `${block.index}.` : '•'}</span><span
					>{#each block.spans as span}{span.text}{/each}</span
				>
			</div>
		{:else if block.kind === 'table'}
			<div class="overflow-x-auto">
				<table class="w-full border-collapse text-sm">
					<tbody
						>{#each block.rows as row}<tr
								>{#each row as cell}<td class="border p-2"
										>{#each cell as span}{span.text}{/each}</td
									>{/each}</tr
							>{/each}</tbody
					>
				</table>
			</div>
		{:else}<hr />{/if}
	{/each}
</div>

{#if linkMode === 'confirm'}<Modal
		bind:open={destinationOpen}
		title="Open external destination?"
		onclose={() => (destination = null)}
	>
		<p class="text-muted-foreground text-sm">
			This link leaves Tines. No referrer or credentials are sent.
		</p>
		<p class="mt-3 max-w-full font-mono text-xs break-all">{destination}</p>
		<div class="mt-5 flex flex-wrap gap-2">
			<a
				class="bg-primary text-primary-foreground inline-flex min-h-10 items-center rounded-md px-4 text-sm"
				href={destination ?? undefined}
				target="_blank"
				rel="noreferrer"
				referrerpolicy="no-referrer"
				onclick={() => {
					destinationOpen = false;
					destination = null;
				}}>Open destination</a
			>
			<button
				class="min-h-10 rounded-md border px-4 text-sm"
				type="button"
				onclick={() => (destinationOpen = false)}>Cancel</button
			>
		</div>
	</Modal>{/if}
