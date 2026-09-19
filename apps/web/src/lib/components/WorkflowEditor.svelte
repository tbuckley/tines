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
	const stateRowElements = new Map<string, HTMLDivElement>();

	function registerStateRow(node: HTMLDivElement, key: string) {
		stateRowElements.set(key, node);
		return {
			destroy() {
				if (stateRowElements.get(key) === node) stateRowElements.delete(key);
			}
		};
	}

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
			<div class="flex items-start justify-between gap-3">
				<div>
					<h3 class="text-sm font-semibold">States</h3>
					<p class="text-muted-foreground mt-1 text-xs">
						Order determines which transitions count as sent back in State analysis. Saving a new
						order also updates how past transitions are counted.
					</p>
				</div>
				<Button type="button" size="sm" variant="outline" onclick={addState}>
					<IconPlus size={14} /> Add state
				</Button>
			</div>
			<div class="sr-only" role="status" aria-live="polite">{moveAnnouncement}</div>
			{#each states as row, i (row.key)}
				<div
					class="space-y-2 rounded-lg border p-3"
					data-state-row={row.key}
					use:registerStateRow={row.key}
					transition:slide={{ duration: dur() }}
					animate:flip={{ duration: dur() }}
				>
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
						<div class="flex shrink-0 items-center gap-0.5">
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
					{#if !row.id}
						<!-- creation nudge: seed the state's instructions while it's being made -->
						{#if row.promptOpen}
							<div class="space-y-1" transition:slide={{ duration: dur() }}>
								<label
									class="text-muted-foreground text-xs font-medium"
									for="state-prompt-{row.key}"
								>
									Stage instructions — what “being in {row.name.trim() || 'this state'}” means for
									an agent
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
								<IconPlus size={12} /> Add stage instructions
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
								disabled={states.every((s) => s.key === row.key)}
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
