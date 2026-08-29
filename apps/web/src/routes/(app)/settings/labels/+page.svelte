<script lang="ts">
	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import IconTrash from '@tabler/icons-svelte/icons/trash';
	import { LABEL_COLORS, type LabelColor, type LabelWithUsage } from '@tines/shared';
	import { invalidateAll } from '$app/navigation';
	import { api } from '$lib/api';
	import LabelChip from '$lib/components/LabelChip.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Select } from '$lib/components/ui/select/index.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';

	let { data } = $props();

	let newName = $state('');
	let creating = $state(false);
	let errorMessage = $state<string | null>(null);
	let pendingDelete = $state<LabelWithUsage | null>(null);

	async function run(fn: () => Promise<unknown>) {
		errorMessage = null;
		try {
			await fn();
			await invalidateAll();
		} catch (e) {
			errorMessage = e instanceof Error ? e.message : 'Something went wrong — try again.';
		}
	}

	async function create(e: SubmitEvent) {
		e.preventDefault();
		const name = newName.trim();
		if (!name || creating) return;
		creating = true;
		await run(async () => {
			await api.createLabel({ name });
			newName = '';
		});
		creating = false;
	}
</script>

<svelte:head><title>Labels · Tines</title></svelte:head>

<h1 class="mb-1 text-2xl font-semibold tracking-tight">Labels</h1>
<p class="text-muted-foreground mb-6 text-sm">
	Labels are shared across every project. Agents can apply the ones listed here, but only you
	can add to the vocabulary.
</p>

{#if errorMessage}
	<p class="text-destructive mb-4 text-sm" role="alert">{errorMessage}</p>
{/if}

<form onsubmit={create} class="mb-6 flex flex-wrap items-center gap-2">
	<Input bind:value={newName} placeholder="New label name" class="h-9 w-56" aria-label="New label name" />
	<Button type="submit" size="sm" disabled={creating || newName.trim().length === 0}>
		<IconPlus size={16} /> Create
	</Button>
</form>

{#if data.labels.length === 0}
	<div class="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">
		No labels yet — create one above, or add one from any issue.
	</div>
{:else}
	<ul class="divide-y rounded-lg border">
		{#each data.labels as label (label.id)}
			<li class="flex flex-wrap items-center gap-3 px-4 py-3">
				<span class="w-40 shrink-0"><LabelChip {label} /></span>
				<Input
					value={label.name}
					class="h-9 w-48"
					aria-label="Rename {label.name}"
					onchange={(e) => {
						const name = e.currentTarget.value.trim();
						if (name && name !== label.name) run(() => api.updateLabel(label.id, { name }));
					}}
				/>
				<Select
					class="h-9 w-32"
					value={label.color}
					aria-label="Color for {label.name}"
					onchange={(e) => run(() => api.updateLabel(label.id, { color: e.currentTarget.value as LabelColor }))}
				>
					{#each LABEL_COLORS as color (color)}
						<option value={color}>{color}</option>
					{/each}
				</Select>
				<Input
					value={label.description}
					placeholder="Description"
					class="h-9 min-w-40 flex-1"
					aria-label="Description for {label.name}"
					onchange={(e) => {
						const description = e.currentTarget.value;
						if (description !== label.description)
							run(() => api.updateLabel(label.id, { description }));
					}}
				/>
				<a
					class="text-muted-foreground w-24 shrink-0 text-right text-xs hover:underline"
					href="/issues?label={encodeURIComponent(label.id)}"
				>
					{label.issue_count} issue{label.issue_count === 1 ? '' : 's'}
				</a>
				<Button
					size="sm"
					variant="ghost"
					aria-label="Delete {label.name}"
					onclick={() => (pendingDelete = label)}
				>
					<IconTrash size={16} />
				</Button>
			</li>
		{/each}
	</ul>
{/if}

<AlertDialog.Root
	open={pendingDelete !== null}
	onOpenChange={(open) => {
		if (!open) pendingDelete = null;
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete “{pendingDelete?.name}”?</AlertDialog.Title>
			<AlertDialog.Description>
				{#if pendingDelete && pendingDelete.issue_count > 0}
					It will be removed from {pendingDelete.issue_count} issue{pendingDelete.issue_count === 1
						? ''
						: 's'}. This cannot be undone.
				{:else}
					This cannot be undone.
				{/if}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				onclick={() => {
					const target = pendingDelete;
					pendingDelete = null;
					if (target) run(() => api.deleteLabel(target.id));
				}}
			>
				Delete
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
