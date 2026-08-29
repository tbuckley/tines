<script lang="ts">
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import { pendingDialogs, type DialogRequest } from './dialogs.svelte';

	let current = $state<DialogRequest | null>(null);
	let open = $state(false);
	let confirmed = false;

	$effect(() => {
		if (!open && !current && pendingDialogs.queue.length > 0) {
			current = pendingDialogs.queue.shift()!;
			confirmed = false;
			open = true;
		}
	});

	// Every way out (confirm, cancel, Escape, overlay click) lands here; only a
	// confirm-button click sets `confirmed` first.
	function onOpenChange(next: boolean) {
		if (!next && current) current.resolve(confirmed);
	}

	// Keep the dialog mounted until the close animation finishes, then let the
	// effect above pick up the next queued request.
	function onOpenChangeComplete(next: boolean) {
		if (!next) current = null;
	}
</script>

{#if current}
	<AlertDialog.Root bind:open {onOpenChange} {onOpenChangeComplete}>
		<AlertDialog.Content>
			<AlertDialog.Header>
				<AlertDialog.Title>{current.title}</AlertDialog.Title>
				{#if current.body}
					<AlertDialog.Description>{current.body}</AlertDialog.Description>
				{/if}
			</AlertDialog.Header>
			{#if current.items?.length}
				<ul class="text-muted-foreground max-h-48 space-y-1 overflow-y-auto text-sm">
					{#each current.items as item (item)}
						<li>· {item}</li>
					{/each}
				</ul>
			{/if}
			<AlertDialog.Footer>
				{#if current.kind === 'confirm'}
					<AlertDialog.Cancel>{current.cancelLabel ?? 'Cancel'}</AlertDialog.Cancel>
				{/if}
				<AlertDialog.Action
					variant={current.destructive ? 'destructive' : 'default'}
					onclick={() => (confirmed = true)}
				>
					{current.confirmLabel ?? (current.kind === 'alert' ? 'OK' : 'Confirm')}
				</AlertDialog.Action>
			</AlertDialog.Footer>
		</AlertDialog.Content>
	</AlertDialog.Root>
{/if}
