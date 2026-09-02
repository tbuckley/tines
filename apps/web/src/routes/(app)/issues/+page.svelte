<script lang="ts">
	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import IconSearch from '@tabler/icons-svelte/icons/search';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import IssueList from '$lib/components/IssueList.svelte';
	import NewIssueModal from '$lib/components/NewIssueModal.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Select } from '$lib/components/ui/select/index.js';
	import { CATEGORY_LABELS } from '$lib/format';
	import { STATE_CATEGORIES } from '@tines/shared';

	let { data } = $props();

	let newIssueOpen = $state(false);

	// Submit-to-search, like the context page: the URL is the source of truth.
	// svelte-ignore state_referenced_locally
	let search = $state(data.filters.q ?? '');

	// Distinct state names across the library, for the state filter.
	const stateNames = $derived([
		...new Set(data.workflows.flatMap((w) => w.states.map((s) => s.name)))
	]);

	// The project filter holds a name; the modal preselects by id.
	const filteredProjectId = $derived(
		data.projects.find((p) => p.name === data.filters.project)?.id ?? null
	);

	function setFilter(key: string, value: string) {
		const params = new URLSearchParams(page.url.searchParams);
		if (value) params.set(key, value);
		else params.delete(key);
		goto(`/issues?${params}`, { keepFocus: true, noScroll: true });
	}
</script>

<svelte:head><title>Issues · Tines</title></svelte:head>

<div class="mb-6 flex items-center justify-between gap-3">
	<h1 class="text-2xl font-semibold tracking-tight">Issues</h1>
	<Button onclick={() => (newIssueOpen = true)} disabled={data.projects.length === 0}>
		<IconPlus size={16} /> New issue
	</Button>
</div>

<div class="mb-6 flex flex-wrap items-center gap-3">
	<div class="relative">
		<IconSearch
			size={14}
			class="text-muted-foreground absolute top-1/2 left-2.5 -translate-y-1/2"
		/>
		<form
			onsubmit={(e) => {
				e.preventDefault();
				setFilter('q', search.trim());
			}}
		>
			<Input
				bind:value={search}
				placeholder="Search issues…"
				class="h-9 w-56 pl-8"
				aria-label="Search issues"
			/>
		</form>
	</div>
	<Select
		class="w-40 max-sm:min-w-36 max-sm:flex-1"
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
		class="w-40 max-sm:min-w-36 max-sm:flex-1"
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
		class="w-44 max-sm:min-w-36 max-sm:flex-1"
		value={data.filters.category ?? ''}
		onchange={(e) => setFilter('category', e.currentTarget.value)}
		aria-label="Filter by category"
	>
		<option value="">All categories</option>
		{#each STATE_CATEGORIES as cat (cat)}
			<option value={cat}>{CATEGORY_LABELS[cat]}</option>
		{/each}
	</Select>
	<!-- Ready implies not-done, so "Show done" parks (unchecked and disabled)
	     while Ready is on; its URL param survives, so unchecking restores it. -->
	<label
		class="text-muted-foreground flex items-center gap-2 text-sm {data.filters.ready
			? 'opacity-50'
			: ''}"
		title={data.filters.ready ? 'Ready issues are never done' : undefined}
	>
		<input
			type="checkbox"
			checked={data.filters.showDone && !data.filters.ready}
			disabled={data.filters.ready}
			onchange={(e) => setFilter('done', e.currentTarget.checked ? '1' : '')}
		/>
		Show done
	</label>
	<label class="text-muted-foreground flex items-center gap-2 text-sm">
		<input
			type="checkbox"
			checked={data.filters.ready}
			onchange={(e) => setFilter('ready', e.currentTarget.checked ? '1' : '')}
		/>
		Ready only
	</label>
</div>

<NewIssueModal
	bind:open={newIssueOpen}
	projects={data.projects}
	workflows={data.workflows}
	defaultProjectId={filteredProjectId}
/>

<IssueList
	issues={data.issues}
	emptyMessage={data.projects.length === 0
		? 'No issues yet — create a project first, then add issues to it.'
		: data.filters.ready
			? 'No ready issues match these filters.'
			: 'No issues match these filters.'}
/>
