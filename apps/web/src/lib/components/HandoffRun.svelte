<script lang="ts">
	import { runCostLabel, runDurationLabel, type Comment, type RoundRun } from '@tines/shared';
	import IconExternalLink from '@tabler/icons-svelte/icons/external-link';
	import Markdown from '$lib/components/Markdown.svelte';

	let {
		run,
		comments,
		onartifact
	}: {
		run: RoundRun;
		comments: Map<string, Comment>;
		onartifact: (name: string, version: number, path?: string) => void;
	} = $props();
	const cost = $derived(
		run.usage && Number.isFinite(run.usage.cost_usd) ? runCostLabel(run) : null
	);
	const earlier = $derived(
		run.earlier_comment_ids.map((id) => comments.get(id)).filter((c): c is Comment => Boolean(c))
	);
</script>

<div class="space-y-3">
	<p class="text-muted-foreground text-xs">
		{run.runner_name} · {runDurationLabel(run)}{#if cost}
			· {cost}{/if} ·
		{run.transition?.action ?? run.outcome ?? run.status}
	</p>
	{#if run.summary_comment}
		<div class="text-sm"><Markdown source={run.summary_comment.body} /></div>
	{:else}
		<p class="text-muted-foreground text-sm italic">No summary comment from this run.</p>
	{/if}
	{#if run.artifacts.length}
		<div class="flex flex-wrap gap-2">
			{#each run.artifacts as artifact (`${artifact.name}-${artifact.to_version}`)}
				<button
					type="button"
					class="bg-muted hover:bg-accent rounded-full border px-2 py-0.5 font-mono text-xs"
					onclick={() => onartifact(artifact.name, artifact.to_version)}
				>
					{artifact.name}
					{artifact.from_version === null
						? `v${artifact.to_version}`
						: `v${artifact.from_version} → v${artifact.to_version}`}
				</button>
				{#if artifact.pr_url}
					<a
						href={artifact.pr_url}
						target="_blank"
						rel="noreferrer"
						class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs underline"
					>
						PR #{artifact.pr_url.split('/').at(-1)}
						<IconExternalLink size={12} />
					</a>
				{/if}
			{/each}
		</div>
	{/if}
	{#if earlier.length}
		<details>
			<summary class="text-muted-foreground cursor-pointer text-xs">
				{earlier.length} earlier update{earlier.length === 1 ? '' : 's'}
			</summary>
			<div class="mt-3 space-y-3 border-l pl-3">
				{#each earlier as comment (comment.id)}
					<div class="text-sm"><Markdown source={comment.body} /></div>
				{/each}
			</div>
		</details>
	{/if}
</div>
