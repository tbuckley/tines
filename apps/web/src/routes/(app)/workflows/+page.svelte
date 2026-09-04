<script lang="ts">
	import IconLock from '@tabler/icons-svelte/icons/lock';
	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import WorkflowGraph from '$lib/components/WorkflowGraph.svelte';
	import { Button } from '$lib/components/ui/button/index.js';

	let { data } = $props();
</script>

<svelte:head><title>Workflows · Tines</title></svelte:head>

<div class="mb-2 flex items-center justify-between">
	<h1 class="text-2xl font-semibold tracking-tight">Workflows</h1>
	<Button href="/workflows/new">
		<IconPlus size={16} /> New workflow
	</Button>
</div>
<p class="text-muted-foreground mb-6 max-w-2xl text-sm">
	Your library of state machines. Any workflow can drive issues in any project.
</p>

<div class="grid gap-4 md:grid-cols-2">
	{#each data.workflows as workflow (workflow.id)}
		<a
			href="/workflows/{workflow.id}"
			class="hover:border-ring/60 hover:bg-accent/30 rounded-lg border p-4 transition-colors"
		>
			<div class="mb-1 flex items-center gap-2">
				<h2 class="font-semibold">{workflow.name}</h2>
				{#if workflow.is_system}
					<span
						class="text-muted-foreground bg-muted inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs"
					>
						<IconLock size={11} /> standard
					</span>
				{/if}
			</div>
			{#if workflow.description}
				<p class="text-muted-foreground mb-3 line-clamp-1 text-sm">{workflow.description}</p>
			{/if}
			<div class="bg-muted/30 rounded-md border p-3">
				<WorkflowGraph {workflow} compact />
			</div>
			<p class="text-muted-foreground mt-3 text-xs">
				{workflow.states.length} state{workflow.states.length === 1 ? '' : 's'}
				· {workflow.transitions.length} transition{workflow.transitions.length === 1 ? '' : 's'}
				· {workflow.issue_count} issue{workflow.issue_count === 1 ? '' : 's'}
			</p>
		</a>
	{/each}
</div>
