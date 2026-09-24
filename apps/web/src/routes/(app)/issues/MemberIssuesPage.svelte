<script lang="ts">
	import IconChevronLeft from '@tabler/icons-svelte/icons/chevron-left';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Select } from '$lib/components/ui/select/index.js';
	import IssuePagination from '$lib/components/IssuePagination.svelte';
	import StateBadge from '$lib/components/StateBadge.svelte';
	let { data } = $props();
</script>

<svelte:head><title>Issues · {data.project.name} · Tines</title></svelte:head>
<div class="mb-6">
	<a
		href={`/projects/${data.project.id}`}
		class="text-muted-foreground hover:text-foreground mb-3 inline-flex min-w-0 items-center gap-1 text-sm"
		><IconChevronLeft size={16} class="shrink-0" /><span class="truncate">{data.project.name}</span
		></a
	>
	<h1 class="text-2xl font-semibold tracking-tight">Issues</h1>
</div>
<form class="mb-6 flex flex-wrap items-end gap-3" method="GET" action="/issues">
	<label class="min-w-40 flex-1 text-sm"
		>Search<Input
			class="mt-1"
			name="q"
			value={data.filters.q}
			placeholder="Search issues…"
		/></label
	>
	<label class="min-w-40 text-sm"
		>Category<Select class="mt-1" name="category" value={data.filters.category}>
			<option value=""
				>All ({data.counts.backlog +
					data.counts.active +
					data.counts.awaiting_human +
					data.counts.done})</option
			>
			<option value="backlog">Backlog ({data.counts.backlog})</option><option value="active"
				>Active ({data.counts.active})</option
			><option value="awaiting_human">Awaiting ({data.counts.awaiting_human})</option><option
				value="done">Done ({data.counts.done})</option
			>
		</Select></label
	>
	<Button type="submit">Filter</Button>
</form>
{#if data.issues.length === 0}
	<div class="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">
		No issues match this view.
		{#if data.filters.category === 'awaiting_human'}<div class="mt-3">
				<Button href="/issues" variant="outline" size="sm">View all project issues</Button>
			</div>{/if}
	</div>
{:else}
	<ul class="divide-y rounded-lg border">
		{#each data.issues as issue (issue.id)}<li>
				<a
					class="hover:bg-muted/50 flex min-w-0 flex-wrap items-center gap-3 p-4"
					href={`/issues/${data.project.id}/${issue.number}`}
					><span class="text-muted-foreground text-sm">#{issue.number}</span><span
						class="min-w-0 flex-1 font-medium wrap-anywhere">{issue.title}</span
					><StateBadge state={issue.state} /></a
				>
			</li>{/each}
	</ul>
{/if}
<IssuePagination pagination={data.pagination} itemCount={data.issues.length} />
