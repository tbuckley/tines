<script lang="ts">
	import type {
		CreateWorkflowRequest,
		StateCategory,
		WorkflowResponse
	} from '@tines/shared';
	import { ApiError, STATE_CATEGORIES } from '@tines/shared';
	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import IconTrash from '@tabler/icons-svelte/icons/trash';
	import { slide } from 'svelte/transition';
	import WorkflowGraph from '$lib/components/WorkflowGraph.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Select } from '$lib/components/ui/select/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { CATEGORY_LABELS, prefersReducedMotion } from '$lib/format';

	interface RowState {
		key: string;
		/** Set for states that already exist on the server. */
		id?: string;
		name: string;
		category: StateCategory;
	}

	let {
		workflow = null,
		saveLabel = 'Save workflow',
		onsave
	}: {
		workflow?: WorkflowResponse | null;
		saveLabel?: string;
		/** Called with the request body; throw an ApiError to surface it inline. */
		onsave: (request: CreateWorkflowRequest) => Promise<void>;
	} = $props();

	let nextKey = 0;
	const freshKey = () => `new-${nextKey++}`;

	// The editor deliberately seeds from the workflow prop once; callers
	// re-mount it ({#key}) when the server copy changes.
	/* eslint-disable svelte/no-state-referenced-locally */
	// svelte-ignore state_referenced_locally
	let name = $state(workflow?.name ?? '');
	// svelte-ignore state_referenced_locally
	let description = $state(workflow?.description ?? '');
	// svelte-ignore state_referenced_locally
	let states = $state<RowState[]>(
		workflow
			? workflow.states.map((s) => ({ key: s.id, id: s.id, name: s.name, category: s.category }))
			: [
					{ key: freshKey(), name: 'Open', category: 'active' },
					{ key: freshKey(), name: 'Done', category: 'done' }
				]
	);
	// svelte-ignore state_referenced_locally
	let transitions = $state<{ from: string; to: string }[]>(
		workflow
			? workflow.transitions.map((t) => ({ from: t.from_state_id, to: t.to_state_id }))
			: [{ from: states[0].key, to: states[1].key }]
	);
	// svelte-ignore state_referenced_locally
	let initialKey = $state(workflow?.initial_state_id ?? states[0].key);
	/* eslint-enable svelte/no-state-referenced-locally */

	let saving = $state(false);
	let errorMessage = $state<string | null>(null);

	function addState() {
		const key = freshKey();
		states = [...states, { key, name: '', category: 'active' }];
	}

	function removeState(key: string) {
		states = states.filter((s) => s.key !== key);
		transitions = transitions.filter((t) => t.from !== key && t.to !== key);
		if (initialKey === key) {
			const fallback = states.find((s) => s.category === 'backlog' || s.category === 'active');
			initialKey = fallback?.key ?? states[0]?.key ?? '';
		}
	}

	function hasTransition(from: string, to: string): boolean {
		return transitions.some((t) => t.from === from && t.to === to);
	}

	function toggleTransition(from: string, to: string) {
		transitions = hasTransition(from, to)
			? transitions.filter((t) => !(t.from === from && t.to === to))
			: [...transitions, { from, to }];
	}

	// Live graph preview: row keys stand in for state ids.
	const preview = $derived({
		states: states.map((s) => ({
			id: s.key,
			name: s.name.trim() || 'unnamed',
			category: s.category
		})),
		transitions: transitions.map((t) => ({ from_state_id: t.from, to_state_id: t.to })),
		initial_state_id: initialKey
	});

	// Inline validation, mirroring the server rules.
	const problems = $derived.by(() => {
		const list: string[] = [];
		if (!name.trim()) list.push('Give the workflow a name.');
		if (states.length === 0) list.push('A workflow needs at least one state.');
		if (states.some((s) => !s.name.trim())) list.push('Every state needs a name.');
		const names = states.map((s) => s.name.trim()).filter(Boolean);
		if (new Set(names).size !== names.length) list.push('State names must be unique.');
		const initial = states.find((s) => s.key === initialKey);
		if (!initial) list.push('Pick an initial state.');
		else if (initial.category !== 'backlog' && initial.category !== 'active') {
			list.push('The initial state must be categorized “backlog” or “active”.');
		}
		return list;
	});

	const warnings = $derived(
		states
			.filter((s) => s.category !== 'done' && !transitions.some((t) => t.from === s.key))
			.map((s) => `“${s.name.trim() || 'unnamed'}” is not “done” but has no way out — issues that reach it will be stuck.`)
	);

	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (saving || problems.length > 0) return;
		saving = true;
		errorMessage = null;
		const byKey = new Map(states.map((s) => [s.key, s]));
		const ref = (key: string) => {
			const s = byKey.get(key)!;
			return s.id ?? s.name.trim();
		};
		try {
			await onsave({
				name: name.trim(),
				description: description.trim(),
				initial_state: ref(initialKey),
				states: states.map((s) => ({
					...(s.id ? { id: s.id } : {}),
					name: s.name.trim(),
					category: s.category
				})),
				transitions: transitions.map((t) => ({ from: ref(t.from), to: ref(t.to) }))
			});
		} catch (err) {
			errorMessage = err instanceof ApiError ? err.message : 'Failed to save the workflow.';
		} finally {
			saving = false;
		}
	}

	const dur = () => (prefersReducedMotion() ? 0 : 180);
