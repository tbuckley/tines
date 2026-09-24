<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';
	import IconChevronLeft from '@tabler/icons-svelte/icons/chevron-left';
	import { Button } from '$lib/components/ui/button/index.js';
	import Markdown from '$lib/components/Markdown.svelte';
	import StateBadge from '$lib/components/StateBadge.svelte';
	import MemberSchedulePermission from './MemberSchedulePermission.svelte';
	let { data } = $props();
	onMount(() => {
		void api.updatePreferences({ focused_project_id: data.project.id }).catch(() => {});
	});
</script>

<svelte:head><title>{data.project.name} · Tines</title></svelte:head>
<div class="mb-6">
	<a
		href="/projects"
		class="text-muted-foreground hover:text-foreground mb-3 inline-flex items-center gap-1 text-sm"
		><IconChevronLeft size={16} /> Projects</a
	>
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div class="min-w-0">
			<h1 class="text-2xl font-semibold tracking-tight wrap-anywhere">{data.project.name}</h1>
			<p class="text-muted-foreground mt-1 text-sm">Shared by {data.project.owner.name}</p>
		</div>
		<Button href={`/projects/${data.project.id}/people`} variant="outline">People</Button>
	</div>
	{#if data.project.description}<div class="mt-4">
			<Markdown source={data.project.description} />
		</div>{/if}
</div>
<div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
	<section class="min-w-0" aria-labelledby="issues-heading">
		<h2 id="issues-heading" class="mb-3 text-sm font-semibold">Issues</h2>
		{#if data.issues.length === 0}<p
				class="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm"
			>
				No issues in this project yet.
			</p>{:else}
			<ul class="divide-y rounded-lg border">
				{#each data.issues as issue (issue.id)}<li>
						<a
							class="hover:bg-muted/50 flex min-w-0 flex-wrap items-center gap-3 p-4"
							href={`/issues/${encodeURIComponent(data.project.id)}/${issue.number}`}
							><span class="text-muted-foreground text-sm">#{issue.number}</span><span
								class="min-w-0 flex-1 font-medium wrap-anywhere">{issue.title}</span
							><StateBadge state={issue.state} /></a
						>
					</li>{/each}
			</ul>
		{/if}
	</section>
	<section class="min-w-0" aria-labelledby="schedules-heading">
		<h2 id="schedules-heading" class="mb-3 text-sm font-semibold">Schedules</h2>
		{#if data.schedules.length === 0}<p
				class="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm"
			>
				No schedules in this project.
			</p>{:else}
			<ul class="space-y-3">
				{#each data.schedules as schedule (schedule.id)}<li class="rounded-lg border p-4">
						<h3 class="font-medium">{schedule.name}</h3>
						<p class="text-muted-foreground mt-1 text-xs">
							{schedule.recurrence.cron} · {schedule.recurrence.timezone}
						</p>
						<MemberSchedulePermission {schedule} />
					</li>{/each}
			</ul>
		{/if}
	</section>
</div>
