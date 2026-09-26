<script lang="ts">
	import type { ContextKind, GuidanceInclusion } from '@tines/shared';
	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import { slide } from 'svelte/transition';
	import { invalidateAll } from '$app/navigation';
	import { api } from '$lib/api';
	import ContextKindIcon from '$lib/components/ContextKindIcon.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import PendingButton from '$lib/components/PendingButton.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Select } from '$lib/components/ui/select/index.js';
	import { prefersReducedMotion } from '$lib/format';

	type Candidate = Pick<GuidanceInclusion, 'item_id' | 'kind' | 'name' | 'scope_label'>;

	/**
	 * The owner's view of a shared project's guidance (Tines/752): library
	 * items stay private until included here, and the review disclosure lists
	 * everything else the project shares automatically.
	 */
	let {
		projectId,
		guidance,
		editable = true,
		onerror
	}: {
		projectId: string;
		guidance: {
			included: GuidanceInclusion[];
			candidates: Candidate[];
			projectItemCount: number;
			workflows: {
				id: string;
				name: string;
				items: { id: string; kind: ContextKind; name: string; state: string }[];
			}[];
		};
		editable?: boolean;
		onerror: (e: unknown) => void;
	} = $props();

	const dur = () => (prefersReducedMotion() ? 0 : 180);

	let pickerOpen = $state(false);
	let query = $state('');
	let kindFilter = $state<'' | Candidate['kind']>('');
	let busyId = $state<string | null>(null);

	const shown = $derived.by(() => {
		const q = query.trim().toLowerCase();
		return guidance.candidates.filter(
			(c) =>
				(kindFilter === '' || c.kind === kindFilter) &&
				(q === '' || c.name.toLowerCase().includes(q) || c.scope_label.toLowerCase().includes(q))
		);
	});

	async function run(itemId: string, write: () => Promise<unknown>) {
		busyId = itemId;
		try {
			await write();
			await invalidateAll();
		} catch (e) {
			onerror(e);
		} finally {
			busyId = null;
		}
	}

	const include = (itemId: string) => run(itemId, () => api.includeGuidanceItem(projectId, itemId));
	const exclude = (itemId: string) => run(itemId, () => api.excludeGuidanceItem(projectId, itemId));

	function openPicker() {
		query = '';
		kindFilter = '';
		pickerOpen = true;
	}

	const workflowItemCount = $derived(
		guidance.workflows.reduce((n, group) => n + group.items.length, 0)
	);
</script>

<section
	id="shared-guidance"
	class="mt-4 rounded-lg border p-3"
	aria-labelledby="shared-guidance-heading"
