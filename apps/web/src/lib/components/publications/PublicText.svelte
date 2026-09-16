<script lang="ts">
	import { publicTextModel, truncatePublicTextModel, type PublicTextUse } from '@tines/shared';
	import Modal from '$lib/components/Modal.svelte';
	import PublicTextSpans from './PublicTextSpans.svelte';

	let {
		source,
		maxWords,
		linkMode = 'confirm',
		format = 'markdown',
		uses = [],
		labelImages = false,
		occurrenceScope,
		onToken,
		tokenDetails
	}: {
		source: string;
		maxWords?: number;
		linkMode?: 'confirm' | 'inert';
		format?: 'markdown' | 'text';
		uses?: PublicTextUse[];
		labelImages?: boolean;
		occurrenceScope?: string;
		onToken?: (inputId: string, useId: string, trigger: HTMLElement) => void;
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
	const fullBlocks = $derived(publicTextModel(source, { format, uses, labelImages }));
	const blocks = $derived(maxWords ? truncatePublicTextModel(fullBlocks, maxWords) : fullBlocks);
	let destination = $state<string | null>(null);
	let destinationOpen = $state(false);
	let linkTrigger: HTMLElement | null = null;

	function confirmDestination(href: string, trigger: HTMLElement) {
		destination = href;
		linkTrigger = trigger;
		destinationOpen = true;
	}
</script>

<div class="space-y-3 wrap-break-word">
	{#each blocks as block}
		{#if block.kind === 'heading'}
			<div class="font-semibold" role="heading" aria-level={block.depth}>
				<PublicTextSpans
					spans={block.spans}
					{linkMode}
					{occurrenceScope}
					onlink={confirmDestination}
					ontoken={onToken}
					{tokenDetails}
				/>
			</div>
		{:else if block.kind === 'paragraph'}
			<p
				class="whitespace-pre-wrap"
				class:border-l-2={block.quote_depth > 0}
				class:pl-3={block.quote_depth > 0}
			>
				<PublicTextSpans
					spans={block.spans}
					{linkMode}
					{occurrenceScope}
					onlink={confirmDestination}
					ontoken={onToken}
					{tokenDetails}
				/>
			</p>
		{:else if block.kind === 'code'}
			<pre
				class="bg-muted max-w-full overflow-x-auto rounded p-3 font-mono text-xs whitespace-pre-wrap"><PublicTextSpans
					spans={block.spans}
					{linkMode}
					{occurrenceScope}
					onlink={confirmDestination}
					ontoken={onToken}
					{tokenDetails}
				/></pre>
		{:else if block.kind === 'list_item'}
			<div class="flex gap-2" style:padding-left="{block.depth * 1.25}rem">
				<span aria-hidden="true">{block.ordered ? `${block.index}.` : '•'}</span><span
					><PublicTextSpans
						spans={block.spans}
						{linkMode}
						{occurrenceScope}
						onlink={confirmDestination}
						ontoken={onToken}
						{tokenDetails}
					/></span
				>
			</div>
		{:else if block.kind === 'table'}
			<div class="max-w-full overflow-x-auto" role="region" aria-label="Published table">
				<table class="min-w-[36rem] border-collapse text-sm">
					<tbody
						>{#each block.rows as row, rowIndex}<tr
								>{#each row as cell}{#if rowIndex === 0}<th
											scope="col"
											class="border p-2 text-left font-semibold break-words"
											><PublicTextSpans
												spans={cell}
												{linkMode}
												{occurrenceScope}
												onlink={confirmDestination}
												ontoken={onToken}
												{tokenDetails}
											/></th
										>{:else}<td class="border p-2 break-words"
											><PublicTextSpans
												spans={cell}
												{linkMode}
												{occurrenceScope}
												onlink={confirmDestination}
												ontoken={onToken}
												{tokenDetails}
											/></td
										>{/if}{/each}</tr
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
		onclose={() => {
			destination = null;
			if (linkTrigger?.isConnected) linkTrigger.focus();
			linkTrigger = null;
		}}
	>
		<p class="text-muted-foreground text-sm">
			This link leaves Tines. No Tines credentials or referrer are sent.
		</p>
		<p class="mt-3 max-w-full font-mono text-xs break-all">{destination}</p>
		<div class="mt-5 flex flex-wrap gap-2">
			<a
				class="bg-primary text-primary-foreground inline-flex min-h-10 items-center rounded-md px-4 text-sm"
				href={destination ?? undefined}
				target="_blank"
				rel="noopener noreferrer"
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
