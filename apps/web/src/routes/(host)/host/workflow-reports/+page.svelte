<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { navigating } from '$app/state';
	let { data } = $props();
	let urgentTarget = $state('');
	let urgentReason = $state('');
	let busy = $state(false);
	let message = $state('');
	let pendingUrgent = $state<Record<string, unknown> | null>(null);
	let pendingRecovery = $state<{
		publisherId: string;
		body: Record<string, unknown>;
	} | null>(null);
	let recoveryReason = $state('');

	function snapshotId(value: string) {
		if (/^[A-Za-z0-9_-]{20,100}$/.test(value)) return value;
		try {
			const url = new URL(value, location.origin);
			if (url.origin !== location.origin || url.search || url.hash) return null;
			return /^\/p\/([A-Za-z0-9_-]{20,100})$/.exec(url.pathname)?.[1] ?? null;
		} catch {
			return null;
		}
	}

	async function urgentDisable() {
		const id = snapshotId(urgentTarget);
		if (!id || !urgentReason.trim()) {
			message = 'Enter an exact public URL or snapshot ID and a reason.';
			return;
		}
		busy = true;
		message = '';
		const requestBody = pendingUrgent ?? {
			request_id: crypto.randomUUID(),
			action: 'disable',
			target: { snapshot_id: id },
			reason: urgentReason
		};
		pendingUrgent = requestBody;
		try {
			const response = await fetch('/api/v1/host/workflow-moderation/decisions', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(requestBody)
			});
			const responseBody = await response.json();
			if (!response.ok) {
				pendingUrgent = null;
				if (responseBody?.error?.code === 'moderation_state_changed') await invalidateAll();
				throw new Error(responseBody?.error?.message ?? 'Could not disable snapshot.');
			}
			pendingUrgent = null;
			message = 'Snapshot disabled.';
			urgentTarget = '';
			urgentReason = '';
			await invalidateAll();
		} catch (error) {
			message = error instanceof Error ? error.message : 'Could not disable snapshot.';
		} finally {
			busy = false;
		}
	}

	async function unsuspend(publisher: (typeof data.suspendedPublishers)[number]) {
		if (!recoveryReason.trim()) {
			message = 'Enter a recovery reason.';
			return;
		}
		busy = true;
		message = '';
		const requestBody =
			pendingRecovery?.publisherId === publisher.publisher_id
				? pendingRecovery.body
				: {
						request_id: crypto.randomUUID(),
						action: 'unsuspend',
						target: {
							publisher_id: publisher.publisher_id,
							snapshot_id: publisher.snapshot_id ?? undefined
						},
						reason: recoveryReason,
						expected_publisher_version: publisher.status_version
					};
		pendingRecovery = { publisherId: publisher.publisher_id, body: requestBody };
		try {
			const response = await fetch('/api/v1/host/workflow-moderation/decisions', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(requestBody)
			});
			const responseBody = await response.json();
			if (!response.ok) {
				pendingRecovery = null;
				if (responseBody?.error?.code === 'moderation_state_changed') await invalidateAll();
				throw new Error(responseBody?.error?.message ?? 'Could not unsuspend publisher.');
			}
			pendingRecovery = null;
			recoveryReason = '';
			message = 'Publisher unsuspended.';
			await invalidateAll();
		} catch (error) {
			message = error instanceof Error ? error.message : 'Could not unsuspend publisher.';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head
	><title>Workflow moderation · Tines</title><meta name="robots" content="noindex" /></svelte:head
>
<h1 class="text-2xl font-semibold">Workflow report queue</h1>
{#if navigating}<p class="mt-3 text-sm" role="status">Loading report queue…</p>{/if}
<nav class="mt-4 flex flex-wrap gap-2" aria-label="Report filters">
	{#each ['unread', 'open', 'resolved', 'all'] as filter}<a
			class="rounded-md border px-3 py-2 capitalize"
			href="?filter={filter}">{filter}</a
		>{/each}
</nav>

<section class="mt-8 rounded-lg border p-4" aria-labelledby="urgent-title">
	<h2 id="urgent-title" class="font-semibold">Urgent removal</h2>
	<p class="text-muted-foreground mt-1 text-sm">
		Disable an exact public snapshot without waiting for a report.
	</p>
	<form
		class="mt-4 grid gap-3 sm:grid-cols-2"
		onsubmit={(event) => {
			event.preventDefault();
			void urgentDisable();
		}}
	>
		<label class="text-sm"
			>Public URL or snapshot ID<input
				class="mt-1 min-h-10 w-full rounded-md border bg-transparent px-3"
				bind:value={urgentTarget}
			/></label
		>
		<label class="text-sm"
			>Reason shown to publisher<input
				class="mt-1 min-h-10 w-full rounded-md border bg-transparent px-3"
				bind:value={urgentReason}
			/></label
		>
		<button
			class="bg-destructive text-destructive-foreground min-h-10 rounded-md px-4 sm:col-span-2 sm:w-fit"
			disabled={busy}>{busy ? 'Disabling…' : 'Disable now'}</button
		>
	</form>
	{#if message}<p class="mt-3 text-sm" role="status">{message}</p>{/if}
</section>

<section class="mt-8 rounded-lg border p-4" aria-labelledby="recovery-title">
	<h2 id="recovery-title" class="font-semibold">Suspended publishers</h2>
	<p class="text-muted-foreground mt-1 text-sm">
		Recovery remains available even when no snapshot survives.
	</p>
	{#if data.suspendedPublishers.length === 0}<p class="mt-3 text-sm">No suspended publishers.</p>
	{:else}<label class="mt-3 block text-sm"
			>Recovery reason<input
				class="mt-1 min-h-10 w-full rounded-md border bg-transparent px-3"
				bind:value={recoveryReason}
			/></label
		>
		<ul class="mt-3 space-y-2">
			{#each data.suspendedPublishers as publisher}<li
					class="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm"
				>
					<span
						><b>{publisher.display_name}</b><br /><span class="text-muted-foreground"
							>{publisher.reason}</span
						><span class="text-muted-foreground block text-xs"
							>{publisher.affected_snapshot_count} stored snapshot{publisher.affected_snapshot_count ===
							1
								? ''
								: 's'}</span
						></span
					><span class="flex gap-2"
						>{#if publisher.snapshot_id}<a
								class="rounded-md border px-3 py-2"
								href="/host/workflow-reports/{publisher.snapshot_id}">Inspect</a
							>{/if}<button
							class="rounded-md border px-3 py-2"
							disabled={busy}
							onclick={() => unsuspend(publisher)}>Unsuspend</button
						></span
					>
				</li>{/each}
		</ul>
		{#if data.publisher_next_cursor}<a
				class="mt-3 inline-block rounded-md border px-3 py-2"
				href="?filter={data.filter}&publisher_cursor={encodeURIComponent(
					data.publisher_next_cursor
				)}">More suspended publishers</a
			>{/if}{/if}
</section>

<section class="mt-8" aria-labelledby="cases-title">
	<h2 id="cases-title" class="font-semibold">Cases</h2>
	{#if data.items.length === 0}<p class="text-muted-foreground mt-3 rounded-lg border p-6">
			No reports in this view.
		</p>
	{:else}<div class="mt-3 space-y-3">
			{#each data.items as item}<a
					class="hover:bg-muted/40 block rounded-lg border p-4"
					href="/host/workflow-reports/{item.snapshot_id}"
				>
					<div class="flex flex-wrap justify-between gap-2">
						<b>{item.title}</b><span>{item.total} report{item.total === 1 ? '' : 's'}</span>
					</div>
					<p class="text-muted-foreground mt-1 text-sm">
						{item.display_name} · {item.version > item.read_through_version
							? 'Unread'
							: item.version > item.resolved_through_version
								? 'Open'
								: 'Resolved'} · {new Date(item.latest_report_at).toLocaleString()}
					</p>
				</a>{/each}
		</div>{/if}
	{#if data.next_cursor}<a
			class="mt-4 inline-block rounded-md border px-3 py-2"
			href="?filter={data.filter}&cursor={encodeURIComponent(data.next_cursor)}">Next page</a
		>{/if}
</section>
