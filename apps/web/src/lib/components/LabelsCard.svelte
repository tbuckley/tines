<script lang="ts">
	import IconTag from '@tabler/icons-svelte/icons/tag';
	import { compareLabelNames, type IssueLabel, type Label, type LabelWithUsage } from '@tines/shared';
	import { invalidateAll } from '$app/navigation';
	import { api } from '$lib/api';
	import LabelChip from '$lib/components/LabelChip.svelte';
	import LabelPicker from '$lib/components/LabelPicker.svelte';
	import { Button } from '$lib/components/ui/button/index.js';

	let {
		issueId,
		labels,
		library,
		onerror
	}: {
		issueId: string;
		/** Server truth for this issue. */
		labels: IssueLabel[];
		/** The user's whole vocabulary, for the picker. */
		library: LabelWithUsage[];
		onerror: (message: string) => void;
	} = $props();

	// Same discipline as RelationsCard: render server truth + an overlay of
	// in-flight work, so an invalidateAll() belonging to some other mutation
	// (or the live-updates poll) can neither wipe a pending add nor resurrect
	// a pending removal.
	let adds = $state<IssueLabel[]>([]);
	let removals = $state<string[]>([]);
	let picked = $state<Label[]>([]);

	const shown = $derived.by((): IssueLabel[] => {
		const gone = new Set(removals);
		const merged = labels.filter((l) => !gone.has(l.id));
		for (const a of adds) {
			if (gone.has(a.id) || merged.some((l) => l.id === a.id)) continue;
			merged.push(a);
		}
		// Same order the server returns (`COLLATE NOCASE`), so an optimistic
		// chip does not jump when the reload lands.
		return [...merged].sort((a, b) => compareLabelNames(a.name, b.name));
	});
	const selectedIds = $derived(shown.map((l) => l.id));
	// Locally minted labels are visible in the picker before the load reruns.
	const pickerLabels = $derived([
		...library,
		...picked.filter((p) => !library.some((l) => l.id === p.id))
	]);

	async function apply(ids: string[]) {
		const before = new Set(selectedIds);
		const added = ids.filter((id) => !before.has(id));
		const removed = selectedIds.filter((id) => !ids.includes(id));
		await Promise.all([...added.map(add), ...removed.map(remove)]);
	}

	async function add(id: string) {
		const entry = pickerLabels.find((l) => l.id === id);
		if (!entry) return;
		const optimistic: IssueLabel = { id: entry.id, name: entry.name, color: entry.color };
		adds = [...adds, optimistic];
		try {
			await api.addIssueLabels(issueId, [id]);
			await invalidateAll();
		} catch (e) {
			onerror(e instanceof Error ? e.message : 'Could not add label');
		} finally {
			adds = adds.filter((a) => a !== optimistic);
		}
	}

	async function remove(id: string) {
		removals = [...removals, id];
		try {
			await api.removeIssueLabel(issueId, id);
			await invalidateAll();
		} catch (e) {
			onerror(e instanceof Error ? e.message : 'Could not remove label');
		} finally {
			removals = removals.filter((r) => r !== id);
		}
	}
</script>

<section class="rounded-lg border p-4">
	<div class="mb-3 flex items-center justify-between gap-2">
		<h2 class="text-sm font-semibold">Labels</h2>
		<LabelPicker
			labels={pickerLabels}
			selected={selectedIds}
			onchange={apply}
			allowCreate
			oncreated={(l) => (picked = [...picked, l])}
		>
			{#snippet trigger({ props })}
				<Button {...props} size="sm" variant="ghost" class="h-7 px-2 text-xs">
					<IconTag size={14} /> Edit
				</Button>
			{/snippet}
		</LabelPicker>
	</div>
	{#if shown.length === 0}
		<p class="text-muted-foreground text-xs">No labels.</p>
	{:else}
		<div class="flex flex-wrap gap-1.5">
			{#each shown as label (label.id)}
				<LabelChip
					{label}
					size="sm"
					onremove={() => remove(label.id)}
					removeBusy={removals.includes(label.id)}
				/>
			{/each}
		</div>
	{/if}
</section>
