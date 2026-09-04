<script lang="ts">
	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import { page } from '$app/state';
	import IssueFilterBar from '$lib/components/IssueFilterBar.svelte';
	import IssueList from '$lib/components/IssueList.svelte';
	import NewIssueModal from '$lib/components/NewIssueModal.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { navMemory } from '$lib/nav-memory.svelte';

	let { data } = $props();

	// Remember the filters so the Issues nav tab and issue back links return
	// here as it stands. The URL is already the source of truth, so this picks
	// up every filter change, search submit, and direct navigation.
	$effect(() => {
		navMemory.recordIssues(page.url.search);
	});

	let newIssueOpen = $state(false);

	// The project filter holds a name; the modal preselects by id.
	const filteredProjectId = $derived(
		data.projects.find((p) => p.name === data.filters.project)?.id ?? null
	);
</script>

<svelte:head><title>Issues · Tines</title></svelte:head>

<div class="mb-6 flex items-center justify-between gap-3">
	<h1 class="text-2xl font-semibold tracking-tight">Issues</h1>
	<Button onclick={() => (newIssueOpen = true)} disabled={data.projects.length === 0}>
		<IconPlus size={16} /> New issue
	</Button>
</div>

<IssueFilterBar
	filters={data.filters}
	counts={data.counts}
	labels={data.labels}
	workflows={data.workflows}
	projects={data.projects}
/>

<NewIssueModal
	bind:open={newIssueOpen}
	projects={data.projects}
	workflows={data.workflows}
	labels={data.labels}
	defaultProjectId={filteredProjectId}
/>

<!-- Filtered to one project, every ref would repeat its name: rows show the
     bare number then, as the project page does. -->
<IssueList
	issues={data.issues}
	showProject={!data.filters.project}
	emptyMessage={data.projects.length === 0
		? 'No issues yet — create a project first, then add issues to it.'
		: data.filters.ready
			? 'No ready issues match these filters.'
			: 'No issues match these filters.'}
/>
