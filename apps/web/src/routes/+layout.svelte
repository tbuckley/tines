<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import DialogHost from '$lib/components/DialogHost.svelte';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
<DialogHost />
