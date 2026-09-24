<script lang="ts">
	import OwnerProjectPage from './OwnerProjectPage.svelte';
	import MemberProjectPage from './MemberProjectPage.svelte';
	let { data } = $props();
</script>

{#if data.mode === 'member'}
	<MemberProjectPage {data} />
{:else}
	<OwnerProjectPage {data} />
{/if}
