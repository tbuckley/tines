<script lang="ts">
	import type { EffectiveContext } from '@tines/shared';
	import IconAlertTriangle from '@tabler/icons-svelte/icons/alert-triangle';
	import { slide } from 'svelte/transition';
	import ContextKindIcon from '$lib/components/ContextKindIcon.svelte';
	import Markdown from '$lib/components/Markdown.svelte';
	import { prefersReducedMotion } from '$lib/format';

	/** Renders the assembled bundle (`GET /issues/:id/context`). */
	let { context }: { context: EffectiveContext } = $props();

	const dur = () => (prefersReducedMotion() ? 0 : 180);

	const empty = $derived(
		context.prompt.parts.length === 0 && context.skills.length === 0 && context.repos.length === 0
	);
</script>

{#if empty}
	<p class="text-muted-foreground text-sm italic">No context applies to this issue right now.</p>
{:else}
	<div class="space-y-4">
		{#if context.prompt.parts.length > 0}
			<div class="space-y-2">
				{#each context.prompt.parts as part (part.item_id)}
					<div class="rounded-md border" transition:slide={{ duration: dur() }}>
						<div class="text-muted-foreground flex items-center gap-2 border-b px-3 py-1.5 text-xs">
							<ContextKindIcon kind="prompt" size={12} />
							<span class="font-medium">{part.name}</span>
							<span class="bg-muted rounded-full px-2 py-0.5">{part.scope.label}</span>
						</div>
						<div class="p-3 text-sm">
							<Markdown source={part.body} />
						</div>
					</div>
				{/each}
			</div>
		{/if}

		{#if context.skills.length > 0}
			<div>
				<h4 class="text-muted-foreground mb-1.5 text-xs font-semibold tracking-wide uppercase">Skills</h4>
				<ul class="space-y-1">
					{#each context.skills as skill (skill.item_id)}
						<li class="flex items-center gap-2 text-sm" transition:slide={{ duration: dur() }}>
							<span class="text-muted-foreground"><ContextKindIcon kind="skill" size={14} /></span>
							<span class="font-mono text-xs">skills/{skill.name}/</span>
							<span class="text-muted-foreground text-xs">
								{skill.file_count} file{skill.file_count === 1 ? '' : 's'}
							</span>
							<span class="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs">{skill.scope.label}</span>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if context.repos.length > 0}
			<div>
				<h4 class="text-muted-foreground mb-1.5 text-xs font-semibold tracking-wide uppercase">Repositories</h4>
				<ul class="space-y-1">
					{#each context.repos as repo (repo.item_id)}
						<li class="flex flex-wrap items-center gap-2 text-sm" transition:slide={{ duration: dur() }}>
							<span class="text-muted-foreground"><ContextKindIcon kind="repo" size={14} /></span>
							<span class="font-medium">{repo.name}</span>
							<span class="text-muted-foreground truncate font-mono text-xs">
								{repo.url}{repo.branch ? `#${repo.branch}` : ''} → {repo.dir}/
							</span>
							<span class="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs">{repo.scope.label}</span>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if context.overridden.length > 0}
			<div>
				<h4 class="text-muted-foreground mb-1.5 text-xs font-semibold tracking-wide uppercase">Overridden</h4>
				<ul class="space-y-1">
					{#each context.overridden as o (o.item_id)}
						{@const winner =
							o.kind === 'skill'
								? context.skills.find((s) => s.item_id === o.overridden_by)
								: context.repos.find((r) => r.item_id === o.overridden_by)}
						<li class="text-muted-foreground flex flex-wrap items-center gap-2 text-sm" transition:slide={{ duration: dur() }}>
							<ContextKindIcon kind={o.kind} size={14} />
							<span class="line-through">{o.name}</span>
							<span class="bg-muted rounded-full px-2 py-0.5 text-xs line-through">{o.scope.label}</span>
							<span class="text-xs">← overridden by the {winner ? winner.scope.label : 'more specific'} one</span>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#each context.conflicts as conflict (conflict.dir)}
			<p class="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
				<IconAlertTriangle size={14} class="mt-0.5 shrink-0" />
				<span>
					{conflict.item_ids.length} repositories resolve to the same checkout directory
					<span class="font-mono">{conflict.dir}/</span> — rename one or set a different checkout dir.
				</span>
			</p>
		{/each}
	</div>
{/if}
