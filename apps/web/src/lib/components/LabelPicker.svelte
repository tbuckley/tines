<script lang="ts">
	import { Popover } from 'bits-ui';
	import IconCheck from '@tabler/icons-svelte/icons/check';
	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import { LABEL_NAME_MAX, type Label, type LabelWithUsage } from '@tines/shared';
	import type { Snippet } from 'svelte';
	import LabelChip from '$lib/components/LabelChip.svelte';
	import { api } from '$lib/api';

	let {
		labels,
		selected,
		onchange,
		allowCreate = false,
		oncreated,
		label: fieldLabel = 'Labels',
		trigger
	}: {
		labels: (Label | LabelWithUsage)[];
		/** Selected label ids. */
		selected: string[];
		onchange: (ids: string[]) => void;
		/** Offer "Create ‘x’" when the query matches no existing label. */
		allowCreate?: boolean;
		/** Fired after a label is minted, so the caller can extend its list. */
		oncreated?: (label: Label) => void;
		label?: string;
		trigger: Snippet<[{ props: Record<string, unknown> }]>;
	} = $props();

	let open = $state(false);
	let query = $state('');
	let creating = $state(false);
	let error = $state<string | null>(null);

	const matches = $derived(
		labels.filter((l) => l.name.toLowerCase().includes(query.trim().toLowerCase()))
	);
	// Only offer creation when the query is a genuinely new name, not merely
	// one that no *visible* row matches (a prefix of an existing label). A
	// leading `-` is reserved for a future negation syntax and the API
	// refuses it, so the row simply does not appear rather than offering a
	// create the server would 422.
	const canCreate = $derived(
		allowCreate &&
			query.trim().length > 0 &&
			!query.trim().startsWith('-') &&
			!labels.some((l) => l.name.toLowerCase() === query.trim().toLowerCase())
	);

	function toggle(id: string) {
		onchange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
	}

	async function create() {
		const name = query.trim();
		if (!name || creating) return;
		creating = true;
		error = null;
		try {
			const created = await api.createLabel({ name });
			oncreated?.(created);
			onchange([...selected, created.id]);
			query = '';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not create label';
		} finally {
			creating = false;
		}
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			{@render trigger({ props })}
		{/snippet}
	</Popover.Trigger>
	<Popover.Portal>
		<Popover.Content
			sideOffset={6}
			align="start"
			collisionPadding={8}
			class="bg-popover text-popover-foreground data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 ring-foreground/10 z-50 w-64 rounded-lg p-1 shadow-md ring-1 outline-none"
		>
			<!-- svelte-ignore a11y_autofocus -->
			<input
				bind:value={query}
				autofocus
				maxlength={LABEL_NAME_MAX}
				placeholder="Filter labels…"
				aria-label="Filter {fieldLabel.toLowerCase()}"
				class="placeholder:text-muted-foreground w-full rounded-md bg-transparent px-2 py-1.5 text-sm outline-none"
				onkeydown={(e) => {
					if (e.key === 'Enter' && canCreate) {
						e.preventDefault();
						create();
					}
				}}
			/>
			<div class="max-h-64 overflow-y-auto border-t pt-1">
				{#each matches as label (label.id)}
					{@const on = selected.includes(label.id)}
					<button
						type="button"
						class="hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left"
						aria-pressed={on}
						onclick={() => toggle(label.id)}
					>
						<span class="text-primary flex size-4 shrink-0 items-center justify-center">
							{#if on}<IconCheck size={14} stroke={2.5} />{/if}
						</span>
						<LabelChip {label} size="sm" class="min-w-0 truncate" />
					</button>
				{:else}
					{#if !canCreate}
						<p class="text-muted-foreground px-2 py-3 text-center text-xs">
							{labels.length === 0 ? 'No labels yet.' : 'No labels match.'}
						</p>
					{/if}
				{/each}
				{#if canCreate}
					<button
						type="button"
						class="hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
						disabled={creating}
						onclick={create}
					>
						<IconPlus size={14} class="shrink-0" />
						<span class="truncate">Create “{query.trim()}”</span>
					</button>
				{/if}
			</div>
			{#if error}
				<p class="text-destructive px-2 py-1.5 text-xs">{error}</p>
			{/if}
		</Popover.Content>
	</Popover.Portal>
</Popover.Root>
