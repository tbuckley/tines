<script lang="ts">
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import { pendingDialogs, type DialogRequest } from './dialogs.svelte';
	import { backgroundInert } from './background-inert.svelte';

	let current = $state<DialogRequest | null>(null);
	let open = $state(false);
	let settled = false;
	let releaseInert: (() => void) | null = null;

	$effect(() => {
		if (!open && !current && pendingDialogs.queue.length > 0) {
			current = pendingDialogs.queue.shift()!;
			settled = false;
			open = true;
		}
	});

	// bits-ui's Action button does not close the dialog on its own, so the
	// confirm path settles explicitly; dismissals (Cancel, Escape, overlay
	// click) land in onOpenChange and settle as false.
	function settle(confirmed: boolean) {
		if (!current || settled) return;
		settled = true;
		current.resolve(confirmed);
		open = false;
		releaseInert?.();
		releaseInert = null;
	}

	function onOpenChange(next: boolean) {
		if (!next) settle(false);
	}

	// bits-ui does not hide the page behind from assistive tech; the root layout
	// does, off this count. Ref-counted, so an AlertDialog raised from inside an
	// open Modal leaves the background inert until both have closed. The release
	// is synchronous in `settle` (with this cleanup as the destroy-time backstop)
	// so the background is focusable again by the time focus is restored to it.
	$effect(() => {
		if (!open) return;
		releaseInert ??= backgroundInert.acquire();
		return () => {
			releaseInert?.();
			releaseInert = null;
		};
	});

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
					onclick={() => settle(true)}
				>
					{current.confirmLabel ?? (current.kind === 'alert' ? 'OK' : 'Confirm')}
				</AlertDialog.Action>
			</AlertDialog.Footer>
		</AlertDialog.Content>
	</AlertDialog.Root>
{/if}
