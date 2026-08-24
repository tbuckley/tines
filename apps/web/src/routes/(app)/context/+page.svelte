<script lang="ts">
	import type { ContextItem } from '@tines/shared';
	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import IconSearch from '@tabler/icons-svelte/icons/search';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import ContextItemEditor from '$lib/components/ContextItemEditor.svelte';
	import ContextItemList from '$lib/components/ContextItemList.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Select } from '$lib/components/ui/select/index.js';

	let { data } = $props();

	let editorOpen = $state(false);
	let editing = $state<ContextItem | null>(null);

	function openCreate() {
		editing = null;
		editorOpen = true;
	}
	function openEdit(item: ContextItem) {
		editing = item;
		editorOpen = true;
	}

	// Filters live in the URL so the tab is shareable/bookmarkable.
	// svelte-ignore state_referenced_locally
	let search = $state(data.filters.q ?? '');
	function setParam(key: string, value: string) {
		const params = new URLSearchParams(page.url.searchParams);
		if (value) params.set(key, value);
		else params.delete(key);
		goto(`/context${params.size ? `?${params}` : ''}`, { keepFocus: true, noScroll: true });
	}
</script>

<svelte:head><title>Context · Tines</title></svelte:head>

<div class="mb-6 flex flex-wrap items-center justify-between gap-4">
	<div>
		<h1 class="text-2xl font-semibold tracking-tight">Context</h1>
		<p class="text-muted-foreground mt-1 text-sm">
			Prompts, skills, and repos that scope to projects, workflow states, and issues — and merge
			into each issue's effective context.
		</p>
	</div>
	<Button onclick={openCreate}><IconPlus size={16} /> New item</Button>
</div>

<div class="mb-4 flex flex-wrap items-center gap-2">
	<div class="relative">
		<IconSearch size={14} class="text-muted-foreground absolute top-1/2 left-2.5 -translate-y-1/2" />
		<form
			onsubmit={(e) => {
				e.preventDefault();
				setParam('q', search.trim());
			}}
		>
			<Input bind:value={search} placeholder="Search context…" class="h-9 w-56 pl-8" />
		</form>
	</div>
	<Select
		value={data.filters.kind ?? ''}
		onchange={(e) => setParam('kind', e.currentTarget.value)}
		class="h-9 w-auto text-sm"
		aria-label="Filter by kind"
	>
		<option value="">All kinds</option>
		<option value="prompt">Prompts</option>
		<option value="skill">Skills</option>
		<option value="repo">Repos</option>
	</Select>
	<Select
		value={data.filters.project ?? ''}
		onchange={(e) => setParam('project', e.currentTarget.value)}
		class="h-9 w-auto text-sm"
		aria-label="Filter by project"
	>
		<option value="">All projects</option>
		{#each data.projects as project (project.id)}
			<option value={project.id}>{project.name}</option>
		{/each}
	</Select>
</div>

<ContextItemList
	items={data.items}
	onselect={openEdit}
	emptyMessage={data.filters.kind || data.filters.project || data.filters.q
		? 'No context items match these filters.'
		: 'No context items yet. Attach a prompt, skill, or repo to a project, workflow state, or issue.'}
/>

<ContextItemEditor
	bind:open={editorOpen}
	item={editing}
	projects={data.projects}
	workflows={data.workflows}
	onsaved={invalidateAll}
/>
