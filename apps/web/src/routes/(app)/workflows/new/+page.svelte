<script lang="ts">
	import IconChevronLeft from '@tabler/icons-svelte/icons/chevron-left';
	import { goto, invalidateAll } from '$app/navigation';
	import { api } from '$lib/api';
	import WorkflowEditor from '$lib/components/WorkflowEditor.svelte';
</script>

<svelte:head><title>New workflow · Tines</title></svelte:head>

<a
	href="/workflows"
	class="text-muted-foreground hover:text-foreground mb-3 inline-flex items-center gap-1 text-sm"
>
	<IconChevronLeft size={16} /> Workflows
</a>

<h1 class="mb-6 text-2xl font-semibold tracking-tight">New workflow</h1>

<WorkflowEditor
	saveLabel="Create workflow"
	onsave={async (request) => {
		const workflow = await api.createWorkflow(request);
		await invalidateAll();
		await goto(`/workflows/${workflow.id}`);
	}}
/>
