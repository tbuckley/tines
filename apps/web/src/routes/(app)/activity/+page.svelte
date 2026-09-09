<script lang="ts">
	import type { TinesEvent } from '@tines/shared';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import EventList from '$lib/components/EventList.svelte';
	import ProjectFocusNotice from '$lib/components/ProjectFocusNotice.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Select } from '$lib/components/ui/select/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';

	let { data } = $props();

	// The project halves live on the app layout; a ?project= that names an
	// archived one still has to show its name rather than "All projects".
	const scopeLabel = $derived(data.focus ? `“${data.focus.name}”` : 'All projects');

	const EVENT_TYPES = [
		'issue.created',
		'issue.updated',
		'issue.transitioned',
		'issue.commented',
		'issue.comment_edited',
		'issue.comment_deleted',
		'project.created',
		'project.updated',
		'project.deleted',
		'workflow.created',
		'workflow.updated',
		'workflow.deleted',
		'api_key.created',
		'api_key.revoked'
	];

	// Server-loaded page plus any client-fetched continuation pages.
	let extra = $state<TinesEvent[]>([]);
	let nextCursor = $state<string | null>(null);
	let loadingMore = $state(false);
	let loadError = $state<string | null>(null);
	let generation = 0;
	$effect(() => {
		// New server data (filter change) resets the continuation.
		void data.events;
		extra = [];
		nextCursor = data.nextCursor;
		generation += 1;
		loadingMore = false;
		loadError = null;
	});

	const events = $derived([...data.events, ...extra]);

	async function loadMore() {
		if (!nextCursor || loadingMore) return;
		const requestGeneration = generation;
		loadingMore = true;
		loadError = null;
		try {
			const res = await api.listEvents({
				project: data.focusId || undefined,
				type: data.filters.type || undefined,
				cursor: nextCursor,
				limit: 50
			});
			if (generation === requestGeneration) {
				extra = [...extra, ...res.items];
				nextCursor = res.next_cursor;
			}
		} catch {
			if (generation === requestGeneration) loadError = 'Failed to load more activity. Try again.';
		} finally {
			if (generation === requestGeneration) loadingMore = false;
		}
	}

	function setFilter(key: string, value: string) {
		const params = new URLSearchParams(page.url.searchParams);
		if (value) params.set(key, value);
		else params.delete(key);
		goto(`/activity?${params}`, { keepFocus: true, noScroll: true });
	}
</script>

<svelte:head><title>Activity · Tines</title></svelte:head>

<div class="mb-6 flex flex-wrap items-center gap-3">
	<h1 class="mr-auto text-2xl font-semibold tracking-tight">Activity</h1>
	<Select
		class="w-48 max-sm:min-w-36 max-sm:flex-1"
		value={data.filters.type}
		onchange={(e) => setFilter('type', e.currentTarget.value)}
		aria-label="Filter by event type"
	>
		<option value="">All event types</option>
		{#each EVENT_TYPES as t (t)}
			<option value={t}>{t}</option>
		{/each}
	</Select>
</div>

<ProjectFocusNotice notice={data.notice} {scopeLabel} />

<EventList
	{events}
	showProject={!data.focusId}
	emptyMessage="No activity yet — it will show up here as you and your agents work."
/>

{#if loadingMore}
	<div class="mt-4 space-y-2">
		<Skeleton class="h-10 w-full" />
		<Skeleton class="h-10 w-full" />
		<Skeleton class="h-10 w-full" />
	</div>
{/if}

{#if loadError}<p class="text-destructive mt-4 text-center text-sm" role="alert">
		{loadError}
	</p>{/if}

{#if nextCursor}
	<div class="mt-6 flex justify-center">
		<Button variant="outline" onclick={loadMore} disabled={loadingMore}>Load more</Button>
	</div>
{/if}
