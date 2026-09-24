<script lang="ts">
	import OwnerIssuesPage from './OwnerIssuesPage.svelte';
	let { data } = $props();
</script>

<OwnerIssuesPage {data} />
