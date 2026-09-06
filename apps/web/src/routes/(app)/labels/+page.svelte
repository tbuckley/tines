<script lang="ts">
	import LabelChip from '$lib/components/LabelChip.svelte';

	let { data } = $props();

	/**
	 * Read-only: labels are created and edited from the CLI (`tines labels …`)
	 * and applied from an issue's own card. This page answers the question
	 * neither of those can — what does a label *reach*: how many issues carry
	 * it, and how much context and routing is scoped to it.
	 */
	function plural(n: number, one: string, many = `${one}s`) {
		return `${n} ${n === 1 ? one : many}`;
	}
</script>

<svelte:head><title>Labels · Tines</title></svelte:head>

<div class="mb-6">
	<h1 class="text-2xl font-semibold tracking-tight">Labels</h1>
	<p class="text-muted-foreground mt-1 text-sm">
		A label classifies the kind of work. Context items and routing rules can be scoped to one, so
		labelling an issue changes what its agent is given and where it runs.
	</p>
</div>

{#if data.labels.length === 0}
	<div class="text-muted-foreground rounded-lg border border-dashed p-12 text-center text-sm">
		No labels yet — <code class="text-foreground">tines labels create &lt;name&gt;</code>
	</div>
{:else}
	<div class="divide-y rounded-lg border">
		{#each data.labels as label (label.id)}
			<div class="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
				<div class="min-w-48 flex-1">
					<LabelChip {label} />
					{#if label.description}
						<p class="text-muted-foreground mt-1 text-xs">{label.description}</p>
					{/if}
				</div>
				<div class="text-muted-foreground flex flex-wrap items-center gap-3 text-xs">
					<!-- Each count links to the view that lists what it counts, so a
					     label's reach is one click from the number, not a search. -->
					<a class="hover:text-foreground" href="/issues?label={label.id}">
						{plural(label.issue_count, 'issue')}
					</a>
					<a class="hover:text-foreground" href="/context?label={label.id}">
						{plural(label.context_item_count, 'context item')}
					</a>
					<a class="hover:text-foreground" href="/agents">
						{plural(label.routing_rule_count, 'routing rule')}
					</a>
				</div>
			</div>
		{/each}
	</div>
{/if}
