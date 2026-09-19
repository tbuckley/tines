<script lang="ts">
	import IconLock from '@tabler/icons-svelte/icons/lock';
	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import IconWorld from '@tabler/icons-svelte/icons/world';
	import IconUpload from '@tabler/icons-svelte/icons/upload';
	import WorkflowGraph from '$lib/components/WorkflowGraph.svelte';
	import { Button } from '$lib/components/ui/button/index.js';

	let { data } = $props();
	const used = $derived(
		data.workflows.filter((workflow) => (data.focusedOpenCounts?.[workflow.id] ?? 0) > 0)
	);
	const unused = $derived(
		data.workflows.filter((workflow) => (data.focusedOpenCounts?.[workflow.id] ?? 0) === 0)
	);
	const isDefault = (workflow: (typeof data.workflows)[number]) =>
		data.focus &&
		(workflow.id === data.focus.default_workflow_id ||
			(data.focus.default_workflow_id === null && workflow.is_system));
</script>

{#snippet workflowCard(workflow: (typeof data.workflows)[number])}
	<a
		href="/workflows/{workflow.id}"
		class="hover:border-ring/60 hover:bg-accent/30 rounded-lg border p-4 transition-colors"
	>
		<div class="mb-1 flex flex-wrap items-center gap-2">
			<h2 class="font-semibold">{workflow.name}</h2>
			{#if workflow.is_system}
				<span
					class="text-muted-foreground bg-muted inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs"
					><IconLock size={11} /> standard</span
				>
			{/if}
			{#if isDefault(workflow)}
				<span class="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-xs"
					>Project default</span
				>
			{/if}
		</div>
		{#if workflow.description}<p class="text-muted-foreground mb-3 line-clamp-1 text-sm">
				{workflow.description}
			</p>{/if}
		<div class="bg-muted/30 rounded-md border p-3"><WorkflowGraph {workflow} compact /></div>
		<p class="text-muted-foreground mt-3 text-xs">
			{workflow.states.length} state{workflow.states.length === 1 ? '' : 's'} · {workflow
				.transitions.length} transition{workflow.transitions.length === 1 ? '' : 's'} ·
			{#if data.focusedOpenCounts}
				{data.focusedOpenCounts[workflow.id] ?? 0} open issue{(data.focusedOpenCounts[
					workflow.id
				] ?? 0) === 1
					? ''
					: 's'}
			{:else}
				{workflow.issue_count} issue{workflow.issue_count === 1 ? '' : 's'}
			{/if}
		</p>
	</a>
{/snippet}

<svelte:head><title>Workflows · Tines</title></svelte:head>

<div
	class="mb-6 flex flex-col items-start gap-4 lg:flex-row lg:justify-between"
	data-testid="workflow-page-intro"
>
	<div>
		<h1 class="text-2xl font-semibold tracking-tight">Workflows</h1>
		<p class="text-muted-foreground mt-1 max-w-2xl text-sm">
			Your library of state machines. Any workflow can drive issues in any project.
		</p>
	</div>
	<div
		class="grid w-full gap-2 sm:w-auto sm:grid-cols-3 lg:flex lg:flex-wrap lg:justify-end"
		data-testid="workflow-actions"
	>
		<Button href="/publications" variant="outline">
			<IconWorld size={16} /> Public snapshots
		</Button>
		<Button href="/workflows/import" variant="outline">
			<IconUpload size={16} /> Install package
		</Button>
		<Button href="/workflows/new">
			<IconPlus size={16} /> New workflow
		</Button>
	</div>
</div>

{#if data.focusedOpenCounts}
	{#if used.length === 0}<p class="text-muted-foreground mb-4 text-sm">
			No open issues use a workflow in this project yet.
		</p>{/if}
	<div class="grid gap-4 md:grid-cols-2">
		{#each used as workflow (workflow.id)}{@render workflowCard(workflow)}{/each}
	</div>
	{#if unused.length > 0}
		<details class="mt-6">
			<summary class="cursor-pointer text-sm font-medium"
				>Other workflows in your library ({unused.length})</summary
			>
			<div class="mt-4 grid gap-4 md:grid-cols-2">
				{#each unused as workflow (workflow.id)}{@render workflowCard(workflow)}{/each}
			</div>
		</details>
	{/if}
{:else}
	<div class="grid gap-4 md:grid-cols-2">
		{#each data.workflows as workflow (workflow.id)}{@render workflowCard(workflow)}{/each}
	</div>
{/if}
