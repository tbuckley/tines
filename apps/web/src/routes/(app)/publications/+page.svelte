<script lang="ts">
	import { ApiError } from '@tines/shared';
	import IconArrowLeft from '@tabler/icons-svelte/icons/arrow-left';
	import IconExternalLink from '@tabler/icons-svelte/icons/external-link';
	import { invalidateAll } from '$app/navigation';
	import { api } from '$lib/api';
	import { confirmDialog } from '$lib/components/dialogs.svelte';
	import { Button } from '$lib/components/ui/button/index.js';

	let { data } = $props();
	let busyId = $state<string | null>(null);
	let status = $state('');

	async function change(snapshotId: string, action: 'withdraw' | 'restore') {
		if (
			action === 'withdraw' &&
			!(await confirmDialog({
				title: 'Withdraw this public snapshot?',
				body: 'Hosted inspection, download, and new installs stop immediately. Downloaded copies and completed installs remain independent.',
				confirmLabel: 'Withdraw snapshot',
				destructive: true
			}))
		)
			return;
		busyId = snapshotId;
		status = '';
		try {
			if (action === 'withdraw') await api.withdrawPublication(snapshotId);
			else await api.restorePublication(snapshotId);
			status = action === 'withdraw' ? 'Snapshot withdrawn.' : 'Snapshot restored.';
			await invalidateAll();
		} catch (error) {
			status = error instanceof ApiError ? error.message : 'The snapshot could not be updated.';
		} finally {
			busyId = null;
		}
	}
</script>

<svelte:head><title>Public snapshots · Tines</title></svelte:head>

<a
	href="/workflows"
	class="text-muted-foreground hover:text-foreground mb-4 inline-flex min-h-10 items-center gap-1 text-sm"
>
	<IconArrowLeft size={16} /> Workflows
</a>
<div class="mb-6">
	<h1 class="text-2xl font-semibold tracking-tight">Public snapshots</h1>
	<p class="text-muted-foreground mt-1 max-w-2xl text-sm">
		Manage immutable snapshots you published. Withdrawing a hosted snapshot cannot recall downloaded
		copies or completed installations.
	</p>
</div>

{#if !data.creation.enabled}
	<div class="bg-muted/40 mb-6 rounded-lg border p-4 text-sm">
		<b>New publishing is disabled on this host.</b>
		Existing active snapshots remain available; withdrawal is still allowed.
	</div>
{/if}

{#if status}<p class="mb-4 text-sm" role="status" aria-live="polite">{status}</p>{/if}

{#if data.publications.length === 0}
	<p class="text-muted-foreground rounded-lg border p-6 text-sm">No public snapshots yet.</p>
{:else}
	<div class="space-y-3">
		{#each data.publications as publication (publication.snapshot_id)}
			<article class="min-w-0 rounded-lg border p-4">
				{#if publication.host_removal || publication.suspension}
					<div class="bg-muted/40 mb-4 rounded-md border p-3 text-sm">
						{#if publication.host_removal}<p>
								<b>Removed by the host:</b>
								{publication.host_removal.reason}
							</p>{/if}
						{#if publication.suspension}<p>
								<b>Publishing suspended:</b>
								{publication.suspension.reason}
							</p>{/if}
						<p class="mt-2">
							{#if data.appealContact}<a
									class="text-primary underline"
									href={data.appealContact}
									rel="noreferrer">Appeal this decision</a
								>{:else}Appeal contact is not configured.{/if}
						</p>
					</div>
				{/if}
				<div class="flex flex-wrap items-start justify-between gap-3">
					<div class="min-w-0">
						<h2 class="font-semibold">{publication.metadata.display_name}</h2>
						<p class="text-muted-foreground mt-1 text-xs">
							Published {new Date(publication.published_at).toLocaleString()} · MIT · {publication.owner_state ===
								'published' && publication.host_state === 'active'
								? 'Hosted'
								: 'Unavailable'}
						</p>
						<p class="text-muted-foreground mt-2 font-mono text-xs break-all">
							{publication.bytes_sha256}
						</p>
					</div>
					<div class="flex flex-wrap gap-2">
						{#if publication.owner_state === 'published' && publication.host_state === 'active'}
							<Button
								variant="outline"
								href={publication.public_url}
								target="_blank"
								rel="noopener noreferrer"
							>
								<IconExternalLink size={16} /> Inspect
							</Button>
							<Button
								variant="outline"
								class="text-destructive"
								disabled={busyId === publication.snapshot_id}
								onclick={() => change(publication.snapshot_id, 'withdraw')}>Withdraw</Button
							>
						{:else if publication.owner_state === 'withdrawn' && publication.host_state === 'active'}
							<Button
								disabled={!data.creation.enabled || busyId === publication.snapshot_id}
								onclick={() => change(publication.snapshot_id, 'restore')}>Restore</Button
							>
						{/if}
					</div>
				</div>
			</article>
		{/each}
	</div>
{/if}
