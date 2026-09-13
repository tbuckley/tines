<script lang="ts">
	import { publicTextModel, type PublicTextSpan } from '@tines/shared';

	let { source }: { source: string } = $props();
	const blocks = $derived(publicTextModel(source));

	function linkTitle(span: PublicTextSpan) {
		return span.href ? `Open external destination: ${span.href}` : undefined;
	}
</script>

<div class="space-y-3 wrap-break-word">
	{#each blocks as block}
		{#if block.kind === 'heading'}
			<div class="font-semibold" role="heading" aria-level={block.depth}>
				{#each block.spans as span}{#if span.href}<a
							class="text-primary underline"
							href={span.href}
							target="_blank"
							rel="noreferrer"
							title={linkTitle(span)}>{span.text} <span class="text-xs">({span.href})</span></a
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
				{#each block.spans as span}{#if span.href}<a
							class="text-primary underline"
							href={span.href}
							target="_blank"
							rel="noreferrer"
							title={linkTitle(span)}>{span.text} <span class="text-xs">({span.href})</span></a
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
