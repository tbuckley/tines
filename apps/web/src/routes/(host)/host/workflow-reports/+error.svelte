<script lang="ts">
	import { page } from '$app/state';
</script>

<svelte:head><title>Report queue unavailable · Tines</title></svelte:head>

<section class="rounded-lg border p-6" role="alert">
	<h1 class="text-2xl font-semibold">Report queue unavailable</h1>
	<p class="text-muted-foreground mt-2 text-sm">
		{page.error?.message ?? 'The host report queue could not be loaded.'}
	</p>
	<button
		class="mt-4 min-h-10 rounded-md border px-4"
		onclick={() => (location.href = '/host/workflow-reports')}
	>
		Retry queue
	</button>
</section>
