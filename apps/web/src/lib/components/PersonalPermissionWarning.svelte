<script lang="ts">
	import { page } from '$app/state';
	let { future = false }: { future?: boolean } = $props();
</script>

{#if page.data.disclosureAcknowledged}
	<p class="text-muted-foreground mt-2 text-xs">
		{future ? 'Future instances' : 'This evolving issue'} may use your agents and account resources when
		eligible. You can turn permission off later.
	</p>
{:else}
	<div
		class="mt-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm"
		role="note"
		aria-label="First permission warning"
	>
		<p class="font-medium">Before you allow your agents</p>
		<p class="mt-1">
			{future ? 'Future issues from this schedule' : 'This issue'} can change as people add work, comments
			and artifacts. Permission covers that evolving work and uses your own runner and account resources.
			Your agents may run later when setup is ready, including after member execution is released. Member
			agents cannot run in this release. Turning permission off stops new admission but cannot reverse
			external actions or recall downloaded content. Each person controls their own permission.
		</p>
	</div>
{/if}
