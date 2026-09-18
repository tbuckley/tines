<script lang="ts">
	import EventList from '$lib/components/EventList.svelte';
	let { data } = $props();
</script>

<svelte:head><title>Recorded events · Tines</title></svelte:head>

<h1 class="mb-3 text-2xl font-semibold tracking-tight">Recorded events</h1>
<p class="text-muted-foreground mb-6 text-sm">
	Events selected by this change marker, across projects. Your saved project focus is unchanged.
</p>
<EventList events={data.events} emptyMessage="No selected events are available." />
{#if data.nextHref}
	<a class="mt-6 inline-flex min-h-11 items-center underline" href={data.nextHref}>Next events</a>
{/if}
<a class="mt-6 block text-sm underline" href="/activity">Back to Activity</a>
