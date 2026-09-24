<script lang="ts">
	import type { PageData } from './$types';
	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import { page } from '$app/state';
	import IssueFilterBar from '$lib/components/IssueFilterBar.svelte';
	import IssueList from '$lib/components/IssueList.svelte';
	import IssuePagination from '$lib/components/IssuePagination.svelte';
	import NewIssueModal from '$lib/components/NewIssueModal.svelte';
	import ProjectFocusNotice from '$lib/components/ProjectFocusNotice.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { defaultProjectId } from '$lib/focus';
	import { navMemory } from '$lib/nav-memory.svelte';

	let { data }: { data: PageData } = $props();

	// Focused on a project shared with you, New issue files into it.
	const createProjects = $derived(
		data.viewerRole === 'member'
			? data.sharedProjects.filter((project) => project.id === data.focusId)
			: data.projects
	);

	// Remember the filters so the Issues nav tab and issue back links return
	// here as it stands. The URL is already the source of truth, so this picks
	// up every filter change, search submit, and direct navigation.
	$effect(() => {
		navMemory.recordIssues(page.url.search);
	});

	let newIssueOpen = $state(false);
	/** No project of their own and none shared with them: nothing to file into yet. */
	const noProjects = $derived(data.projects.length === 0 && data.sharedProjects.length === 0);

	/** What the list is scoped to right now, for the stale-link notices. */
	const scopeLabel = $derived(data.focus ? `“${data.focus.name}”` : 'All projects');
</script>

<svelte:head><title>Issues · Tines</title></svelte:head>

<div class="mb-6 flex items-center justify-between gap-3">
	<h1 class="text-2xl font-semibold tracking-tight">Issues</h1>
	<Button onclick={() => (newIssueOpen = true)} disabled={createProjects.length === 0}>
		<IconPlus size={16} /> New issue
	</Button>
</div>

<!-- A `?project=` that could not be honoured. It changed nothing: the list
     below is still the focus's, and the chrome still says so. -->
<ProjectFocusNotice notice={data.notice} {scopeLabel} />

<IssueFilterBar
	filters={data.filters}
	counts={data.counts}
	labels={data.labels}
	workflows={data.workflows}
/>

<NewIssueModal
	bind:open={newIssueOpen}
	projects={createProjects}
	workflows={data.workflows}
	labels={data.labels}
	defaultProjectId={defaultProjectId(createProjects, data.focusId, data.lastProjectId)}
/>

<!-- Focused on one project, every ref would repeat its name: rows show the
     bare number then, as the project page does. -->
<IssuePagination
	pagination={data.pagination}
	itemCount={data.issues.length}
	label="Issue pagination above results"
	class="mb-4"
/>
<IssueList
	issues={data.issues}
	showProject={!data.focusId}
	emptyMessage={data.pagination.bounded
		? 'No issues on this page. Results may have changed.'
		: noProjects
			? 'No issues yet — create a project first, then add issues to it.'
			: data.filters.ready
				? 'No ready issues match these filters.'
				: 'No issues match these filters.'}
	emptyAction={!data.pagination.bounded && noProjects
		? { label: 'New project', href: '/projects?new=1' }
		: undefined}
/>
<IssuePagination
	pagination={data.pagination}
	itemCount={data.issues.length}
	label="Issue pagination below results"
	announceCount={false}
/>
