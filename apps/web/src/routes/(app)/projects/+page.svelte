<script lang="ts">
	import IconFolderPlus from '@tabler/icons-svelte/icons/folder-plus';
	import { afterNavigate, goto, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import CheckboxField from '$lib/components/CheckboxField.svelte';
	import NewProjectModal from '$lib/components/NewProjectModal.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { formatDate, relativeTime } from '$lib/format';
	import { navMemory } from '$lib/nav-memory.svelte';

	let { data } = $props();

	// The URL says what the grid shows; nav-memory only remembers it for the
	// Manage projects action, exactly as the Issues tab does with its filters.
	$effect(() => navMemory.recordProjects(page.url.search));

	const cards = $derived(
		data.showArchived
			? [
					...data.projects,
					...data.sharedProjects,
					...data.archivedProjects,
					...data.archivedSharedProjects
				]
			: [...data.projects, ...data.sharedProjects]
	);

	let createOpen = $state(false);

	// `/projects?new=1` is how other surfaces say "start here" (the Issues tab's
	// empty state). Consume the flag immediately so nav-memory never remembers
	// it and reopens the dialog on every later Projects click.
	//
	// This hangs off afterNavigate rather than an $effect because the link is
	// often clicked before this page's own JS has run — the empty state is the
	// first thing on a fresh account's Issues tab — which makes it a full page
	// load, as does pasting the URL. An $effect runs during hydration, before
	// the router has started, and `replaceState` is only usable after that:
	// it reaches into the router's root component and throws, which aborts the
	// flush that would have rendered the dialog. afterNavigate fires for the
	// initial load too, once the router is up.
	afterNavigate(() => {
		if (page.url.searchParams.get('new') !== '1') return;
		createOpen = true;
		replaceState('/projects', page.state);
	});

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
		{#if data.archivedProjects.length + data.archivedSharedProjects.length > 0}
			<CheckboxField
				class="text-muted-foreground text-sm"
				checked={data.showArchived}
				label="Show archived ({data.archivedProjects.length + data.archivedSharedProjects.length})"
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
					{#if project.viewer_role === 'member'}<span class="text-muted-foreground text-xs"
							>Shared by {project.owner?.name}</span
						>{/if}
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
					{#if project.viewer_role !== 'member'}· workflow: {workflowName(
							project.default_workflow_id
						)}{/if}
					· {project.archived_at !== null
						? `archived ${formatDate(project.archived_at)}`
						: `updated ${relativeTime(project.updated_at)}`}
				</p>
			</a>
		{/each}
	</div>
{/if}

<NewProjectModal bind:open={createOpen} starters={data.starters} />
