<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	let { data } = $props();
	let reason = $state('');
	let busy = $state('');
	let message = $state('');
	const title = $derived(
		data.document
			? (data.document.workflows.find(
					(workflow: { id: string }) => workflow.id === data.document!.main_workflow_id
				)?.name ?? 'Stored snapshot')
			: 'Stored snapshot'
	);

	onMount(() => {
		if (data.case && data.case.version > data.case.read_through_version)
			void fetch(`/api/v1/host/workflow-moderation/cases/${data.snapshot_id}/read`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ through_version: data.case.version })
			});
	});

	async function decide(action: 'dismiss' | 'disable' | 'restore' | 'suspend' | 'unsuspend') {
		if (!reason.trim()) {
			message = 'Enter a reason for this decision.';
			return;
		}
		busy = action;
		message = '';
		const publisher = action === 'suspend' || action === 'unsuspend';
		try {
			const response = await fetch('/api/v1/host/workflow-moderation/decisions', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					request_id: crypto.randomUUID(),
					action,
					target: publisher
						? { publisher_id: data.publisher_id, snapshot_id: data.snapshot_id }
						: { snapshot_id: data.snapshot_id },
					reason,
					...(publisher
						? { expected_publisher_version: data.publisher_status_version }
						: { expected_snapshot_version: data.status_version }),
					...(data.case && (action === 'dismiss' || action === 'disable')
						? { case_through_version: data.case.version }
						: {})
				})
			});
			const body = await response.json();
			if (!response.ok) throw new Error(body?.error?.message ?? 'Decision failed.');
			message = `${action} recorded.`;
			reason = '';
			await invalidateAll();
		} catch (error) {
			message = error instanceof Error ? error.message : 'Decision failed.';
		} finally {
			busy = '';
		}
	}
</script>

<svelte:head
	><title>Moderate snapshot · Tines</title><meta name="robots" content="noindex" /></svelte:head
>
<a class="underline" href="/host/workflow-reports">← Report queue</a>
<h1 class="mt-4 text-2xl font-semibold">{title}</h1>
<p class="text-muted-foreground mt-1 text-sm">{data.metadata.display_name} · {data.snapshot_id}</p>

<div class="mt-6 grid min-w-0 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
	<section class="min-w-0 rounded-lg border p-4" aria-labelledby="inspection-title">
		<h2 id="inspection-title" class="font-semibold">Complete inert inspection</h2>
		<p class="text-muted-foreground mt-1 text-xs">Text only. Links and actions are disabled.</p>
		<pre
			class="bg-muted mt-4 max-h-[65vh] overflow-auto rounded p-4 text-xs break-words whitespace-pre-wrap">{data.document
				? JSON.stringify(data.document, null, 2)
				: data.raw_document_json}</pre>
	</section>
	<aside class="min-w-0 rounded-lg border p-4">
		<h2 class="font-semibold">Decision</h2>
		<p class="text-muted-foreground mt-1 text-sm">
			Host: {data.host_state}. Publisher: {data.suspension ? 'suspended' : 'active'}.
		</p>
		<label class="mt-4 block text-sm"
			>Reason<textarea
				class="mt-1 min-h-28 w-full rounded-md border bg-transparent p-3"
				bind:value={reason}></textarea></label
		>
		<p class="text-muted-foreground mt-1 text-xs">
			Disable and suspend reasons are shown to the publisher. Do not include reporter details.
		</p>
		<div class="mt-4 flex flex-wrap gap-2">
			{#if data.host_state === 'active'}<button
					class="bg-destructive text-destructive-foreground min-h-10 rounded-md px-3"
					disabled={!!busy}
					onclick={() => decide('disable')}>Disable now</button
				>{:else}<button
					class="min-h-10 rounded-md border px-3"
					disabled={!!busy}
					onclick={() => decide('restore')}>Restore</button
				>{/if}
			{#if data.suspension}<button
					class="min-h-10 rounded-md border px-3"
					disabled={!!busy}
					onclick={() => decide('unsuspend')}>Unsuspend</button
				>{:else}<button
					class="min-h-10 rounded-md border px-3"
					disabled={!!busy}
					onclick={() => decide('suspend')}>Suspend publisher</button
				>{/if}
			{#if data.case && data.case.version > data.case.resolved_through_version}<button
					class="min-h-10 rounded-md border px-3"
					disabled={!!busy}
					onclick={() => decide('dismiss')}>Dismiss reports</button
				>{/if}
		</div>
		{#if message}<p class="mt-3 text-sm" role="status">{message}</p>{/if}
		<h2 class="mt-8 font-semibold">Reports</h2>
		{#if data.reports.length === 0}<p class="text-muted-foreground mt-2 text-sm">
				No reports.
			</p>{:else}<ul class="mt-2 space-y-3">
				{#each data.reports as report}<li class="rounded-md border p-3 text-sm">
						<b>{report.reason}</b> · {report.count}
						<p class="mt-1 whitespace-pre-wrap">{report.note || 'No details provided.'}</p>
					</li>{/each}
			</ul>{/if}
		<h2 class="mt-8 font-semibold">Decision history</h2>
		{#if data.audit.length === 0}<p class="text-muted-foreground mt-2 text-sm">
				No decisions.
			</p>{:else}<ul class="mt-2 space-y-2">
				{#each data.audit as decision}<li class="rounded-md border p-3 text-sm">
						<b>{decision.action}</b> by {decision.actor_name}<br />
						<span class="text-muted-foreground"
							>{new Date(decision.created_at).toLocaleString()} · {decision.reason}</span
						>
					</li>{/each}
			</ul>{/if}
	</aside>
</div>
