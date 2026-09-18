<script lang="ts">
	import { page } from '$app/state';
	import MarketingPage from '$lib/components/marketing/MarketingPage.svelte';
	const linkError = $derived(
		page.url.searchParams.has('error')
			? 'That sign-in link is invalid or has expired. Enter your email to get a new one.'
			: null
	);
</script>

<svelte:head
	><title>Tines — A place for work to move</title><meta
		name="description"
		content="An issue tracker that gives agents a workflow and people the whole story."
	/><meta name="color-scheme" content="light" /></svelte:head
>
<MarketingPage {linkError} />
