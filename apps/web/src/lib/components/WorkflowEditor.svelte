<script lang="ts">
	import type {
		ArtifactRequirement,
		ArtifactType,
		ContextItem,
		CreateWorkflowRequest,
		LibraryWorkflow,
		StateCategory,
		WorkflowResponse
	} from '@tines/shared';
	import {
		ApiError,
		ARTIFACT_NAME_PATTERN,
		ARTIFACT_TYPES,
		buildStateLibrary,
		chainLengthVia,
		childrenOf,
		MAX_INHERITANCE_CHAIN,
		pickerGroups,
		qualifyState,
		STATE_CATEGORIES,
		wouldCycle
	} from '@tines/shared';
	import IconHierarchy from '@tabler/icons-svelte/icons/hierarchy';
	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import IconTrash from '@tabler/icons-svelte/icons/trash';
	import type { Snippet } from 'svelte';
	import { slide } from 'svelte/transition';
	import { api } from '$lib/api';
	import Markdown from '$lib/components/Markdown.svelte';
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
		/** Initial stage instructions (new states only) — seeds a context prompt. */
		prompt?: string;
		promptOpen?: boolean;
		/**
		 * The state this one inherits context from: a row key when the base is
		 * another row in this editor, otherwise a state id from the library.
		 */
		inheritsFrom: string | null;
		/** What the server last said, so an untouched row emits no pointer. */
		seedInheritsFrom: string | null;
		/** Whether the base's instructions are expanded under the picker. */
		previewOpen?: boolean;
	}

	let {
		workflow = null,
		workflows = [],
		baseItems = [],
		saveLabel = 'Save workflow',
		onsave,
		footerActions
	}: {
		workflow?: WorkflowResponse | null;
		/** Every workflow the user can see — what the Inherits-from picker offers. */
		workflows?: LibraryWorkflow[];
		/** State-scoped items already loaded for the bases this workflow points at. */
		baseItems?: ContextItem[];
		saveLabel?: string;
		/** Called with the request body; throw an ApiError to surface it inline. */
		onsave: (request: CreateWorkflowRequest) => Promise<void>;
		/** Extra controls for the save row, aligned opposite the submit button. */
		footerActions?: Snippet;
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
	interface RowRequirement {
		key: string;
		/** The artifact slot name a fresh artifact must carry. */
		artifact: string;
		/** '' = any type. */
		type: '' | ArtifactType;
		contentType: string;
		description: string;
	}

	interface RowTransition {
		key: string;
		/** The action name, e.g. "approve". */
		name: string;
		from: string;
		to: string;
		/** Artifact requirements gating this transition. */
		requires: RowRequirement[];
	}

	// svelte-ignore state_referenced_locally
	let states = $state<RowState[]>(
		workflow
			? workflow.states.map((s) => ({
					key: s.id,
					id: s.id,
					name: s.name,
					category: s.category,
					inheritsFrom: s.inherits_from ?? null,
					seedInheritsFrom: s.inherits_from ?? null
				}))
			: [
					{
						key: freshKey(),
						name: 'Open',
						category: 'active',
						inheritsFrom: null,
						seedInheritsFrom: null
					},
					{
						key: freshKey(),
						name: 'Done',
						category: 'done',
						inheritsFrom: null,
						seedInheritsFrom: null
					}
				]
	);
	// svelte-ignore state_referenced_locally
	let transitions = $state<RowTransition[]>(
		workflow
			? workflow.transitions.map((t) => ({
					key: t.id,
					name: t.name,
					from: t.from_state_id,
					to: t.to_state_id,
					requires: (t.requires ?? []).map((r) => ({
						key: freshKey(),
						artifact: r.artifact,
						type: r.type ?? '',
						contentType: r.content_type ?? '',
						description: r.description ?? ''
					}))
				}))
			: [
					{
						key: freshKey(),
						name: 'Complete',
						from: states[0].key,
						to: states[1].key,
						requires: []
					}
				]
	);
	// svelte-ignore state_referenced_locally
	let initialKey = $state(workflow?.initial_state_id ?? states[0].key);
	/* eslint-enable svelte/no-state-referenced-locally */

	let saving = $state(false);
	let errorMessage = $state<string | null>(null);

	function addState() {
		const key = freshKey();
		states = [
			...states,
			{ key, name: '', category: 'active', inheritsFrom: null, seedInheritsFrom: null }
		];
	}

	function removeState(key: string) {
		// A row pointing at the removed one is re-pointed in the same PATCH: the
		// API takes that without a force flag, where a dangling pointer 422s.
		states = states
			.filter((s) => s.key !== key)
			.map((s) => (s.inheritsFrom === key ? { ...s, inheritsFrom: null } : s));
		transitions = transitions.filter((t) => t.from !== key && t.to !== key);
		if (initialKey === key) {
			const fallback = states.find((s) => s.category === 'backlog' || s.category === 'active');
			initialKey = fallback?.key ?? states[0]?.key ?? '';
		}
	}

	function addTransition(fromKey: string) {
		const target = states.find(
			(s) => s.key !== fromKey && !transitions.some((t) => t.from === fromKey && t.to === s.key)
		);
		if (!target) return;
		transitions = [
			...transitions,
			{ key: freshKey(), name: '', from: fromKey, to: target.key, requires: [] }
		];
	}

	function removeTransition(key: string) {
		transitions = transitions.filter((t) => t.key !== key);
	}

	function addRequirement(transitionKey: string) {
		const ti = transitions.findIndex((t) => t.key === transitionKey);
		if (ti === -1) return;
		transitions[ti].requires = [
			...transitions[ti].requires,
			{ key: freshKey(), artifact: '', type: '', contentType: '', description: '' }
		];
	}

	function removeRequirement(transitionKey: string, key: string) {
		const ti = transitions.findIndex((t) => t.key === transitionKey);
		if (ti === -1) return;
		transitions[ti].requires = transitions[ti].requires.filter((r) => r.key !== key);
	}

	const stateName = (key: string) => states.find((s) => s.key === key)?.name.trim() || 'unnamed';

	// Live graph preview: row keys stand in for state ids.
	const preview = $derived({
		states: states.map((s) => ({
			id: s.key,
			name: s.name.trim() || 'unnamed',
			category: s.category
		})),
		transitions: transitions.map((t) => ({
			name: t.name.trim() || undefined,
			from_state_id: t.from,
			to_state_id: t.to
		})),
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
		if (transitions.some((t) => !t.name.trim())) list.push('Every action needs a name.');
		const actionKeys = transitions.map((t) => `${t.from}:${t.name.trim().toLowerCase()}`);
		if (new Set(actionKeys).size !== actionKeys.length) {
			list.push('Action names must be unique within a state.');
		}
		const pairs = transitions.map((t) => `${t.from}→${t.to}`);
		if (new Set(pairs).size !== pairs.length) {
			list.push('Only one action can lead from a state to the same target.');
		}
		for (const t of transitions) {
			const slots = t.requires.map((r) => r.artifact.trim());
			if (slots.some((s) => !ARTIFACT_NAME_PATTERN.test(s))) {
				list.push('Requirement artifact names must be slug-like (a-z, 0-9, dashes).');
			}
			if (new Set(slots).size !== slots.length) {
				list.push('An action cannot require the same artifact twice.');
			}
			if (t.requires.some((r) => r.contentType.trim() && r.type !== 'file' && r.type !== 'text')) {
				list.push('A content-type filter needs the requirement type “file” or “text”.');
			}
		}
		return list;
	});

	// --- state inheritance ---------------------------------------------------

	/** The whole visible library: a base usually lives in another workflow. */
	const lib = $derived(buildStateLibrary(workflows));
	/** Rows the picker can offer as a base from inside this editor. */
	const siblingRows = $derived(states.filter((s) => !s.id));
	/** True only for an unsaved sibling; saved row keys are also real state ids. */
	const isUnsavedRowKey = (value: string) => states.some((s) => !s.id && s.key === value);
	const ownWorkflowLabel = $derived(name.trim() || 'This workflow');

	/** What a chosen base is called, whether it is a library state or a row here. */
	function baseLabel(value: string): string {
		const row = states.find((s) => s.key === value);
		if (row && !row.id) return `${ownWorkflowLabel} / ${row.name.trim() || 'unnamed'}`;
		return qualifyState(lib, value);
	}

	/** The base's page, when it is a state the server already knows about. */
	function baseHref(value: string): string | null {
		const entry = lib.states.get(value);
		return entry ? `/workflows/${entry.workflow.id}#state-${value}` : null;
	}

	/** The base's other children, named — "also inherited by …". */
	function otherChildren(row: RowState, value: string): string[] {
		const fromLibrary = childrenOf(lib, value)
			.filter((c) => c.state.id !== row.id)
			.map((c) => `${c.workflow.name} / ${c.state.name}`);
		const fromEditor = states
			.filter((s) => s.key !== row.key && !s.id && s.inheritsFrom === value)
			.map((s) => `${ownWorkflowLabel} / ${s.name.trim() || 'unnamed'}`);
		return [...fromLibrary, ...fromEditor];
	}

	/**
	 * The base's context items, from what the page preloaded and from what this
	 * component fetched after the operator picked a base the page never loaded.
	 */
	let fetched = $state<Record<string, ContextItem[] | 'loading' | 'error'>>({});
	const itemsFor = $derived((stateId: string) => {
		const preloaded = baseItems.filter((i) => i.scope.workflow_state_id === stateId);
		if (preloaded.length > 0) return preloaded;
		return fetched[stateId] ?? null;
	});

	async function loadBaseItems(stateId: string) {
		if (fetched[stateId] !== undefined) return;
		fetched = { ...fetched, [stateId]: 'loading' };
		try {
			const page = await api.listContext({ state: stateId });
			fetched = { ...fetched, [stateId]: page.items };
		} catch {
			fetched = { ...fetched, [stateId]: 'error' };
		}
	}

	/** Show the base's instructions, fetching them the first time it is asked. */
	function togglePreview(i: number) {
		const row = states[i];
		states[i].previewOpen = !row.previewOpen;
		if (states[i].previewOpen && row.inheritsFrom && !isUnsavedRowKey(row.inheritsFrom)) {
			void loadBaseItems(row.inheritsFrom);
		}
	}

	const instructionsOf = (items: ContextItem[]) =>
		items.find((i) => i.kind === 'prompt' && i.name === 'instructions') ?? null;

	const warnings = $derived([
		...states
			.filter((s) => s.category !== 'done' && !transitions.some((t) => t.from === s.key))
			.map(
				(s) =>
					`“${s.name.trim() || 'unnamed'}” is not “done” but has no way out — issues that reach it will be stuck.`
			),
		// Advisory only: the API is the authority on cycles and depth, and its
		// refusal is what the error banner shows. These say it a save earlier.
		...states.flatMap((s) => {
			const value = s.inheritsFrom;
			if (!value) return [];
			const rowName = `“${s.name.trim() || 'unnamed'}”`;
			const base = `“${baseLabel(value)}”`;
			const list: string[] = [];
			const entry = lib.states.get(value);
			if (entry && entry.workflow.issue_count > 0) {
				const n = entry.workflow.issue_count;
				list.push(
					`${base} belongs to a workflow ${n === 1 ? '1 issue uses' : `${n} issues use`} — context added there for those issues reaches ${rowName} too.`
				);
			}
			if (s.id && wouldCycle(lib, s.id, value)) {
				list.push(`${base} already inherits from ${rowName} — saving will be refused as a loop.`);
			} else if (entry?.state.inherits_from) {
				const length = chainLengthVia(lib, value);
				list.push(
					length > MAX_INHERITANCE_CHAIN
						? `${rowName} would sit at the end of a chain of ${length} states — the API allows at most ${MAX_INHERITANCE_CHAIN}, so saving will be refused.`
						: `${rowName} would sit at the end of a chain of ${length} states.`
				);
			}
			return list;
		})
	]);

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
		// A base in this editor resolves like any other sibling ref; anything
		// else is already a state id the API can look up directly.
		const inheritsRef = (value: string) => (byKey.has(value) ? ref(value) : value);
		try {
			await onsave({
				name: name.trim(),
				description: description.trim(),
				initial_state: ref(initialKey),
				states: states.map((s) => ({
					...(s.id ? { id: s.id } : {}),
					name: s.name.trim(),
					category: s.category,
					// New states only: existing stage instructions are edited as
					// context items, not through workflow updates.
					...(!s.id && s.prompt?.trim() ? { prompt: s.prompt.trim() } : {}),
					// Merge-patch: an untouched row emits no key at all, so a round
					// trip through this editor cannot wipe a pointer it never showed.
					...(s.id
						? s.inheritsFrom !== s.seedInheritsFrom
							? { inherits_from: s.inheritsFrom && inheritsRef(s.inheritsFrom) }
							: {}
						: s.inheritsFrom
							? { inherits_from: inheritsRef(s.inheritsFrom) }
							: {})
				})),
				transitions: transitions.map((t) => ({
					name: t.name.trim(),
					from: ref(t.from),
					to: ref(t.to),
					...(t.requires.length > 0
						? {
								requires: t.requires.map((r): ArtifactRequirement => {
									const requirement: ArtifactRequirement = { artifact: r.artifact.trim() };
									if (r.type) requirement.type = r.type;
									if (r.contentType.trim()) requirement.content_type = r.contentType.trim();
									if (r.description.trim()) requirement.description = r.description.trim();
									return requirement;
								})
							}
						: {})
				}))
			});
		} catch (err) {
			if (err instanceof ApiError) {
				// Cycle and depth refusals carry the offending state; saying which
				// row they mean beats a bare message over a form of many states.
				const stateId = err.details?.state_id;
				const row = typeof stateId === 'string' ? byKey.get(stateId) : undefined;
				errorMessage = row ? `“${row.name.trim() || 'unnamed'}”: ${err.message}` : err.message;
			} else {
				errorMessage = 'Failed to save the workflow.';
			}
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
			<Textarea
				id="wf-description"
				bind:value={description}
				rows={2}
				placeholder="When to use this workflow…"
			/>
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
					<div class="flex flex-wrap items-center gap-2">
						<Input
							bind:value={states[i].name}
							placeholder="State name"
							class="min-w-36 flex-1"
							aria-label="State name"
						/>
						<Select bind:value={states[i].category} class="w-40 max-sm:w-36" aria-label="Category">
							{#each STATE_CATEGORIES as cat (cat)}
								<option value={cat}>{CATEGORY_LABELS[cat]}</option>
							{/each}
						</Select>
						<label
							class="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs"
							title="Newly created issues land here"
						>
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
					<!-- inheritance: where this state's context comes from before its own -->
					<div class="flex flex-wrap items-center gap-2">
						<label
							class="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs"
							for="state-base-{row.key}"
						>
							<IconHierarchy size={13} stroke={1.75} /> Inherits from
						</label>
						<Select
							id="state-base-{row.key}"
							bind:value={states[i].inheritsFrom}
							class="h-8 min-w-48 flex-1 text-xs max-sm:w-full"
							aria-label="Inherits from"
						>
							<option value={null}>None</option>
							{#if row.inheritsFrom && !isUnsavedRowKey(row.inheritsFrom) && !lib.states.has(row.inheritsFrom)}
								<!-- keep the select truthful about a pointer we cannot name -->
								<option value={row.inheritsFrom} disabled>Unknown state ({row.inheritsFrom})</option
								>
							{/if}
							{#if siblingRows.some((s) => s.key !== row.key)}
								<optgroup label={ownWorkflowLabel}>
									{#each siblingRows.filter((s) => s.key !== row.key) as sibling (sibling.key)}
										<option value={sibling.key}>{sibling.name.trim() || 'unnamed'}</option>
									{/each}
								</optgroup>
							{/if}
							{#each pickerGroups( lib, { ownWorkflowId: workflow?.id ?? null, excludeStateId: row.id ?? null } ) as group (group.workflow.id)}
								<optgroup label="{group.workflow.name}{group.baseLike ? ' · base' : ''}">
									{#each group.states as target (target.id)}
										<option value={target.id}>{target.name}</option>
									{/each}
								</optgroup>
							{/each}
						</Select>
					</div>
					{#if row.inheritsFrom}
						{@const value = row.inheritsFrom}
						{@const href = baseHref(value)}
						{@const others = otherChildren(row, value)}
						{@const items = isUnsavedRowKey(value) ? null : itemsFor(value)}
						<div
							class="text-muted-foreground space-y-1 text-xs"
							transition:slide={{ duration: dur() }}
						>
							<p class="flex flex-wrap items-center gap-x-2 gap-y-1">
								<span>
									Inherits context from
									{#if href}
										<a class="hover:text-foreground underline underline-offset-2" {href}>
											{baseLabel(value)}
										</a>
									{:else}
										<span class="text-foreground">{baseLabel(value)}</span>
									{/if}
								</span>
								{#if others.length > 0}
									<span>· also inherited by {others.join(', ')}</span>
								{/if}
								{#if href}
									<a class="hover:text-foreground underline underline-offset-2" {href}>
										{isUnsavedRowKey(value) ? 'Go to state' : 'Edit base'} →
									</a>
								{/if}
							</p>
							{#if !isUnsavedRowKey(value)}
								<Button
									type="button"
									size="sm"
									variant="ghost"
									class="text-muted-foreground h-7 px-2 text-xs"
									onclick={() => togglePreview(i)}
								>
									{row.previewOpen ? 'Hide' : 'Show'} inherited instructions
								</Button>
								{#if row.previewOpen}
									<div class="space-y-1" transition:slide={{ duration: dur() }}>
										{#if items === 'loading' || items === null}
											<p>Loading the base's instructions…</p>
										{:else if items === 'error'}
											<p>Could not load the base's instructions.</p>
										{:else}
											{@const instructions = instructionsOf(items)}
											{#if instructions?.body}
												<div class="bg-muted/30 max-h-64 overflow-auto rounded-md border p-3">
													<Markdown source={instructions.body} />
												</div>
											{:else}
												<p>This base has no instructions yet.</p>
											{/if}
											{@const extra = items.filter((item) => item !== instructions).length}
											{#if extra > 0 && href}
												<p>
													<a class="hover:text-foreground underline underline-offset-2" {href}>
														+ {extra} more item{extra === 1 ? '' : 's'} on the base's page
													</a>
												</p>
											{/if}
										{/if}
									</div>
								{/if}
							{/if}
						</div>
					{/if}
					{#if !row.id}
						<!-- creation nudge: seed the state's instructions while it's being made -->
						{#if row.promptOpen}
							<div class="space-y-1" transition:slide={{ duration: dur() }}>
								<label
									class="text-muted-foreground text-xs font-medium"
									for="state-prompt-{row.key}"
								>
									{#if row.inheritsFrom}
										This state's instructions — appended after the inherited ones
									{:else}
										Stage instructions — what “being in {row.name.trim() || 'this state'}” means for
										an agent
									{/if}
								</label>
								<Textarea
									id="state-prompt-{row.key}"
									bind:value={states[i].prompt}
									rows={3}
									class="text-xs"
									placeholder="Saved as a state-scoped context prompt named “instructions”…"
								/>
							</div>
						{:else}
							<Button
								type="button"
								size="sm"
								variant="ghost"
								class="text-muted-foreground h-7 px-2 text-xs"
								onclick={() => (states[i].promptOpen = true)}
							>
								<IconPlus size={12} />
								{row.inheritsFrom ? "Add this state's instructions" : 'Add stage instructions'}
							</Button>
						{/if}
					{/if}
					{#if states.length > 1}
						<div class="space-y-1.5">
							{#each transitions.filter((t) => t.from === row.key) as transition (transition.key)}
								{@const ti = transitions.findIndex((t) => t.key === transition.key)}
								<div class="space-y-1.5" transition:slide={{ duration: dur() }}>
									<div class="flex flex-wrap items-center gap-2">
										<Input
											bind:value={transitions[ti].name}
											placeholder="Action name, e.g. approve"
											class="h-8 min-w-28 flex-1 text-xs"
											aria-label="Action name"
										/>
										<span class="text-muted-foreground text-xs">→</span>
										<Select
											bind:value={transitions[ti].to}
											class="h-8 w-36 text-xs"
											aria-label="Target state"
										>
											{#each states.filter((s) => s.key !== row.key) as target (target.key)}
												<option value={target.key}>{target.name.trim() || 'unnamed'}</option>
											{/each}
										</Select>
										<Button
											type="button"
											size="icon"
											variant="ghost"
											class="text-muted-foreground hover:text-destructive size-7 shrink-0"
											onclick={() => removeTransition(transition.key)}
											aria-label={`Remove action from ${stateName(row.key)}`}
										>
											<IconTrash size={13} />
										</Button>
									</div>
									<!-- artifact requirements: the action only passes with a fresh
									     artifact in the named slot (attached since the issue last
									     entered this state) -->
									<div class="ml-4 space-y-1.5">
										{#each transition.requires as requirement (requirement.key)}
											{@const ri = transitions[ti].requires.findIndex(
												(r) => r.key === requirement.key
											)}
											<div
												class="flex flex-wrap items-center gap-2"
												transition:slide={{ duration: dur() }}
											>
												<span class="text-muted-foreground shrink-0 text-xs">requires artifact</span
												>
												<Input
													bind:value={transitions[ti].requires[ri].artifact}
													placeholder="design-doc"
													class="h-7 w-32 font-mono text-xs"
													aria-label="Required artifact name"
												/>
												<Select
													bind:value={transitions[ti].requires[ri].type}
													class="h-7 w-24 text-xs"
													aria-label="Required artifact type"
												>
													<option value="">any type</option>
													{#each ARTIFACT_TYPES as artifactType (artifactType)}
														<option value={artifactType}>{artifactType}</option>
													{/each}
												</Select>
												{#if transitions[ti].requires[ri].type === 'file' || transitions[ti].requires[ri].type === 'text'}
													<Input
														bind:value={transitions[ti].requires[ri].contentType}
														placeholder="content type, e.g. image/"
														class="h-7 w-36 text-xs"
														aria-label="Required content type prefix"
													/>
												{/if}
												<Input
													bind:value={transitions[ti].requires[ri].description}
													placeholder="what this artifact should contain"
													class="h-7 min-w-28 flex-1 text-xs"
													aria-label="Requirement description"
												/>
												<Button
													type="button"
													size="icon"
													variant="ghost"
													class="text-muted-foreground hover:text-destructive size-7 shrink-0"
													onclick={() => removeRequirement(transition.key, requirement.key)}
													aria-label="Remove requirement"
												>
													<IconTrash size={13} />
												</Button>
											</div>
										{/each}
										<Button
											type="button"
											size="sm"
											variant="ghost"
											class="text-muted-foreground h-6 px-2 text-xs"
											onclick={() => addRequirement(transition.key)}
											title="Gate this action on a fresh artifact (attached since the issue entered this state)"
										>
											<IconPlus size={11} /> Require artifact
										</Button>
									</div>
								</div>
							{/each}
							<Button
								type="button"
								size="sm"
								variant="ghost"
								class="text-muted-foreground h-7 px-2 text-xs"
								disabled={states.filter(
									(s) =>
										s.key !== row.key &&
										!transitions.some((t) => t.from === row.key && t.to === s.key)
								).length === 0}
								onclick={() => addTransition(row.key)}
							>
								<IconPlus size={12} /> Add action
							</Button>
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
			<p
				class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
				transition:slide={{ duration: dur() }}
			>
				{warning}
			</p>
		{/each}
		{#if errorMessage}
			<p
				class="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm whitespace-pre-wrap"
				transition:slide={{ duration: dur() }}
			>
				{errorMessage}
			</p>
		{/if}

		<div class="flex flex-wrap items-center justify-between gap-2">
			<Button type="submit" disabled={saving || problems.length > 0}>
				{saving ? 'Saving…' : saveLabel}
			</Button>
			{#if footerActions}
				<div class="flex gap-2">{@render footerActions()}</div>
			{/if}
		</div>
	</form>

	<!-- graph view: how a workflow is read; re-renders live as the form changes -->
	<div class="min-w-0">
		<div class="bg-muted/30 sticky top-20 rounded-lg border p-4">
			<h3 class="text-muted-foreground mb-3 text-xs font-medium tracking-wide uppercase">
				Live preview
			</h3>
			<WorkflowGraph workflow={preview} />
		</div>
	</div>
</div>
