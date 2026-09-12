<script lang="ts">
	import type { PrepareWorkflowPackageResponse } from '@tines/shared';
	import PackageText from './PackageText.svelte';

	let { plan }: { plan: PrepareWorkflowPackageResponse } = $props();
	const patchTitle = (recordId: string, field: string) =>
		`${plan.resolved.names[recordId] ?? recordId} · ${field.replaceAll('_', ' ')}`;
	const occurrenceCount = (patch: (typeof plan.resolved.patches)[number]) =>
		patch.uses.reduce((sum, use) => sum + use.count, 0);
</script>

<section class="space-y-4" aria-labelledby="operations-title">
	<div>
		<h2 id="operations-title" class="text-lg font-semibold">Complete installation plan</h2>
		<p class="text-muted-foreground mt-1 text-sm">
			{plan.operations.length} operations · {plan.budget.statements} atomic statements · expires {new Date(
				plan.expires_at
			).toLocaleTimeString()}
		</p>
	</div>
	<ul class="divide-y rounded-lg border text-sm">
		{#each plan.operations as operation (operation.action + operation.kind + operation.local_id)}
			<li class="grid gap-1 p-3 sm:grid-cols-[6rem_8rem_1fr]">
				<b class="capitalize">{operation.action}</b><span>{operation.kind}</span><span
					class="min-w-0 break-words"
					>{operation.name}{operation.relationship ? ` · ${operation.relationship}` : ''}</span
				>
			</li>
		{/each}
	</ul>

	{#if plan.resolved.patches.length}
		<div class="space-y-3">
			<h3 class="font-semibold">Exact declared substitutions</h3>
			{#each plan.resolved.patches as patch (patch.record_id + patch.field)}
				<article class="rounded-lg border p-3" id="patch-{patch.record_id}-{patch.field}">
					<h4 class="text-sm font-medium">
						{patchTitle(patch.record_id, patch.field)} · {occurrenceCount(patch)} use{occurrenceCount(
							patch
						) === 1
							? ''
							: 's'}
					</h4>
					<div class="mt-2 grid gap-3 lg:grid-cols-2">
						<div class="min-w-0">
							<p class="text-muted-foreground mb-1 text-xs font-medium">Original</p>
							<PackageText text={patch.original} format="text" />
						</div>
						<div class="min-w-0">
							<p class="text-muted-foreground mb-1 text-xs font-medium">Installed value</p>
							<PackageText text={patch.rendered} format="text" />
						</div>
					</div>
				</article>
			{/each}
		</div>
	{/if}

	{#if plan.resolved.routing.length}
		<div class="space-y-3">
			<h3 class="font-semibold">Destination runner capabilities</h3>
			{#each plan.resolved.routing as route (route.local_id)}
				<article class="rounded-lg border p-3 text-sm">
					<p><b>{route.tier}</b> · precedence rule {route.winning_rule_id}</p>
					<ul class="mt-2 space-y-1 text-xs">
						{#each route.targets as target}<li>
								{target.name} · {target.type} · {target.status} · {target.model ?? 'default model'} ·
								{target.supported ? 'supported' : 'not supported'} ·
								<code class="break-all">{target.config}</code>
							</li>{/each}
					</ul>
					{#each route.warnings as warning}<p class="text-muted-foreground mt-1 text-xs">
							{warning}
						</p>{/each}
				</article>
			{/each}
		</div>
	{/if}
</section>