>
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h3 id="shared-guidance-heading" class="text-sm font-semibold">Shared guidance</h3>
		{#if editable}
			<Button size="sm" variant="outline" class="min-h-11 sm:min-h-8" onclick={openPicker}>
				<IconPlus size={14} /> Include from library
			</Button>
		{/if}
	</div>
	<p class="text-muted-foreground mt-1 text-xs">
		Project, issue and workflow-stage guidance is shared automatically. Items from your library are
		private until you include them.
	</p>
	{#if guidance.included.length > 0}
		<ul class="mt-3 divide-y rounded-md border" aria-label="Included from your library">
			{#each guidance.included as item (item.item_id)}
				<li
					class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
					transition:slide={{ duration: dur() }}
				>
					<span class="text-muted-foreground shrink-0" title={item.kind}>
						<ContextKindIcon kind={item.kind} />
					</span>
					<span class="min-w-0 flex-1 break-words">
						<span class="font-medium">{item.name}</span>
						<span class="text-muted-foreground text-xs">· {item.scope_label}</span>
					</span>
					{#if editable}
						<PendingButton
							size="sm"
							variant="ghost"
							class="min-h-11 sm:min-h-8"
							pending={busyId === item.item_id}
							pendingLabel="Removing…"
							disabled={busyId !== null}
							aria-label={`Remove ${item.name} from shared guidance`}
							onclick={() => exclude(item.item_id)}
						>
							Remove
						</PendingButton>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

	<details class="mt-3 text-sm">
		<summary
			class="text-muted-foreground hover:text-foreground min-h-11 cursor-pointer py-2 sm:min-h-0"
		>
			Review shared guidance
		</summary>
		<div class="mt-2 space-y-3">
			<div>
				<h4 class="text-xs font-semibold">This project</h4>
				<p class="text-muted-foreground text-xs">
					{guidance.projectItemCount} project item{guidance.projectItemCount === 1 ? '' : 's'},
					listed above.
				</p>
			</div>
			{#each guidance.workflows as group (group.id)}
				<div>
					<h4 class="text-xs font-semibold">{group.name}</h4>
					<ul class="mt-1 space-y-1">
						{#each group.items as item (item.id)}
							<li class="flex items-center gap-2 text-xs">
								<span class="text-muted-foreground shrink-0" title={item.kind}>
									<ContextKindIcon kind={item.kind} size={14} />
								</span>
								<span class="min-w-0 break-words">{item.name}</span>
								<span class="text-muted-foreground shrink-0">· {item.state}</span>
							</li>
						{/each}
					</ul>
				</div>
			{/each}
			{#if workflowItemCount === 0}
				<p class="text-muted-foreground text-xs">
					No workflow-stage guidance for this project's open issues.
				</p>
			{/if}
			<div>
				<h4 class="text-xs font-semibold">Included from your library</h4>
				{#if guidance.included.length === 0}
					<p class="text-muted-foreground text-xs">Nothing included.</p>
				{:else}
					<ul class="mt-1 space-y-1">
						{#each guidance.included as item (item.item_id)}
							<li class="flex items-center gap-2 text-xs">
								<span class="text-muted-foreground shrink-0" title={item.kind}>
									<ContextKindIcon kind={item.kind} size={14} />
								</span>
								<span class="min-w-0 break-words">{item.name}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>
	</details>
</section>

<Modal bind:open={pickerOpen} title="Include from library">
	<p class="text-muted-foreground mb-3 text-sm">
		Everyone in this project and their agents can read what you include; future edits stay shared.
	</p>
	<div class="mb-3 flex flex-col gap-2 sm:flex-row">
		<Input
			type="search"
			placeholder="Search your library"
			aria-label="Search your library"
			bind:value={query}
			class="flex-1"
		/>
		<Select aria-label="Kind" bind:value={kindFilter} class="sm:w-36">
			<option value="">All kinds</option>
			<option value="prompt">Prompts</option>
			<option value="skill">Skills</option>
			<option value="repo">Repos</option>
		</Select>
	</div>
	{#if guidance.candidates.length === 0}
		<p class="text-muted-foreground rounded-md border border-dashed p-4 text-center text-sm">
			Nothing left to include. Only global or label-scoped prompts, skills and repos can be
			included.
		</p>
	{:else if shown.length === 0}
		<p class="text-muted-foreground rounded-md border border-dashed p-4 text-center text-sm">
			No library items match.
		</p>
	{:else}
		<ul class="max-h-[50vh] divide-y overflow-y-auto rounded-md border">
			{#each shown as item (item.item_id)}
				<li class="flex items-center gap-3 px-3 py-2 text-sm">
					<span class="text-muted-foreground shrink-0" title={item.kind}>
						<ContextKindIcon kind={item.kind} />
					</span>
					<span class="min-w-0 flex-1 break-words">
						<span class="font-medium">{item.name}</span>
						<span class="text-muted-foreground text-xs">· {item.scope_label}</span>
					</span>
					<PendingButton
						size="sm"
						variant="outline"
						class="min-h-11 sm:min-h-8"
						pending={busyId === item.item_id}
						pendingLabel="Including…"
						disabled={busyId !== null}
						aria-label={`Include ${item.name}`}
						onclick={() => include(item.item_id)}
					>
						Include
					</PendingButton>
				</li>
			{/each}
		</ul>
	{/if}
</Modal>
