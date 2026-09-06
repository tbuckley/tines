<script lang="ts">
	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import { page } from '$app/state';
	import IssueFilterBar from '$lib/components/IssueFilterBar.svelte';
	import IssueList from '$lib/components/IssueList.svelte';
	import NewIssueModal from '$lib/components/NewIssueModal.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { defaultProjectId } from '$lib/focus';
	import { truncate } from '$lib/format';
	import { navMemory } from '$lib/nav-memory.svelte';

	let { data } = $props();

	// Remember the filters so the Issues nav tab and issue back links return
	// here as it stands. The URL is already the source of truth, so this picks
	// up every filter change, search submit, and direct navigation.
	$effect(() => {
		navMemory.recordIssues(page.url.search);
	});

	let newIssueOpen = $state(false);

	/** What the list is scoped to right now, for the stale-link notices. */
	const scopeLabel = $derived(data.focus ? `“${data.focus.name}”` : 'All projects');
</script>

<svelte:head><title>Issues · Tines</title></svelte:head>

<div class="mb-6 flex items-center justify-between gap-3">
	<h1 class="text-2xl font-semibold tracking-tight">Issues</h1>
	<Button onclick={() => (newIssueOpen = true)} disabled={data.projects.length === 0}>
		<IconPlus size={16} /> New issue
	</Button>
</div>

<!-- A `?project=` that could not be honoured. It changed nothing: the list
     below is still the focus's, and the chrome still says so. -->
{#if data.notice}
	<p
		class="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-800 dark:text-amber-300"
		role="status"
	>
		{#if data.notice.kind === 'unknown'}
			No project “{truncate(data.notice.ref, 40)}”. Showing {scopeLabel}.
		{:else}
			Project “{truncate(data.notice.project.name, 40)}” is archived. Showing {scopeLabel}.
			<a class="underline underline-offset-2" href="/projects/{data.notice.project.id}"
				>View project</a
			>
		{/if}
	</p>
{/if}

<IssueFilterBar
	filters={data.filters}
	counts={data.counts}
	labels={data.labels}
	workflows={data.workflows}
/>

<NewIssueModal
	bind:open={newIssueOpen}
	projects={data.projects}
	workflows={data.workflows}
	labels={data.labels}
	defaultProjectId={defaultProjectId(data.projects, data.focusId, data.lastProjectId)}
/>

<!-- Focused on one project, every ref would repeat its name: rows show the
     bare number then, as the project page does. -->
<IssueList
	issues={data.issues}
	showProject={!data.focusId}
	emptyMessage={data.projects.length === 0
		? 'No issues yet — create a project first, then add issues to it.'
		: data.filters.ready
			? 'No ready issues match these filters.'
			: 'No issues match these filters.'}
/>
