<script lang="ts">
	import { ApiError } from '@tines/shared';
	import IconChevronLeft from '@tabler/icons-svelte/icons/chevron-left';
	import IconCopy from '@tabler/icons-svelte/icons/copy';
	import IconLock from '@tabler/icons-svelte/icons/lock';
	import { slide } from 'svelte/transition';
	import { goto, invalidateAll } from '$app/navigation';
	import { api } from '$lib/api';
	import StateBadge from '$lib/components/StateBadge.svelte';
	import WorkflowEditor from '$lib/components/WorkflowEditor.svelte';
	import WorkflowGraph from '$lib/components/WorkflowGraph.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { prefersReducedMotion } from '$lib/format';

	let { data } = $props();

	let errorMessage = $state<string | null>(null);
	function showError(e: unknown) {
		errorMessage = e instanceof ApiError ? e.message : 'Something went wrong — try again.';
		setTimeout(() => (errorMessage = null), 6000);
	}

	/** Duplicate the workflow into the user's library (states by name). */
	async function copyToLibrary() {
		const wf = data.workflow;
		const nameOf = (id: string) => wf.states.find((s) => s.id === id)?.name ?? id;
		try {
			const copy = await api.createWorkflow({
				name: `${wf.name} (copy)`,
				description: wf.description,
				initial_state: nameOf(wf.initial_state_id),
				states: wf.states.map((s) => ({ name: s.name, category: s.category })),
				transitions: wf.transitions.map((t) => ({
					name: t.name,
					from: nameOf(t.from_state_id),
					to: nameOf(t.to_state_id)
				}))
			});
			await invalidateAll();
			await goto(`/workflows/${copy.id}`);
		} catch (err) {
			showError(err);
		}
	}

	async function deleteWorkflow() {
		if (!confirm(`Delete workflow "${data.workflow.name}"?`)) return;
		try {
			await api.deleteWorkflow(data.workflow.id);
			await goto('/workflows');
			await invalidateAll();
		} catch (err) {
			showError(err);
		}
	}
</script>

<svelte:head><title>{data.workflow.name} · Workflows · Tines</title></svelte:head>

<a
	href="/workflows"
	class="text-muted-foreground hover:text-foreground mb-3 inline-flex items-center gap-1 text-sm"
>
	<IconChevronLeft size={16} /> Workflows
</a>

<div class="mb-6 flex flex-wrap items-start justify-between gap-4">
	<div class="min-w-0">
		<h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
			{data.workflow.name}
			{#if data.workflow.is_system}
				<span class="text-muted-foreground bg-muted inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium">
					<IconLock size={12} /> standard · read-only
				</span>
			{/if}
		</h1>
		{#if data.workflow.description}
			<p class="text-muted-foreground mt-1 max-w-xl text-sm">{data.workflow.description}</p>
		{/if}
		<p class="text-muted-foreground mt-1 text-xs">
			{data.workflow.issue_count} issue{data.workflow.issue_count === 1 ? ' uses' : 's use'} this workflow
		</p>
	</div>
	<div class="flex gap-2">
		{#if data.workflow.is_system}
			<Button variant="outline" onclick={copyToLibrary}>
				<IconCopy size={16} /> Copy to library
			</Button>
		{:else}
			<Button
				variant="outline"
				class="text-destructive"
				disabled={data.workflow.issue_count > 0}
				title={data.workflow.issue_count > 0 ? 'Workflows with issues cannot be deleted' : undefined}
				onclick={deleteWorkflow}
			>
				Delete
			</Button>
		{/if}
	</div>
</div>

{#if errorMessage}
	<div
		class="border-destructive/40 bg-destructive/10 text-destructive mb-4 rounded-md border px-4 py-2.5 text-sm"
		transition:slide={{ duration: prefersReducedMotion() ? 0 : 180 }}
	>
		{errorMessage}
	</div>
{/if}

{#if data.workflow.is_system}
	<!-- read-only: graph plus a plain state table -->
	<div class="grid gap-8 lg:grid-cols-2">
		<div class="bg-muted/30 rounded-lg border p-4">
			<WorkflowGraph workflow={data.workflow} />
		</div>
		<div class="rounded-lg border">
			<table class="w-full text-sm">
				<thead>
					<tr class="text-muted-foreground border-b text-left text-xs">
						<th class="px-4 py-2.5 font-medium">State</th>
						<th class="px-4 py-2.5 font-medium">Category</th>
						<th class="px-4 py-2.5 font-medium"></th>
					</tr>
				</thead>
				<tbody>
					{#each data.workflow.states as st (st.id)}
						<tr class="border-b last:border-0">
							<td class="px-4 py-2.5"><StateBadge state={st} /></td>
							<td class="text-muted-foreground px-4 py-2.5">{st.category}</td>
							<td class="text-muted-foreground px-4 py-2.5 text-xs">
								{st.id === data.workflow.initial_state_id ? 'initial state' : ''}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
{:else}
	{#key data.workflow.updated_at}
		<WorkflowEditor
			workflow={data.workflow}
			onsave={async (request) => {
				await api.updateWorkflow(data.workflow.id, request);
				await invalidateAll();
			}}
		/>
	{/key}
{/if}

{#each data.workflow.warnings ?? [] as warning (warning)}
	<p class="mt-6 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
		{warning}
	</p>
{/each}
