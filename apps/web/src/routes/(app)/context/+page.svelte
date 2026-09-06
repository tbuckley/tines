<script lang="ts">
	import type { ContextItem } from '@tines/shared';
	import {
		AGENT_GUIDELINES_BODY,
		AGENT_GUIDELINES_DESCRIPTION,
		AGENT_GUIDELINES_NAME,
		ApiError
	} from '@tines/shared';
	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import IconSearch from '@tabler/icons-svelte/icons/search';
	import IconTags from '@tabler/icons-svelte/icons/tags';
	import IconSparkles from '@tabler/icons-svelte/icons/sparkles';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { api } from '$lib/api';
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

	let seeding = $state(false);
	let seedError = $state<string | null>(null);
	async function seedGuidelines() {
		if (seeding) return;
		seeding = true;
		seedError = null;
		try {
			await api.createContextItem({
				kind: 'prompt',
				name: AGENT_GUIDELINES_NAME,
				description: AGENT_GUIDELINES_DESCRIPTION,
				body: AGENT_GUIDELINES_BODY
			});
			await invalidateAll();
		} catch (err) {
			seedError = err instanceof ApiError ? err.message : 'Failed to add the starter guidance.';
		} finally {
			seeding = false;
		}
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
			Prompts, skills, and repos that scope to projects, workflow states, issue labels, and issues —
			and merge into each issue's effective context.
		</p>
	</div>
	<div class="flex items-center gap-2">
		<Button variant="outline" href="/labels"><IconTags size={16} /> Labels</Button>
		<Button onclick={openCreate}><IconPlus size={16} /> New item</Button>
	</div>
</div>

<div class="mb-4 flex flex-wrap items-center gap-2">
	<div class="relative">
		<IconSearch
			size={14}
			class="text-muted-foreground absolute top-1/2 left-2.5 -translate-y-1/2"
		/>
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
		<option value="artifact">Artifacts</option>
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
		{#if data.archivedProject}
			<option value={data.archivedProject.id}>{data.archivedProject.name} (archived)</option>
		{/if}
	</Select>
	<Select
		value={data.filters.workflow ?? ''}
		onchange={(e) => setParam('workflow', e.currentTarget.value)}
		class="h-9 w-auto text-sm"
		aria-label="Filter by workflow"
	>
		<option value="">All workflows</option>
		{#each data.workflows as workflow (workflow.id)}
			<option value={workflow.id}>{workflow.name}</option>
		{/each}
	</Select>
	<Select
		value={data.filters.label ?? ''}
		onchange={(e) => setParam('label', e.currentTarget.value)}
		class="h-9 w-auto text-sm"
		aria-label="Filter by label"
	>
		<option value="">All labels</option>
		{#each data.labels as label (label.id)}
			<option value={label.id}>{label.name}</option>
		{/each}
	</Select>
</div>

{#if !data.hasAgentGuidelines}
	<div
		class="border-primary/30 bg-primary/5 mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3"
	>
		<div class="text-sm">
			<p class="font-medium">Add the starter agent guidance</p>
			<p class="text-muted-foreground text-xs">
				A global prompt that opens every launch prompt: teaches agents when to comment, attach
				artifacts, journal, or file a context change request. Yours to edit after seeding.
			</p>
			{#if seedError}
				<p class="text-destructive mt-1 text-xs">{seedError}</p>
			{/if}
		</div>
		<Button size="sm" variant="outline" onclick={seedGuidelines} disabled={seeding}>
			<IconSparkles size={14} />
			{seeding ? 'Adding…' : 'Add guidance'}
		</Button>
	</div>
{/if}

<ContextItemList
	items={data.items}
	onselect={openEdit}
	emptyMessage={data.filters.kind ||
	data.filters.project ||
	data.filters.workflow ||
	data.filters.label ||
	data.filters.q
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
