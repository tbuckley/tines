<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import ErrorPage from '$lib/components/ErrorPage.svelte';
	import { Button } from '$lib/components/ui/button/index.js';

	// Signed-in boundary: rendered inside (app)/+layout.svelte, so the header and
	// the phone tab bar stay put and the failure reads as one page misbehaving
	// rather than the app falling over.
	let canGoBack = $state(false);
	onMount(() => {
		canGoBack = history.length > 1;
	});
</script>

<svelte:head><title>{page.status} · Tines</title></svelte:head>

<ErrorPage
	status={page.status}
	message={page.error?.message}
	path={page.status === 404 ? page.url.pathname : null}
>
	{#snippet actions()}
		<Button href="/issues">Back to issues</Button>
		{#if canGoBack}
			<Button variant="outline" onclick={() => history.back()}>Go back</Button>
		{/if}
	{/snippet}
</ErrorPage>
