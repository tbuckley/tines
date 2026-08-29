<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { theme } from '$lib/theme.svelte';
	import { onMount } from 'svelte';
	import DialogHost from '$lib/components/DialogHost.svelte';

	let { children } = $props();

	// Root layout, not (app), so the landing page follows the theme too.
	onMount(() => theme.init());
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
<DialogHost />
