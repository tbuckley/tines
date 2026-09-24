<script lang="ts">
	import OwnerIssuesPage from './OwnerIssuesPage.svelte';
	import MemberIssuesPage from './MemberIssuesPage.svelte';
	let { data } = $props();
</script>

{#if data.mode === 'member'}
	<MemberIssuesPage {data} />
{:else}
	<OwnerIssuesPage {data} />
{/if}
