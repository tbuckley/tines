<script lang="ts">
	import { page } from '$app/state';
</script>

<svelte:head
	><title>Publication unavailable — Tines</title><meta name="robots" content="noindex" /><meta
		name="referrer"
		content="no-referrer"
	/></svelte:head
>
<main class="mx-auto flex min-h-screen max-w-xl items-center px-6 py-16">
	<div>
		<h1 class="text-2xl font-semibold">Publication unavailable</h1>
		<p class="text-muted-foreground mt-3">
			{page.error?.message ?? 'This publication is not available.'}
		</p>
	</div>
</main>
