<script lang="ts">
	import { ApiError } from '@tines/shared';
	import IconFolderPlus from '@tabler/icons-svelte/icons/folder-plus';
	import { goto, invalidateAll } from '$app/navigation';
	import { api } from '$lib/api';
	import Modal from '$lib/components/Modal.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { relativeTime } from '$lib/format';

	let { data } = $props();

	let createOpen = $state(false);
	let name = $state('');
	let description = $state('');
	let creating = $state(false);
	let createError = $state<string | null>(null);

	async function create(e: SubmitEvent) {
		e.preventDefault();
		if (creating) return;
		creating = true;
		createError = null;
		try {
			const project = await api.createProject({ name, description });
			createOpen = false;
			name = '';
			description = '';
			await invalidateAll();
			await goto(`/projects/${project.id}`);
		} catch (err) {
			createError = err instanceof ApiError ? err.message : 'Failed to create project.';
		} finally {
			creating = false;
		}
	}

	function workflowName(id: string | null): string {
		if (!id) return 'Standard (default)';
		return data.workflows.find((w) => w.id === id)?.name ?? 'Unknown';
	}
</script>

<svelte:head><title>Projects · Tines</title></svelte:head>

<div class="mb-6 flex items-center justify-between">
	<h1 class="text-2xl font-semibold tracking-tight">Projects</h1>
	<Button onclick={() => (createOpen = true)}>
		<IconFolderPlus size={16} /> New project
	</Button>
</div>

{#if data.projects.length === 0}
	<div class="text-muted-foreground rounded-lg border border-dashed p-12 text-center text-sm">
		No projects yet. Create one to start tracking issues.
	</div>
{:else}
	<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
		{#each data.projects as project (project.id)}
			<a
				href="/projects/{project.id}"
				class="hover:border-ring/60 hover:bg-accent/30 rounded-lg border p-4 transition-colors"
			>
				<h2 class="font-semibold">{project.name}</h2>
				{#if project.description}
					<p class="text-muted-foreground mt-1 line-clamp-2 text-sm">{project.description}</p>
				{/if}
				<p class="text-muted-foreground mt-3 text-xs">
					{project.issue_count} issue{project.issue_count === 1 ? '' : 's'}
					· workflow: {workflowName(project.default_workflow_id)}
					· updated {relativeTime(project.updated_at)}
				</p>
			</a>
		{/each}
	</div>
{/if}

<Modal bind:open={createOpen} title="New project">
	<form onsubmit={create} class="space-y-4">
		<div class="space-y-1.5">
			<label class="text-sm font-medium" for="project-name">Name</label>
			<Input id="project-name" bind:value={name} placeholder="e.g. website" required />
		</div>
		<div class="space-y-1.5">
			<label class="text-sm font-medium" for="project-description">Description</label>
			<Textarea id="project-description" bind:value={description} rows={3} placeholder="What is this project about?" />
		</div>
		{#if createError}
			<p class="text-destructive text-sm">{createError}</p>
		{/if}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="ghost" onclick={() => (createOpen = false)}>Cancel</Button>
			<Button type="submit" disabled={creating || !name.trim()}>
				{creating ? 'Creating…' : 'Create project'}
			</Button>
		</div>
	</form>
</Modal>
