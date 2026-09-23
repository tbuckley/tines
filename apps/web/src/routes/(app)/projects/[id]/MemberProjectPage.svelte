<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';
	import MemberSchedulePermission from './MemberSchedulePermission.svelte';
	let { data } = $props();
	onMount(() => {
		void api.updatePreferences({ focused_project_id: data.project.id }).catch(() => {});
	});
</script>

<svelte:head><title>{data.project.name} · Tines</title></svelte:head>
<main class="mx-auto max-w-4xl px-4 py-6">
	<a class="text-sm underline" href="/projects">← Projects</a>
	<h1 class="mt-5 text-2xl font-semibold">{data.project.name}</h1>
	<p class="text-muted-foreground mt-2">Shared by {data.project.owner.name}</p>
	{#if data.project.description}<p class="mt-3">{data.project.description}</p>{/if}
	<a class="mt-5 inline-block rounded border px-4 py-3" href={`/projects/${data.project.id}/people`}
		>People</a
	>
	<section class="mt-8" aria-labelledby="issues-heading">
		<h2 id="issues-heading" class="text-lg font-semibold">Issues</h2>
		{#if data.issues.length === 0}<p class="mt-3">No issues in this project yet.</p>{:else}
			<ul class="mt-3 space-y-2">
				{#each data.issues as issue (issue.id)}
					<li>
						<a
							class="hover:bg-muted block rounded-lg border p-4"
							href={`/issues/${encodeURIComponent(data.project.id)}/${issue.number}`}
							><span class="text-muted-foreground text-sm"
								>#{issue.number} · {issue.state.name}</span
							><span class="mt-1 block font-medium">{issue.title}</span></a
						>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
	<section class="mt-8" aria-labelledby="schedules-heading">
		<h2 id="schedules-heading" class="text-lg font-semibold">Schedules</h2>
		{#if data.schedules.length === 0}<p class="mt-3">No schedules in this project.</p>{:else}
			<ul class="mt-3 space-y-2">
				{#each data.schedules as schedule (schedule.id)}<li class="rounded-lg border p-4">
						<strong>{schedule.name}</strong>
						<p class="text-muted-foreground text-sm">
							{schedule.recurrence.cron} · {schedule.recurrence.timezone}
						</p>
						<MemberSchedulePermission {schedule} />
					</li>{/each}
			</ul>
		{/if}
	</section>
</main>
