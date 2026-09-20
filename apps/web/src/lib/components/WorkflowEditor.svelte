<script lang="ts">
	import type {
		ArtifactRequirement,
		ArtifactType,
		CreateWorkflowRequest,
		StateCategory,
		WorkflowResponse
	} from '@tines/shared';
	import { ApiError, ARTIFACT_NAME_PATTERN, ARTIFACT_TYPES, STATE_CATEGORIES } from '@tines/shared';
	import IconArrowDown from '@tabler/icons-svelte/icons/arrow-down';
	import IconArrowUp from '@tabler/icons-svelte/icons/arrow-up';
	import IconChevronDown from '@tabler/icons-svelte/icons/chevron-down';
	import IconChevronUp from '@tabler/icons-svelte/icons/chevron-up';
	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import IconTrash from '@tabler/icons-svelte/icons/trash';
	import { flip } from 'svelte/animate';
	import { tick, type Snippet } from 'svelte';
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
		/** Initial stage instructions (new states only) — seeds a context prompt. */
		prompt?: string;
		promptOpen?: boolean;
	}

	let {
		workflow = null,
		saveLabel = 'Save workflow',
		onsave,
		footerActions
	}: {
		workflow?: WorkflowResponse | null;
		saveLabel?: string;
		/** Called with the request body; throw an ApiError to surface it inline. */
		onsave: (request: CreateWorkflowRequest) => Promise<void>;
		/** Extra controls for the save row, aligned opposite the submit button. */
		footerActions?: Snippet;
	} = $props();
	const previewUid = $props.id();
	const previewHeadingId = `workflow-preview-${previewUid}`;
	const previewRegionId = `workflow-preview-region-${previewUid}`;
	let previewFit = $state(true);
	let previewRegion: HTMLDivElement | undefined = $state();
	const PREVIEW_FADE = 24;
	const PREVIEW_EDGE = 2;
	let previewHiddenLeft = $state(false);
	let previewHiddenRight = $state(false);
	const previewMask = $derived(
		previewHiddenLeft || previewHiddenRight
			? `linear-gradient(to right, ${previewHiddenLeft ? 'transparent' : '#000'} 0, #000 ${PREVIEW_FADE}px, #000 calc(100% - ${PREVIEW_FADE}px), ${previewHiddenRight ? 'transparent' : '#000'} 100%)`
			: undefined
	);

	function measurePreviewOverflow() {
		const el = previewRegion;
		if (!el) return;
		previewHiddenLeft = el.scrollLeft > PREVIEW_EDGE;
		previewHiddenRight = el.scrollLeft < el.scrollWidth - el.clientWidth - PREVIEW_EDGE;
	}

	async function setPreviewFit(fit: boolean) {
		if (fit === previewFit) return;
		previewFit = fit;
		await tick();
		if (previewRegion) previewRegion.scrollLeft = 0;
	}

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
			? workflow.states.map((s) => ({ key: s.id, id: s.id, name: s.name, category: s.category }))
			: [
					{ key: freshKey(), name: 'Open', category: 'active' },
					{ key: freshKey(), name: 'Done', category: 'done' }
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
	let moveAnnouncement = $state('');
	let expandedStateKey = $state<string | null>(null);
	const stateRowElements = new Map<string, HTMLDivElement>();

	function registerStateRow(node: HTMLDivElement, key: string) {
		stateRowElements.set(key, node);
		return {
			destroy() {
				if (stateRowElements.get(key) === node) stateRowElements.delete(key);
			}
		};
	}

	async function addState() {
		const key = freshKey();
		states = [...states, { key, name: '', category: 'active' }];
		expandedStateKey = key;
		await tick();
		stateRowElements
			.get(key)
			?.querySelector<HTMLInputElement>('input[aria-label="State name"]')
			?.focus();
	}

	function removeState(key: string) {
		states = states.filter((s) => s.key !== key);
		transitions = transitions.filter((t) => t.from !== key && t.to !== key);
		if (expandedStateKey === key) expandedStateKey = null;
		if (initialKey === key) {
			const fallback = states.find((s) => s.category === 'backlog' || s.category === 'active');
			initialKey = fallback?.key ?? states[0]?.key ?? '';
		}
	}

	async function toggleState(key: string) {
		const opening = expandedStateKey !== key;
		expandedStateKey = opening ? key : null;
		await tick();
		const rowElement = stateRowElements.get(key);
		if (opening) {
			rowElement?.querySelector<HTMLInputElement>('input[aria-label="State name"]')?.focus();
		} else {
			rowElement?.querySelector<HTMLButtonElement>('[data-state-toggle]')?.focus();
		}
	}

	async function moveState(index: number, delta: -1 | 1) {
		const destination = index + delta;
		if (saving || destination < 0 || destination >= states.length) return;
		const next = [...states];
		const [row] = next.splice(index, 1);
		next.splice(destination, 0, row);
		states = next;
		moveAnnouncement = `${stateName(row.key)} moved to position ${destination + 1} of ${states.length}.`;

		await tick();
		const direction = delta === -1 ? 'up' : 'down';
		const opposite = delta === -1 ? 'down' : 'up';
		const rowElement = stateRowElements.get(row.key);
		const movedButton = rowElement?.querySelector<HTMLButtonElement>(
			`button[data-move-direction="${direction}"]`
		);
		if (movedButton && !movedButton.disabled) movedButton.focus();
		else
			rowElement
				?.querySelector<HTMLButtonElement>(`button[data-move-direction="${opposite}"]`)
				?.focus();
	}

	function addTransition(fromKey: string) {
		const target = states.find((s) => s.key !== fromKey);
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
			id: t.key,
			name: t.name.trim() || undefined,
			from_state_id: t.from,
			to_state_id: t.to
		})),
		initial_state_id: initialKey
	});

	$effect(() => {
		// Editing the workflow can change the graph's intrinsic width without
		// changing the scroller. Keep each fade matched to the content still
		// hidden beyond that edge, including after switching zoom modes.
		void preview;
		void previewFit;
		const el = previewRegion;
		if (!el) return;
		const sync = () => measurePreviewOverflow();
		sync();
		const frame = requestAnimationFrame(sync);
		const observer = new ResizeObserver(sync);
		observer.observe(el);
		if (el.firstElementChild) observer.observe(el.firstElementChild);
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
		};
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

	const warnings = $derived(
		states
			.filter((s) => s.category !== 'done' && !transitions.some((t) => t.from === s.key))
			.map(
				(s) =>
					`“${s.name.trim() || 'unnamed'}” is not “done” but has no way out — issues that reach it will be stuck.`
			)
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
					category: s.category,
					// New states only: existing stage instructions are edited as
					// context items, not through workflow updates.
					...(!s.id && s.prompt?.trim() ? { prompt: s.prompt.trim() } : {})
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
			errorMessage = err instanceof ApiError ? err.message : 'Failed to save the workflow.';
		} finally {
			saving = false;
		}
	}

	const dur = (milliseconds = 180) => (prefersReducedMotion() ? 0 : milliseconds);
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
			<div class="flex items-start justify-between gap-3">
				<div>
					<h3 class="flex items-baseline gap-2 text-sm font-semibold">
						States <span class="text-muted-foreground text-xs font-normal">{states.length}</span>
					</h3>
					<p class="text-muted-foreground mt-1 max-w-xl text-xs">
						Order determines which transitions count as sent back in State analysis. Saving a new
						order also updates how past transitions are counted.
					</p>
				</div>
				<Button type="button" size="sm" variant="outline" onclick={addState}>
					<IconPlus size={14} /> Add state
				</Button>
			</div>
			<div class="sr-only" role="status" aria-live="polite">{moveAnnouncement}</div>
			<div class="divide-y overflow-hidden rounded-lg border">
				{#each states as row, i (row.key)}
					{@const outgoing = transitions.filter((t) => t.from === row.key)}
					{@const requirements = outgoing.flatMap((transition) => transition.requires)}
					<div
						class="bg-background"
						data-state-row={row.key}
						data-state-name={row.name.trim() || 'unnamed'}
						use:registerStateRow={row.key}
						transition:slide={{ duration: dur() }}
						animate:flip={{ duration: dur(420) }}
					>
						<div class="flex min-w-0 items-stretch">
							<Button
								type="button"
								variant="ghost"
								class="hover:bg-muted/60 h-auto min-w-0 flex-1 justify-start rounded-none px-4 py-3 text-left whitespace-normal"
								aria-label={`${expandedStateKey === row.key ? 'Collapse' : 'Edit'} ${stateName(row.key)} state`}
								aria-expanded={expandedStateKey === row.key}
								aria-controls={`state-editor-${previewUid}-${row.key}`}
								data-state-toggle
								onclick={() => toggleState(row.key)}
							>
								<span class="min-w-0 flex-1 space-y-1">
									<span class="flex flex-wrap items-center gap-1.5">
										<span class="text-foreground font-semibold"
											>{row.name.trim() || 'Unnamed state'}</span
										>
										{#if initialKey === row.key}
											<span
												class="bg-muted text-muted-foreground rounded border px-1.5 py-0.5 text-[10px] font-medium"
											>
												Initial
											</span>
										{/if}
										<span class="text-muted-foreground ml-auto text-xs font-normal">
											{CATEGORY_LABELS[row.category]}
										</span>
									</span>
									<span class="text-muted-foreground block truncate text-xs font-normal">
										{outgoing.length > 0
											? outgoing
													.map(
														(transition) =>
															`${transition.name.trim() || 'Unnamed action'} → ${stateName(transition.to)}`
													)
													.join(' · ')
											: 'No outgoing actions'}
									</span>
									{#if requirements.length > 0}
										<span class="text-muted-foreground block truncate text-xs font-normal">
											{requirements[0].artifact.trim() || 'Unnamed artifact'} · {requirements.length}
											required {requirements.length === 1 ? 'artifact' : 'artifacts'}
										</span>
									{/if}
									{#if !row.id}
										<span class="text-muted-foreground block truncate text-xs font-normal">
											{row.prompt?.trim().split('\n')[0] || 'No stage instructions'}
										</span>
									{/if}
								</span>
								{#if expandedStateKey === row.key}
									<IconChevronUp class="text-muted-foreground" size={16} />
								{:else}
									<IconChevronDown class="text-muted-foreground" size={16} />
								{/if}
							</Button>
							<div class="flex shrink-0 items-center gap-0.5 border-l px-1.5">
								<Button
									type="button"
									size="icon"
									variant="ghost"
									class="text-muted-foreground size-8"
									disabled={saving || i === 0}
									aria-label={`Move ${stateName(row.key)} up`}
									title={`Move ${stateName(row.key)} up`}
									data-move-direction="up"
									onclick={() => moveState(i, -1)}
								>
									<IconArrowUp size={14} />
								</Button>
								<Button
									type="button"
									size="icon"
									variant="ghost"
									class="text-muted-foreground size-8"
									disabled={saving || i === states.length - 1}
									aria-label={`Move ${stateName(row.key)} down`}
									title={`Move ${stateName(row.key)} down`}
									data-move-direction="down"
									onclick={() => moveState(i, 1)}
								>
									<IconArrowDown size={14} />
								</Button>
							</div>
						</div>

						{#if expandedStateKey === row.key}
							<div
								id={`state-editor-${previewUid}-${row.key}`}
								class="bg-muted/20 overflow-hidden border-t"
								role="region"
								aria-label={`Edit ${stateName(row.key)} state`}
								in:slide={{ duration: dur(360) }}
								out:slide={{ duration: dur(240) }}
							>
								<div class="space-y-5 p-4">
									<section class="space-y-3" aria-label="State details">
										<div class="grid gap-3 sm:grid-cols-[minmax(0,3fr)_minmax(9rem,2fr)]">
											<div class="space-y-1.5">
												<label class="text-xs font-medium" for="state-name-{row.key}"
													>State name</label
												>
												<Input
													id="state-name-{row.key}"
													bind:value={states[i].name}
													placeholder="State name"
													aria-label="State name"
												/>
											</div>
											<div class="space-y-1.5">
												<label class="text-xs font-medium" for="state-category-{row.key}"
													>Category</label
												>
												<Select
													id="state-category-{row.key}"
													bind:value={states[i].category}
													aria-label="Category"
												>
													{#each STATE_CATEGORIES as cat (cat)}
														<option value={cat}>{CATEGORY_LABELS[cat]}</option>
													{/each}
												</Select>
											</div>
										</div>
										<label
											class="flex w-fit items-center gap-2 text-sm"
											title="Newly created issues land here"
										>
											<input
												type="radio"
												name="initial-state"
												value={row.key}
												bind:group={initialKey}
											/>
											Make initial state
										</label>
									</section>

									{#if !row.id}
										<section class="space-y-2 border-t pt-4" aria-label="Stage instructions">
											<div class="flex flex-wrap items-center justify-between gap-2">
												<h4 class="text-sm font-semibold">Stage instructions</h4>
												{#if !row.promptOpen}
													<Button
														type="button"
														size="sm"
														variant="ghost"
														onclick={() => (states[i].promptOpen = true)}
													>
														<IconPlus size={12} /> Add stage instructions
													</Button>
												{/if}
											</div>
											{#if row.promptOpen}
												<div class="space-y-1.5" transition:slide={{ duration: dur() }}>
													<label class="text-muted-foreground text-xs" for="state-prompt-{row.key}">
														What should an agent do while this issue is in {row.name.trim() ||
															'this state'}?
													</label>
													<Textarea
														id="state-prompt-{row.key}"
														bind:value={states[i].prompt}
														rows={3}
														placeholder="Saved as a state-scoped context prompt named “instructions”…"
													/>
												</div>
											{/if}
										</section>
									{/if}

									<section class="space-y-3 border-t pt-4" aria-label="Actions">
										<div class="flex flex-wrap items-center justify-between gap-2">
											<h4 class="text-sm font-semibold">
												Actions <span class="text-muted-foreground font-normal"
													>{outgoing.length}</span
												>
											</h4>
											<Button
												type="button"
												size="sm"
												variant="ghost"
												disabled={states.length < 2}
												onclick={() => addTransition(row.key)}
											>
												<IconPlus size={12} /> Add action
											</Button>
										</div>
										{#if outgoing.length === 0}
											<p class="text-muted-foreground text-xs">
												No outgoing actions. {row.category === 'done'
													? 'Done states usually end the workflow.'
													: 'Issues here will be stuck until you add one.'}
											</p>
										{/if}
										{#each outgoing as transition (transition.key)}
											{@const ti = transitions.findIndex((t) => t.key === transition.key)}
											<div
												class="bg-background space-y-3 rounded-md border p-3"
												transition:slide={{ duration: dur(280) }}
											>
												<div
													class="grid gap-2 sm:grid-cols-[minmax(0,3fr)_auto_minmax(9rem,2fr)_auto] sm:items-center"
												>
													<Input
														bind:value={transitions[ti].name}
														placeholder="Action name, e.g. approve"
														aria-label="Action name"
													/>
													<span class="text-muted-foreground hidden text-xs sm:inline">→</span>
													<Select bind:value={transitions[ti].to} aria-label="Target state">
														{#each states.filter((s) => s.key !== row.key) as target (target.key)}
															<option value={target.key}>{target.name.trim() || 'unnamed'}</option>
														{/each}
													</Select>
													<Button
														type="button"
														size="icon"
														variant="ghost"
														class="text-muted-foreground hover:text-destructive size-8 justify-self-end"
														onclick={() => removeTransition(transition.key)}
														aria-label={`Remove action from ${stateName(row.key)}`}
													>
														<IconTrash size={13} />
													</Button>
												</div>
												<div class="space-y-2 border-t pt-3">
													{#each transition.requires as requirement (requirement.key)}
														{@const ri = transitions[ti].requires.findIndex(
															(r) => r.key === requirement.key
														)}
														<div
															class="grid gap-2 sm:grid-cols-2"
															transition:slide={{ duration: dur(280) }}
														>
															<Input
																bind:value={transitions[ti].requires[ri].artifact}
																placeholder="Artifact name, e.g. design-doc"
																class="font-mono text-xs"
																aria-label="Required artifact name"
															/>
															<Select
																bind:value={transitions[ti].requires[ri].type}
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
																	placeholder="Content type, e.g. image/"
																	aria-label="Required content type prefix"
																/>
															{/if}
															<div class="flex min-w-0 gap-1">
																<Input
																	bind:value={transitions[ti].requires[ri].description}
																	placeholder="What this artifact should contain"
																	class="min-w-0 flex-1"
																	aria-label="Requirement description"
																/>
																<Button
																	type="button"
																	size="icon"
																	variant="ghost"
																	class="text-muted-foreground hover:text-destructive size-9"
																	onclick={() => removeRequirement(transition.key, requirement.key)}
																	aria-label="Remove requirement"
																>
																	<IconTrash size={13} />
																</Button>
															</div>
														</div>
													{/each}
													<Button
														type="button"
														size="sm"
														variant="ghost"
														class="text-muted-foreground"
														onclick={() => addRequirement(transition.key)}
														title="Gate this action on a fresh artifact (attached since the issue entered this state)"
													>
														<IconPlus size={11} /> Require artifact
													</Button>
												</div>
											</div>
										{/each}
									</section>

									<div class="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
										<Button
											type="button"
											variant="ghost"
											class="text-destructive hover:text-destructive"
											onclick={() => removeState(row.key)}
											aria-label="Remove state"
										>
											<IconTrash size={15} /> Remove state
										</Button>
										<Button type="button" variant="outline" onclick={() => toggleState(row.key)}>
											Collapse {stateName(row.key)}
											<IconChevronUp size={14} />
										</Button>
									</div>
								</div>
							</div>
						{/if}
					</div>
				{/each}
				{#if states.length === 0}
					<p class="text-muted-foreground px-4 py-6 text-center text-sm">No states yet.</p>
				{/if}
			</div>
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
				class="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm"
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
			<div class="mb-3 flex flex-wrap items-center justify-between gap-2">
				<h3
					id={previewHeadingId}
					class="text-muted-foreground text-xs font-medium tracking-wide uppercase"
				>
					Live preview
				</h3>
				<div class="flex gap-1" role="group" aria-label="Preview zoom">
					<Button
						type="button"
						size="sm"
						variant={previewFit ? 'secondary' : 'outline'}
						aria-pressed={previewFit}
						aria-controls={previewRegionId}
						title="Fit graph to preview"
						onclick={() => setPreviewFit(true)}
					>
						Fit
					</Button>
					<Button
						type="button"
						size="sm"
						variant={!previewFit ? 'secondary' : 'outline'}
						aria-pressed={!previewFit}
						aria-controls={previewRegionId}
						title="Show graph at actual size"
						onclick={() => setPreviewFit(false)}
					>
						1×
					</Button>
				</div>
			</div>
			<!-- svelte-ignore a11y_no_noninteractive_tabindex (native keyboard scrolling requires focus) -->
			<div
				bind:this={previewRegion}
				id={previewRegionId}
				onscroll={measurePreviewOverflow}
				style:mask-image={previewMask}
				style:-webkit-mask-image={previewMask}
				class="focus-visible:outline-ring max-w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2"
				role="region"
				tabindex="0"
				aria-labelledby={previewHeadingId}
			>
				<WorkflowGraph workflow={preview} fit={previewFit} />
			</div>
		</div>
	</div>
</div>
