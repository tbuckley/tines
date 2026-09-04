<script lang="ts">
	import { ApiError } from '@tines/shared';
	import IconCheck from '@tabler/icons-svelte/icons/check';
	import IconCopy from '@tabler/icons-svelte/icons/copy';
	import { api } from '$lib/api';
	import Markdown from '$lib/components/Markdown.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import { Button } from '$lib/components/ui/button/index.js';

	/**
	 * The full launch prompt (stitched context + generated issue block) in a
	 * dialog with rendered/raw views and copy-to-clipboard — the manual path
	 * for launching an agent by hand until the supervisor exists.
	 */
	let { open = $bindable(false), issueId }: { open?: boolean; issueId: string } = $props();

	let text = $state<string | null>(null);
	let errorMessage = $state<string | null>(null);
	let view = $state<'rendered' | 'raw'>('rendered');
	let copied = $state(false);

	// Fetch fresh on every open: the prompt is a read-time formatting that
	// follows the issue's comments and transitions.
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			text = null;
			errorMessage = null;
			copied = false;
			api
				.getIssuePrompt(issueId)
				.then((res) => (text = res.text))
				.catch((err) => {
					errorMessage =
						err instanceof ApiError ? err.message : 'Failed to load the launch prompt.';
				});
		}
		wasOpen = open;
	});

	async function copy() {
		if (text === null) return;
		await navigator.clipboard.writeText(text);
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}
</script>

<Modal bind:open title="Launch prompt">
	<div class="space-y-3">
		<p class="text-muted-foreground text-xs">
			The stitched context followed by the issue block — everything an agent with a
			<span class="font-mono">TINES_API_KEY</span> needs to take on this issue.
		</p>
		<div class="flex items-center justify-between gap-2">
			<div class="bg-muted inline-flex rounded-md p-0.5 text-xs">
				<button
					type="button"
					class="rounded px-2.5 py-1 {view === 'rendered'
						? 'bg-background shadow-sm'
						: 'text-muted-foreground'}"
					onclick={() => (view = 'rendered')}
				>
					Rendered
				</button>
				<button
					type="button"
					class="rounded px-2.5 py-1 {view === 'raw'
						? 'bg-background shadow-sm'
						: 'text-muted-foreground'}"
					onclick={() => (view = 'raw')}
				>
					Raw
				</button>
			</div>
			<Button size="sm" variant="outline" onclick={copy} disabled={text === null}>
				{#if copied}
					<IconCheck size={14} /> Copied
				{:else}
					<IconCopy size={14} /> Copy
				{/if}
			</Button>
		</div>
		{#if errorMessage}
			<p
				class="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-xs"
			>
				{errorMessage}
			</p>
		{:else if text === null}
			<p class="text-muted-foreground p-4 text-center text-sm">Loading…</p>
		{:else if view === 'rendered'}
			<div class="rounded-md border p-3 text-sm">
				<Markdown source={text} />
			</div>
		{:else}
			<pre
				class="bg-muted/40 overflow-x-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap">{text}</pre>
		{/if}
	</div>
</Modal>
