<script lang="ts">
	import { ApiError } from '@tines/shared';
	import IconFolderPlus from '@tabler/icons-svelte/icons/folder-plus';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import CheckboxField from '$lib/components/CheckboxField.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import PendingButton from '$lib/components/PendingButton.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { formatDate, relativeTime } from '$lib/format';
	import { navMemory } from '$lib/nav-memory.svelte';

	let { data } = $props();

	// The URL says what the grid shows; nav-memory only remembers it for the
	// Projects nav tab, exactly as the Issues tab does with its filters.
	$effect(() => navMemory.recordProjects(page.url.search));

	const cards = $derived(data.showArchived ? [...data.projects, ...data.archivedProjects] : data.projects);

	let createOpen = $state(false);
	let name = $state('');
	let description = $state('');
	let initialPrompt = $state('');
	let creating = $state(false);
	let createError = $state<string | null>(null);

	async function create(e: SubmitEvent) {
		e.preventDefault();
		if (creating) return;
		creating = true;
		createError = null;
		try {
			const project = await api.createProject({
				name,
				description,
				initial_prompt: initialPrompt.trim() || undefined
			});
			createOpen = false;
			name = '';
			description = '';
			initialPrompt = '';
			await invalidateAll();
			await goto(`/projects/${project.id}`);
		} catch (err) {
			createError = err instanceof ApiError ? err.message : 'Failed to create project.';
		} finally {
			creating = false;
		}
	}

	async function toggleArchived(show: boolean) {
		await goto(show ? '/projects?archived=1' : '/projects', { keepFocus: true, noScroll: true });
	}

	function workflowName(id: string | null): string {
		if (!id) return 'Standard (default)';
		return data.workflows.find((w) => w.id === id)?.name ?? 'Unknown';
	}
</script>

<svelte:head><title>Projects · Tines</title></svelte:head>

<div class="mb-6 flex items-center justify-between">
	<h1 class="text-2xl font-semibold tracking-tight">Projects</h1>
	<div class="flex items-center gap-4">
		{#if data.archivedProjects.length > 0}
			<CheckboxField
				class="text-muted-foreground text-sm"
				checked={data.showArchived}
				label="Show archived ({data.archivedProjects.length})"
				onCheckedChange={toggleArchived}
			/>
		{/if}
		<Button onclick={() => (createOpen = true)}>
			<IconFolderPlus size={16} /> New project
		</Button>
	</div>
</div>

{#if cards.length === 0}
	<div class="text-muted-foreground rounded-lg border border-dashed p-12 text-center text-sm">
		No projects yet. Create one to start tracking issues.
	</div>
{:else}
	<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
		{#each cards as project (project.id)}
			<a
				href="/projects/{project.id}"
				class="hover:border-ring/60 hover:bg-accent/30 rounded-lg border p-4 transition-colors {project.archived_at !==
				null
					? 'opacity-70'
					: ''}"
			>
				<h2 class="flex items-center gap-2 font-semibold">
					{project.name}
					{#if project.archived_at !== null}
						<span
							class="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs font-medium"
						>
							Archived
						</span>
					{/if}
				</h2>
				{#if project.description}
					<p class="text-muted-foreground mt-1 line-clamp-2 text-sm">{project.description}</p>
				{/if}
				<p class="text-muted-foreground mt-3 text-xs">
					{project.issue_count} issue{project.issue_count === 1 ? '' : 's'}
					· workflow: {workflowName(project.default_workflow_id)}
					· {project.archived_at !== null
						? `archived ${formatDate(project.archived_at)}`
						: `updated ${relativeTime(project.updated_at)}`}
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
			<Textarea
				id="project-description"
				bind:value={description}
				rows={3}
				placeholder="What is this project about?"
			/>
		</div>
		<div class="space-y-1.5">
			<label class="text-sm font-medium" for="project-prompt">
				House conventions <span class="text-muted-foreground font-normal">(optional)</span>
			</label>
			<Textarea
				id="project-prompt"
				bind:value={initialPrompt}
				rows={4}
				placeholder="Stitched into the prompt of every agent working in this project — style rules, commands that must pass, where things live…"
			/>
			<p class="text-muted-foreground text-xs">
				Saved as a project-scoped context prompt named “conventions”; editable any time.
			</p>
		</div>
		{#if createError}
			<p class="text-destructive text-sm">{createError}</p>
		{/if}
		<div class="flex flex-wrap justify-end gap-2">
			<Button
				type="button"
				variant="ghost"
				disabled={creating}
				onclick={() => (createOpen = false)}
			>
				Cancel
			</Button>
			<PendingButton
				type="submit"
				pending={creating}
				pendingLabel="Creating…"
				disabled={!name.trim()}
			>
				Create project
			</PendingButton>
		</div>
	</form>
</Modal>
