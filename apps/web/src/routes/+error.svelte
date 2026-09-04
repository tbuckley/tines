<script lang="ts">
	import { page } from '$app/state';
	import ErrorPage from '$lib/components/ErrorPage.svelte';
	import { Button } from '$lib/components/ui/button/index.js';

	// The root boundary catches what the (app) one cannot: URLs that match no
	// route at all for signed-out visitors, and failures in the root load. There
	// is no app chrome at this level, so the page carries its own way out.
	const signedIn = $derived(Boolean(page.data.user));
</script>

<svelte:head><title>{page.status} · Tines</title></svelte:head>

<main class="flex min-h-screen flex-col items-center justify-center px-4">
	<ErrorPage
		status={page.status}
		message={page.error?.message}
		path={page.status === 404 ? page.url.pathname : null}
	>
		{#snippet actions()}
			{#if signedIn}
				<Button href="/issues">Back to issues</Button>
			{:else}
				<Button href="/">Go to sign in</Button>
			{/if}
		{/snippet}
	</ErrorPage>
</main>
