<script lang="ts">
	import OwnerIssuePage from './OwnerIssuePage.svelte';
	import MemberIssuePage from './MemberIssuePage.svelte';
	let { data } = $props();
</script>

{#if data.mode === 'member'}
	<MemberIssuePage {data} />
{:else}
	<OwnerIssuePage {data} />
{/if}
