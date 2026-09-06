<script lang="ts">
	import type { ContextItem, UpdateWorkflowRequest } from '@tines/shared';
	import {
		activeStateIds as deriveActiveStateIds,
		ancestorsOf,
		ApiError,
		buildStateLibrary,
		childrenOf,
		qualifyState
	} from '@tines/shared';
	import IconBooks from '@tabler/icons-svelte/icons/books';
	import IconChevronLeft from '@tabler/icons-svelte/icons/chevron-left';
	import IconCopy from '@tabler/icons-svelte/icons/copy';
	import IconLock from '@tabler/icons-svelte/icons/lock';
	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import { slide } from 'svelte/transition';
	import { afterNavigate, goto, invalidateAll } from '$app/navigation';
	import { api } from '$lib/api';
	import AgentRoutingCard from '$lib/components/AgentRoutingCard.svelte';
	import ContextItemEditor from '$lib/components/ContextItemEditor.svelte';
	import ContextItemList from '$lib/components/ContextItemList.svelte';
	import { confirmDialog } from '$lib/components/dialogs.svelte';
	import StateBadge from '$lib/components/StateBadge.svelte';
	import WorkflowEditor from '$lib/components/WorkflowEditor.svelte';
	import WorkflowGraph from '$lib/components/WorkflowGraph.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { prefersReducedMotion } from '$lib/format';

	let { data } = $props();

	/** Active-category states, so dead routing rules are flagged as such. */
	const activeStateIds = $derived(deriveActiveStateIds(data.workflows));

	/**
	 * The whole visible library: a state's base — and the states inheriting
	 * from one of ours — may live in another workflow, so naming either takes
	 * more than `data.workflow`.
	 */
	const lib = $derived(buildStateLibrary(data.workflows));
	/** Where a state's `inherits from` / `via` links point, library-wide. */
	const stateHref = (id: string) => {
		const entry = lib.states.get(id);
		return entry ? `/workflows/${entry.workflow.id}#state-${id}` : '#';
	};

	let errorMessage = $state<string | null>(null);
	function showError(e: unknown) {
		errorMessage = e instanceof ApiError ? e.message : 'Something went wrong — try again.';
		setTimeout(() => (errorMessage = null), 6000);
	}

	// --- context -----------------------------------------------------------------

	const itemsByState = $derived.by(() => {
		const map = new Map<string, ContextItem[]>();
		for (const item of data.contextItems) {
			const key = item.scope.workflow_state_id!;
			map.set(key, [...(map.get(key) ?? []), item]);
		}
		return map;
	});

	let selectedStateId = $state<string | null>(null);

	/**
	 * `#state-<id>` — the deep link every inheritance line uses — opens that
	 * row and scrolls to it. In `afterNavigate` rather than an `$effect` so it
	 * runs once per navigation (the initial load included) instead of
	 * re-asserting itself over the reader's own clicks.
	 */
	afterNavigate(({ to }) => {
		const id = to?.url.hash?.replace(/^#state-/, '');
		if (!id || id === to?.url.hash) return;
		selectedStateId = id;
		requestAnimationFrame(() =>
			document.getElementById(`state-${id}`)?.scrollIntoView({ block: 'center' })
		);
	});
	let contextEditorOpen = $state(false);
	let editingContextItem = $state<ContextItem | null>(null);

	function openContextCreate(stateId: string) {
		selectedStateId = stateId;
		editingContextItem = null;
		contextEditorOpen = true;
	}
	function openContextEdit(item: ContextItem) {
		editingContextItem = item;
		contextEditorOpen = true;
	}

	/**
	 * When a save (state removal) or delete is blocked by attached context,
	 * list what a forced delete would sweep and ask before retrying.
	 */
	async function confirmContextSweep(err: unknown): Promise<boolean> {
		if (!(err instanceof ApiError) || err.code !== 'context_attached') return false;
		const items = (err.details?.context_items ?? []) as {
			kind: string;
			name: string;
			scope_label: string;
		}[];
		return confirmDialog({
			title: 'Delete attached context too?',
			body: `This also deletes ${items.length} attached context item${items.length === 1 ? '' : 's'}:`,
			items: items.map((i) => `${i.kind} “${i.name}” (${i.scope_label})`),
			confirmLabel: 'Delete them',
			destructive: true
		});
	}

	/**
	 * When removing a state (or a whole workflow) would orphan states that
	 * inherit context from it, name them and ask before clearing their
	 * pointers — the same consent `force_delete_context` asks for the items.
	 */
	async function confirmInheritanceClear(err: unknown): Promise<boolean> {
		if (!(err instanceof ApiError)) return false;
		if (err.code !== 'state_inherited' && err.code !== 'workflow_inherited') return false;
		const bases = (err.details?.states ?? []) as {
			state_name: string;
			workflow_name?: string;
			children?: { state_name: string; workflow_name: string }[];
		}[];
		// `state_inherited` nests children under each removed base;
		// `workflow_inherited` lists the inheriting states flat.
		const items = bases.flatMap((base) =>
			base.children
				? base.children.map(
						(c) => `“${c.workflow_name} / ${c.state_name}” (inherits from “${base.state_name}”)`
					)
				: [`“${base.workflow_name} / ${base.state_name}”`]
		);
		return confirmDialog({
			title: 'Clear inheritance pointers too?',
			body: `${items.length} state${items.length === 1 ? '' : 's'} in other workflows inherit context from what you are removing. Clearing their pointers changes the context their issues receive.`,
			items,
			confirmLabel: 'Clear and continue',
			destructive: true
		});
	}

	interface ForceFlags {
		force_delete_context?: true;
		force_clear_inheritance?: true;
	}

	/**
	 * Run `attempt`, and on each refusal that a force flag can answer, ask and
	 * retry with that flag added. Both guards can fire on one save, so the
	 * loop runs until the call succeeds or refuses something we cannot ask for.
	 */
	async function withForceRetries<T>(attempt: (flags: ForceFlags) => Promise<T>): Promise<T> {
		const flags: ForceFlags = {};
		for (;;) {
			try {
				return await attempt(flags);
			} catch (err) {
				if (!flags.force_delete_context && (await confirmContextSweep(err))) {
					flags.force_delete_context = true;
				} else if (!flags.force_clear_inheritance && (await confirmInheritanceClear(err))) {
					flags.force_clear_inheritance = true;
				} else {
					// Declined, or a refusal no flag answers: the caller's banner
					// shows the API's own message.
					throw err;
				}
			}
		}
	}

	async function saveWorkflow(request: UpdateWorkflowRequest) {
		await withForceRetries((flags) =>
			api.updateWorkflow(data.workflow.id, { ...request, ...flags })
		);
		await invalidateAll();
	}

	/** Duplicate the workflow into the user's library (states by name). */
	async function copyToLibrary() {
		const wf = data.workflow;
		const nameOf = (id: string) => wf.states.find((s) => s.id === id)?.name ?? id;
		try {
			const copy = await api.createWorkflow({
				name: `${wf.name} (copy)`,
				description: wf.description,
				initial_state: nameOf(wf.initial_state_id),
				// Inheritance pointers come along: a copy that silently resolved a
				// different context would not be a copy. Pointers inside this
				// workflow remap by name (the API resolves a ref against the
				// request's own states first); pointers at another workflow's
				// state copy verbatim.
				states: wf.states.map((s) => ({
					name: s.name,
					category: s.category,
					...(s.inherits_from
						? {
								inherits_from: wf.states.some((o) => o.id === s.inherits_from)
									? nameOf(s.inherits_from)
									: s.inherits_from
							}
						: {})
				})),
				transitions: wf.transitions.map((t) => ({
					name: t.name,
					from: nameOf(t.from_state_id),
					to: nameOf(t.to_state_id)
				}))
			});
			await invalidateAll();
			await goto(`/workflows/${copy.id}`);
		} catch (err) {
			showError(err);
		}
	}

	async function deleteWorkflow() {
		const ok = await confirmDialog({
			title: `Delete workflow "${data.workflow.name}"?`,
			confirmLabel: 'Delete workflow',
			destructive: true
		});
		if (!ok) return;
		try {
			await withForceRetries((flags) => api.deleteWorkflow(data.workflow.id, flags));
			await goto('/workflows');
			await invalidateAll();
		} catch (err) {
			showError(err);
		}
	}
</script>

<svelte:head><title>{data.workflow.name} · Workflows · Tines</title></svelte:head>

<a
	href="/workflows"
	class="text-muted-foreground hover:text-foreground mb-3 inline-flex items-center gap-1 text-sm"
>
	<IconChevronLeft size={16} /> Workflows
</a>

<div class="mb-6 flex flex-wrap items-start justify-between gap-4">
	<div class="min-w-0">
		<h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
			{data.workflow.name}
			{#if data.workflow.is_system}
				<span
					class="text-muted-foreground bg-muted inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium"
				>
					<IconLock size={12} /> standard · read-only
				</span>
			{/if}
		</h1>
		<!-- The editable page repeats the description in its Description field, so
		     the header only carries it where that form is absent. -->
		{#if data.workflow.is_system && data.workflow.description}
			<p class="text-muted-foreground mt-1 max-w-xl text-sm">{data.workflow.description}</p>
		{/if}
		<p class="text-muted-foreground mt-1 text-xs">
			{data.workflow.issue_count} issue{data.workflow.issue_count === 1 ? ' uses' : 's use'} this workflow
		</p>
	</div>
	{#if data.workflow.is_system}
		<div class="flex gap-2">
			<Button variant="outline" onclick={copyToLibrary}>
				<IconCopy size={16} /> Copy to library
			</Button>
		</div>
	{/if}
</div>

{#if errorMessage}
	<div
		class="border-destructive/40 bg-destructive/10 text-destructive mb-4 rounded-md border px-4 py-2.5 text-sm"
		transition:slide={{ duration: prefersReducedMotion() ? 0 : 180 }}
	>
		{errorMessage}
	</div>
{/if}

{#if data.workflow.is_system}
	<!-- read-only: graph plus a plain state table -->
	<div class="grid gap-8 lg:grid-cols-2">
		<div class="bg-muted/30 rounded-lg border p-4">
			<WorkflowGraph workflow={data.workflow} />
		</div>
		<div class="rounded-lg border">
			<table class="w-full text-sm">
				<thead>
					<tr class="text-muted-foreground border-b text-left text-xs">
						<th class="px-4 py-2.5 font-medium">State</th>
						<th class="px-4 py-2.5 font-medium">Category</th>
						<th class="px-4 py-2.5 font-medium"></th>
					</tr>
				</thead>
				<tbody>
					{#each data.workflow.states as st (st.id)}
						<tr class="border-b last:border-0">
							<td class="px-4 py-2.5"><StateBadge state={st} /></td>
							<td class="text-muted-foreground px-4 py-2.5">{st.category}</td>
							<td class="text-muted-foreground px-4 py-2.5 text-xs">
								{st.id === data.workflow.initial_state_id ? 'initial state' : ''}
								<!-- The standard workflow can only ever be a base, so the spare
								     column carries the states inheriting from it. -->
								{#if childrenOf(lib, st.id).length > 0}
									<span class="block"
										>inherited by {childrenOf(lib, st.id)
											.map((k) => `${k.workflow.name} / ${k.state.name}`)
											.join(', ')}</span
									>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
{:else}
	{#key data.workflow.updated_at}
		<WorkflowEditor
			workflow={data.workflow}
			workflows={data.workflows}
			baseItems={data.contextItems}
			onsave={saveWorkflow}
		>
			<!-- Delete sits with Save rather than in the header, so the page opens on
			     the form and no destructive action shares the title row. -->
			{#snippet footerActions()}
				<Button
					type="button"
					variant="outline"
					class="text-destructive"
					disabled={data.workflow.issue_count > 0}
					title={data.workflow.issue_count > 0
						? 'Workflows with issues cannot be deleted'
						: undefined}
					onclick={deleteWorkflow}
				>
					Delete
				</Button>
			{/snippet}
		</WorkflowEditor>
	{/key}
{/if}

<!-- per-state context: what agents carry while an issue sits in each state -->
<div class="mt-8">
	<h2 class="mb-1 flex items-center gap-1.5 text-sm font-semibold">
		<IconBooks size={16} stroke={1.75} /> Context by state
	</h2>
	<p class="text-muted-foreground mb-3 text-xs">
		Items scoped to a state apply to any issue sitting in it. Removing a state warns about its
		attached context.
	</p>
	<div class="rounded-lg border">
		{#each data.workflow.states as state (state.id)}
			{@const items = itemsByState.get(state.id) ?? []}
			{@const open = selectedStateId === state.id}
			{@const kids = childrenOf(lib, state.id)}
			<div class="border-b last:border-0" id="state-{state.id}">
				<button
					type="button"
					class="hover:bg-muted/50 flex w-full flex-wrap items-center gap-2 px-3 py-2.5 text-left text-sm"
					onclick={() => (selectedStateId = open ? null : state.id)}
					aria-expanded={open}
				>
					<StateBadge {state} />
					{#if items.length > 0}
						<span class="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-xs font-medium">
							{items.length} item{items.length === 1 ? '' : 's'}
						</span>
					{:else}
						<span class="text-muted-foreground text-xs">no context</span>
					{/if}
					{#if state.inherits_from}
						<span class="text-muted-foreground text-xs"
							>inherits from {qualifyState(lib, state.inherits_from)}</span
						>
					{/if}
					{#if kids.length > 0}
						<span class="text-muted-foreground text-xs"
							>inherited by {kids
								.map((k) => `${k.workflow.name} / ${k.state.name}`)
								.join(', ')}</span
						>
					{/if}
				</button>
				{#if open}
					<div
						class="space-y-2 px-3 pb-3"
						transition:slide={{ duration: prefersReducedMotion() ? 0 : 180 }}
					>
						<ContextItemList
							{items}
							shortScope
							onselect={openContextEdit}
							emptyMessage="Nothing scoped to this state yet."
						/>
						<Button size="sm" variant="ghost" onclick={() => openContextCreate(state.id)}>
							<IconPlus size={14} /> Add context for this state
						</Button>
						<!-- The base's own layers, root last: read-only here, because
						     they belong to the base's state, and every row carries the
						     `via` chip saying so. -->
						{#each ancestorsOf(lib, state.id).slice().reverse() as ancestorId (ancestorId)}
							{@const entry = lib.states.get(ancestorId)}
							{#if entry}
								<div class="border-t pt-2">
									<h4 class="text-muted-foreground mb-1.5 text-xs">
										Inherited from
										<a
											class="hover:text-foreground underline underline-offset-2"
											href={stateHref(ancestorId)}>{qualifyState(lib, ancestorId)}</a
										>
									</h4>
									<ContextItemList
										items={itemsByState.get(ancestorId) ?? []}
										shortScope
										inheritedFrom={{
											state_id: entry.state.id,
											state_name: entry.state.name,
											workflow_id: entry.workflow.id,
											workflow_name: entry.workflow.name
										}}
										emptyMessage="No context on the base yet."
									/>
								</div>
							{/if}
						{/each}
					</div>
				{/if}
			</div>
		{/each}
	</div>
</div>

<div class="mt-8">
	<AgentRoutingCard
		rules={data.routingRules}
		{activeStateIds}
		emptyMessage="No routing rules are scoped to this workflow's states — project and global rules still apply."
	/>
</div>

<ContextItemEditor
	bind:open={contextEditorOpen}
	item={editingContextItem}
	defaults={selectedStateId ? { workflow_state_id: selectedStateId } : {}}
	projects={data.projects}
	workflows={data.workflows}
	onsaved={invalidateAll}
/>

{#each data.workflow.warnings ?? [] as warning (warning)}
	<p
		class="mt-6 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
	>
		{warning}
	</p>
{/each}
