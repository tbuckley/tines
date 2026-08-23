<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import IssueList from '$lib/components/IssueList.svelte';
	import { Select } from '$lib/components/ui/select/index.js';
	import { CATEGORY_LABELS } from '$lib/format';
	import { STATE_CATEGORIES } from '@tines/shared';

	let { data } = $props();

	// Distinct state names across the library, for the state filter.
	const stateNames = $derived([
		...new Set(data.workflows.flatMap((w) => w.states.map((s) => s.name)))
	]);

	function setFilter(key: string, value: string) {
		const params = new URLSearchParams(page.url.searchParams);
		if (value) params.set(key, value);
		else params.delete(key);
		goto(`/issues?${params}`, { keepFocus: true, noScroll: true });
	}
</script>

<svelte:head><title>Issues · Tines</title></svelte:head>

<div class="mb-6 flex flex-wrap items-center gap-3">
	<h1 class="mr-auto text-2xl font-semibold tracking-tight">Issues</h1>
	<Select
		class="w-40"
		value={data.filters.project ?? ''}
		onchange={(e) => setFilter('project', e.currentTarget.value)}
		aria-label="Filter by project"
	>
		<option value="">All projects</option>
		{#each data.projects as project (project.id)}
			<option value={project.name}>{project.name}</option>
		{/each}
	</Select>
	<Select
		class="w-40"
		value={data.filters.state ?? ''}
		onchange={(e) => setFilter('state', e.currentTarget.value)}
		aria-label="Filter by state"
	>
		<option value="">All states</option>
		{#each stateNames as name (name)}
			<option value={name}>{name}</option>
		{/each}
	</Select>
	<Select
		class="w-44"
		value={data.filters.category ?? ''}
		onchange={(e) => setFilter('category', e.currentTarget.value)}
		aria-label="Filter by category"
	>
		<option value="">All categories</option>
		{#each STATE_CATEGORIES as cat (cat)}
			<option value={cat}>{CATEGORY_LABELS[cat]}</option>
		{/each}
	</Select>
	<label class="text-muted-foreground flex items-center gap-2 text-sm">
		<input
			type="checkbox"
			checked={data.filters.showDone}
			onchange={(e) => setFilter('done', e.currentTarget.checked ? '1' : '')}
		/>
		Show done
	</label>
</div>

<IssueList
	issues={data.issues}
	emptyMessage={data.projects.length === 0
		? 'No issues yet — create a project first, then add issues to it.'
		: 'No issues match these filters.'}
/>
