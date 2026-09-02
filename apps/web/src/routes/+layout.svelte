<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { theme } from '$lib/theme.svelte';
	import { onMount } from 'svelte';
	import DialogHost from '$lib/components/DialogHost.svelte';
	import { backgroundInert } from '$lib/components/background-inert.svelte';

	let { children } = $props();

	// Root layout, not (app), so the landing page follows the theme too.
	onMount(() => theme.init());
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<!-- A box-less wrapper (`display: contents`) so marking the page behind `inert`
     costs no layout. It is a sibling of <DialogHost /> and of the <body> portal
     dialogs render into, so dialog content itself is never inert. -->
<div style="display: contents" inert={backgroundInert.active || undefined}>
	{@render children()}
</div>
<DialogHost />