</script>

<div class="grid gap-8 lg:grid-cols-2">
	<!-- form editor: how a workflow is written -->
	<form onsubmit={save} class="min-w-0 space-y-5">
		<div class="space-y-1.5">
			<label class="text-sm font-medium" for="wf-name">Name</label>
			<Input id="wf-name" bind:value={name} placeholder="e.g. Engineering" required />
		</div>
		<div class="space-y-1.5">
			<label class="text-sm font-medium" for="wf-description">Description</label>
			<Textarea id="wf-description" bind:value={description} rows={2} placeholder="When to use this workflow…" />
		</div>

		<div class="space-y-3">
			<div class="flex items-center justify-between">
				<h3 class="text-sm font-semibold">States</h3>
				<Button type="button" size="sm" variant="outline" onclick={addState}>
					<IconPlus size={14} /> Add state
				</Button>
			</div>
			{#each states as row, i (row.key)}
				<div class="space-y-2 rounded-lg border p-3" transition:slide={{ duration: dur() }}>
					<div class="flex items-center gap-2">
						<Input bind:value={states[i].name} placeholder="State name" class="flex-1" aria-label="State name" />
						<Select bind:value={states[i].category} class="w-40" aria-label="Category">
							{#each STATE_CATEGORIES as cat (cat)}
								<option value={cat}>{CATEGORY_LABELS[cat]}</option>
							{/each}
						</Select>
						<label class="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs" title="Newly created issues land here">
							<input type="radio" name="initial-state" value={row.key} bind:group={initialKey} />
							initial
						</label>
						<Button
							type="button"
							size="icon"
							variant="ghost"
							class="text-muted-foreground hover:text-destructive size-8 shrink-0"
							onclick={() => removeState(row.key)}
							aria-label="Remove state"
						>
							<IconTrash size={15} />
						</Button>
					</div>
					{#if states.length > 1}
						<div class="flex flex-wrap items-center gap-1.5 text-xs">
							<span class="text-muted-foreground">can move to:</span>
							{#each states.filter((s) => s.key !== row.key) as target (target.key)}
								<button
									type="button"
									class="rounded-full border px-2.5 py-1 transition-colors {hasTransition(row.key, target.key)
										? 'border-primary/50 bg-primary/10 text-primary font-medium'
										: 'text-muted-foreground hover:border-ring/60'}"
									onclick={() => toggleTransition(row.key, target.key)}
									aria-pressed={hasTransition(row.key, target.key)}
								>
									{target.name.trim() || 'unnamed'}
								</button>
							{/each}
						</div>
					{/if}
				</div>
			{/each}
		</div>

		{#if problems.length > 0}
			<ul class="text-muted-foreground space-y-1 text-xs">
				{#each problems as problem (problem)}
					<li>• {problem}</li>
				{/each}
			</ul>
		{/if}
		{#each warnings as warning (warning)}
			<p class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400" transition:slide={{ duration: dur() }}>
				{warning}
			</p>
		{/each}
		{#if errorMessage}
			<p class="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm" transition:slide={{ duration: dur() }}>
				{errorMessage}
			</p>
		{/if}

		<Button type="submit" disabled={saving || problems.length > 0}>
			{saving ? 'Saving…' : saveLabel}
		</Button>
	</form>

	<!-- graph view: how a workflow is read; re-renders live as the form changes -->
	<div class="min-w-0">
		<div class="bg-muted/30 sticky top-20 rounded-lg border p-4">
			<h3 class="text-muted-foreground mb-3 text-xs font-medium tracking-wide uppercase">Live preview</h3>
			<WorkflowGraph workflow={preview} />
		</div>
	</div>
</div>
