<script lang="ts">
	import type { AllowedTransition, Comment, ContextItem } from '@tines/shared';
	import { ApiError } from '@tines/shared';
	import IconArrowRight from '@tabler/icons-svelte/icons/arrow-right';
	import IconBan from '@tabler/icons-svelte/icons/ban';
	import IconChevronLeft from '@tabler/icons-svelte/icons/chevron-left';
	import IconCopy from '@tabler/icons-svelte/icons/copy';
	import IconPencil from '@tabler/icons-svelte/icons/pencil';
	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import IconRepeat from '@tabler/icons-svelte/icons/repeat';
	import IconRocket from '@tabler/icons-svelte/icons/rocket';
	import { fade, slide } from 'svelte/transition';
	import { invalidateAll } from '$app/navigation';
	import { api } from '$lib/api';
	import ContextItemEditor from '$lib/components/ContextItemEditor.svelte';
	import ContextItemList from '$lib/components/ContextItemList.svelte';
	import EffectiveContextView from '$lib/components/EffectiveContextView.svelte';
	import EventList from '$lib/components/EventList.svelte';
	import LaunchPromptDialog from '$lib/components/LaunchPromptDialog.svelte';
	import Markdown from '$lib/components/Markdown.svelte';
	import RelationsCard from '$lib/components/RelationsCard.svelte';
	import StateBadge from '$lib/components/StateBadge.svelte';
	import WorkflowGraph from '$lib/components/WorkflowGraph.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Select } from '$lib/components/ui/select/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { actorLabel, prefersReducedMotion, relativeTime } from '$lib/format';
	import { mergeLinks, type PendingAdd } from '$lib/link-overlay';

	let { data } = $props();

	const dur = () => (prefersReducedMotion() ? 0 : 180);

	// Local mirrors for optimistic updates; resynced whenever the server
	// data refreshes (invalidateAll after each successful mutation).
	// svelte-ignore state_referenced_locally
	let currentState = $state(data.issue.state);
	// svelte-ignore state_referenced_locally
	let comments = $state<(Comment & { pending?: boolean })[]>([...data.issue.comments]);
	$effect(() => {
		currentState = data.issue.state;
		comments = [...data.issue.comments];
	});

	// Links render as server truth + an overlay of in-flight operations —
	// never a blind local copy. A blind copy resynced on every reload wiped
	// pending adds (add #2 vanished when add #1's reload landed) and
	// resurrected pending removals (the server still had row #2 when remove
	// #1's reload landed). The overlay entries outlive other operations'
	// reloads; each is cleared only once its own reload has settled.
	let linkAdds = $state<PendingAdd[]>([]);
	let linkRemovals = $state<string[]>([]);
	const links = $derived(mergeLinks(data.issue.links, linkAdds, linkRemovals));

	let errorMessage = $state<string | null>(null);
	function showError(e: unknown) {
		errorMessage = e instanceof ApiError ? e.message : 'Something went wrong — try again.';
		setTimeout(() => (errorMessage = null), 6000);
	}

	// --- links ------------------------------------------------------------------

	const duplicateOf = $derived(links.duplicate_of);
	/**
	 * The badge shows the effective state: a duplicate's is its chain
	 * terminus's, so list and detail agree; otherwise it is the issue's own
	 * (optimistically updated) state.
	 */
	const headerState = $derived(duplicateOf ? data.issue.effective_state : currentState);
	const openBlockers = $derived(
		links.blocked_by.filter((l) => l.effective_state.category !== 'done')
	);

	let removingDuplicate = $state(false);
	async function removeDuplicate() {
		const prev = links.duplicate_of;
		if (!prev || removingDuplicate) return;
		// Optimistic via the overlay: the banner slides away and the badge
		// morphs back to this issue's own state — which never changed while
		// the link existed.
		linkRemovals = [...linkRemovals, prev.link_id];
		removingDuplicate = true;
		try {
			await api.removeIssueLink(data.issue.id, prev.link_id);
			await invalidateAll();
			linkAdds = linkAdds.filter((a) => a.entry.link_id !== prev.link_id);
		} catch (e) {
			showError(e);
		} finally {
			linkRemovals = linkRemovals.filter((id) => id !== prev.link_id);
			removingDuplicate = false;
		}
	}

	function scrollToRelations() {
		document
			.getElementById('relations')
			?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
	}

	// Allowed transitions follow the (possibly optimistic) current state.
	const allowed = $derived.by((): AllowedTransition[] => {
		const stateById = new Map(data.issue.workflow.states.map((s) => [s.id, s]));
		return data.issue.workflow.transitions
			.filter((t) => t.from_state_id === currentState.id)
			.flatMap((t) => {
				const toState = stateById.get(t.to_state_id);
				return toState ? [{ transition_id: t.id, name: t.name, to_state: toState }] : [];
			});
	});

	let transitioning = $state(false);
	async function move(transition: AllowedTransition) {
		if (transitioning) return;
		const prev = currentState;
		currentState = transition.to_state; // optimistic: badge + graph animate immediately
		transitioning = true;
		try {
			await api.transitionIssue(data.issue.id, { transition_id: transition.transition_id });
			await invalidateAll();
		} catch (e) {
			currentState = prev;
			showError(e);
		} finally {
			transitioning = false;
		}
	}

	// --- fallback: set any state, or move to another workflow -------------------

	let overrideWorkflowId = $state('');
	let overrideStateId = $state('');
	$effect(() => {
		overrideWorkflowId = data.issue.workflow.id;
	});
	const overrideWorkflow = $derived(
		data.workflows.find((w) => w.id === overrideWorkflowId) ?? data.issue.workflow
	);
	// Staying on the current workflow starts from the current state; a new
	// workflow starts from its initial state.
	$effect(() => {
		overrideStateId =
			overrideWorkflowId === data.issue.workflow.id
				? currentState.id
				: overrideWorkflow.initial_state_id;
	});

	const overrideDirty = $derived(
		overrideWorkflowId !== data.issue.workflow.id || overrideStateId !== currentState.id
	);
	let applyingOverride = $state(false);
	async function applyOverride(e: SubmitEvent) {
		e.preventDefault();
		if (applyingOverride || !overrideDirty) return;
		applyingOverride = true;
		try {
			await api.updateIssue(data.issue.id, {
				...(overrideWorkflowId !== data.issue.workflow.id
					? { workflow_id: overrideWorkflowId }
					: {}),
				state: overrideStateId
			});
			await invalidateAll();
		} catch (err) {
			showError(err);
		} finally {
			applyingOverride = false;
		}
	}

	// --- comments -------------------------------------------------------------

	let draft = $state('');
	let posting = $state(false);
	async function postComment(e: SubmitEvent) {
		e.preventDefault();
		const body = draft.trim();
		if (!body || posting) return;
		draft = '';
		posting = true;
		const temp: Comment & { pending: boolean } = {
			id: `pending-${Date.now()}`,
			issue_id: data.issue.id,
			body,
			actor: { user_id: '', user_name: data.user.name, api_key_id: null, api_key_name: null },
			created_at: Date.now(),
			pending: true
		};
		comments = [...comments, temp];
		try {
			const created = await api.createComment(data.issue.id, { body });
			comments = comments.map((c) => (c.id === temp.id ? created : c));
			await invalidateAll();
		} catch (err) {
			comments = comments.filter((c) => c.id !== temp.id);
			draft = body; // give the text back
			showError(err);
		} finally {
			posting = false;
		}
	}

	// --- title / description editing -------------------------------------------

	let editingTitle = $state(false);
	let titleDraft = $state('');
	async function saveTitle(e: SubmitEvent) {
		e.preventDefault();
		const title = titleDraft.trim();
		editingTitle = false;
		if (!title || title === data.issue.title) return;
		try {
			await api.updateIssue(data.issue.id, { title });
			await invalidateAll();
		} catch (err) {
			showError(err);
		}
	}

	// --- context ----------------------------------------------------------------

	let contextEditorOpen = $state(false);
	let editingContextItem = $state<ContextItem | null>(null);
	let promptDialogOpen = $state(false);

	function openContextCreate() {
		editingContextItem = null;
		contextEditorOpen = true;
	}
	function openContextEdit(item: ContextItem) {
		editingContextItem = item;
		contextEditorOpen = true;
	}

	const contextTotal = $derived(
		data.issue.context_summary.prompts +
			data.issue.context_summary.skills +
			data.issue.context_summary.repos
	);

	let editingDescription = $state(false);
	let descriptionDraft = $state('');
	let savingDescription = $state(false);
	async function saveDescription() {
		savingDescription = true;
		try {
			await api.updateIssue(data.issue.id, { description: descriptionDraft });
			await invalidateAll();
			editingDescription = false;
		} catch (err) {
			showError(err);
		} finally {
			savingDescription = false;
		}
	}
</script>

<svelte:head><title>{data.issue.project_name}/#{data.issue.number} · {data.issue.title} · Tines</title></svelte:head>

<div class="mb-6">
	<a
		href="/issues"
		class="text-muted-foreground hover:text-foreground mb-3 inline-flex items-center gap-1 text-sm"
	>
		<IconChevronLeft size={16} /> Issues
	</a>
	<div class="flex flex-wrap items-start justify-between gap-4">
		<div class="min-w-0">
			<p class="text-muted-foreground text-sm">
				<a href="/projects/{data.issue.project_id}" class="hover:underline">{data.issue.project_name}</a>
				<span class="font-mono">#{data.issue.number}</span>
				{#if data.issue.scheduled_task_id}
					<a
						href="/projects/{data.issue.project_id}?schedule={data.issue.scheduled_task_id}"
						class="bg-muted text-muted-foreground hover:text-foreground ml-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs align-middle"
						title="Created by schedule “{data.issue.scheduled_task_name}”"
					>
						<IconRepeat size={12} stroke={1.75} />
						{data.issue.scheduled_task_name}
					</a>
				{/if}
			</p>
			{#if editingTitle}
				<form onsubmit={saveTitle} class="mt-1 flex items-center gap-2">
					<Input bind:value={titleDraft} class="w-96 max-w-full text-lg font-semibold" autofocus />
					<Button type="submit" size="sm">Save</Button>
					<Button type="button" size="sm" variant="ghost" onclick={() => (editingTitle = false)}>Cancel</Button>
				</form>
			{:else}
				<h1 class="group mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
					<!-- The transition name sits on a text-hugging span (not the h1,
					     whose width includes the edit affordance) so the morph from
					     the list row scales cleanly. -->
					<span
						class="vt-shared min-w-0"
						style:view-transition-name="issue-title-{data.issue.id}"
						style:view-transition-class="vt-fit"
					>
						{data.issue.title}
					</span>
					<button
						class="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
						onclick={() => {
							titleDraft = data.issue.title;
							editingTitle = true;
						}}
						aria-label="Edit title"
					>
						<IconPencil size={16} />
					</button>
				</h1>
			{/if}
		</div>
		<div class="flex flex-wrap items-center justify-end gap-2">
			{#if duplicateOf}
				<span
					class="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
					title="Duplicate of {duplicateOf.project_name}/#{duplicateOf.number} — the badge shows its state ({headerState.name})"
					transition:fade={{ duration: dur() }}
				>
					<IconCopy size={12} stroke={1.75} />
					dup
				</span>
			{/if}
			<span
				class="vt-shared"
				style:view-transition-name="issue-state-{data.issue.id}"
				style:view-transition-class="vt-fit"
			>
				<StateBadge state={headerState} class="text-sm" />
			</span>
			{#if openBlockers.length > 0}
				<!-- Advisory, so no banner — a chip that jumps to the detail. -->
				<button
					type="button"
					class="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-700 dark:text-amber-400"
					title="Blocked by {openBlockers
						.map((b) => `${b.project_name}/${b.number} — ${b.title}`)
						.join('; ')}"
					onclick={scrollToRelations}
					transition:fade={{ duration: dur() }}
				>
					<IconBan size={14} stroke={1.75} />
					Blocked · {openBlockers.length}
				</button>
			{/if}
		</div>
	</div>
</div>

{#if duplicateOf}
	<div
		class="bg-muted/50 text-muted-foreground mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-4 py-2.5 text-sm"
		transition:slide={{ duration: dur() }}
	>
		<IconCopy size={16} stroke={1.75} class="shrink-0" />
		<p class="min-w-0">
			Duplicate of
			<a
				href="/issues/{encodeURIComponent(duplicateOf.project_name)}/{duplicateOf.number}"
				class="text-foreground font-medium hover:underline"
			>
				{duplicateOf.project_name}/#{duplicateOf.number}
			</a>
			— {duplicateOf.title}. This issue's state follows it.
		</p>
		<Button
			size="sm"
			variant="ghost"
			class="ml-auto"
			disabled={removingDuplicate}
			onclick={removeDuplicate}
		>
			Not a duplicate?
		</Button>
	</div>
{/if}

{#if errorMessage}
	<div
		class="border-destructive/40 bg-destructive/10 text-destructive mb-4 rounded-md border px-4 py-2.5 text-sm"
		transition:slide={{ duration: dur() }}
	>
		{errorMessage}
	</div>
{/if}

<ContextItemEditor
	bind:open={contextEditorOpen}
	item={editingContextItem}
	defaults={{ issue_id: data.issue.id }}
	projects={data.projects}
	workflows={data.workflows}
	onsaved={invalidateAll}
/>

<LaunchPromptDialog bind:open={promptDialogOpen} issueId={data.issue.id} />

<div class="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
	<div class="min-w-0 space-y-8">
		<!-- description -->
		<section class="rounded-lg border">
			<header class="flex items-center justify-between border-b px-4 py-2.5">
				<h2 class="text-sm font-semibold">Description</h2>
				{#if !editingDescription}
					<Button
						size="sm"
						variant="ghost"
						onclick={() => {
							descriptionDraft = data.issue.description;
							editingDescription = true;
						}}
					>
						<IconPencil size={14} /> Edit
					</Button>
				{/if}
			</header>
			<div class="p-4">
				{#if editingDescription}
					<div transition:slide={{ duration: dur() }}>
						<Textarea bind:value={descriptionDraft} rows={8} placeholder="Describe the work (Markdown)…" />
						<div class="mt-2 flex gap-2">
							<Button size="sm" onclick={saveDescription} disabled={savingDescription}>
								{savingDescription ? 'Saving…' : 'Save'}
							</Button>
							<Button size="sm" variant="ghost" onclick={() => (editingDescription = false)}>Cancel</Button>
						</div>
					</div>
				{:else if data.issue.description}
					<Markdown source={data.issue.description} />
				{:else}
					<p class="text-muted-foreground text-sm italic">No description.</p>
				{/if}
			</div>
		</section>

		<!-- context -->
		<section class="rounded-lg border">
			<header class="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
				<h2 class="text-sm font-semibold">
					Context
					{#if contextTotal > 0}
						<span class="text-muted-foreground font-normal">
							({data.issue.context_summary.prompts} prompt{data.issue.context_summary.prompts === 1 ? '' : 's'},
							{data.issue.context_summary.skills} skill{data.issue.context_summary.skills === 1 ? '' : 's'},
							{data.issue.context_summary.repos} repo{data.issue.context_summary.repos === 1 ? '' : 's'})
						</span>
					{/if}
				</h2>
				<div class="flex gap-2">
					<Button size="sm" variant="outline" onclick={() => (promptDialogOpen = true)}>
						<IconRocket size={14} /> View launch prompt
					</Button>
					<Button size="sm" variant="ghost" onclick={openContextCreate}>
						<IconPlus size={14} /> Add
					</Button>
				</div>
			</header>
			<div class="space-y-4 p-4">
				<div>
					<h3 class="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">
						This issue's context
					</h3>
					<ContextItemList
						items={data.contextItems}
						onselect={openContextEdit}
						emptyMessage="Nothing attached to this issue yet — add a note, skill, or repo."
					/>
				</div>
				<details class="group border-t pt-3">
					<summary class="text-muted-foreground hover:text-foreground cursor-pointer text-sm select-none">
						Effective context
						<span class="text-xs">
							— everything that applies while in
							<span class="font-medium">{currentState.name}</span> (changes as the issue transitions)
						</span>
					</summary>
					<div class="mt-3">
						<EffectiveContextView context={data.effectiveContext} />
					</div>
				</details>
			</div>
		</section>

		<!-- comments -->
		<section>
			<h2 class="mb-3 text-sm font-semibold">
				Comments <span class="text-muted-foreground font-normal">({comments.length})</span>
			</h2>
			<div class="space-y-3">
				{#each comments as comment (comment.id)}
					<article
						class="rounded-lg border {comment.pending ? 'opacity-60' : ''}"
						transition:slide={{ duration: dur() }}
					>
						<header class="text-muted-foreground flex items-center gap-2 border-b px-4 py-2 text-xs">
							<span class="text-foreground font-medium">{actorLabel(comment.actor)}</span>
							<span title={new Date(comment.created_at).toLocaleString()}>
								{comment.pending ? 'sending…' : relativeTime(comment.created_at)}
							</span>
						</header>
						<div class="p-4">
							<Markdown source={comment.body} />
						</div>
					</article>
				{/each}
			</div>
			<form onsubmit={postComment} class="mt-4">
				<Textarea bind:value={draft} rows={3} placeholder="Leave a comment (Markdown)…" />
				<div class="mt-2 flex justify-end">
					<Button type="submit" size="sm" disabled={!draft.trim() || posting}>Comment</Button>
				</div>
			</form>
		</section>
	</div>

	<aside class="space-y-8">
		<!-- state & transitions -->
		<!-- On a duplicate the section stops pretending to be the source of
		     truth (muted), but the graph and buttons still act on this issue's
		     own, dormant state — moving a duplicate is allowed. -->
		<section
			class="rounded-lg border p-4 transition-opacity duration-200 {duplicateOf
				? 'opacity-70'
				: ''}"
		>
			<h2 class="mb-3 text-sm font-semibold">State</h2>
			{#if duplicateOf}
				<p class="text-muted-foreground mb-3 text-xs italic" transition:slide={{ duration: dur() }}>
					This issue is a duplicate — its displayed state follows
					<a
						href="/issues/{encodeURIComponent(duplicateOf.project_name)}/{duplicateOf.number}"
						class="hover:underline">{duplicateOf.project_name}/#{duplicateOf.number}</a
					>.
				</p>
			{/if}
			<div class="mb-4">
				<WorkflowGraph workflow={data.issue.workflow} currentStateId={currentState.id} compact />
			</div>
			{#if allowed.length > 0}
				<div class="flex flex-wrap gap-2">
					{#each allowed as transition (transition.transition_id)}
						<Button
							size="sm"
							variant="outline"
							disabled={transitioning}
							onclick={() => move(transition)}
							title={`Move to ${transition.to_state.name}`}
						>
							{transition.name}
							<span class="text-muted-foreground inline-flex items-center gap-1 text-xs font-normal">
								<IconArrowRight size={12} />
								{transition.to_state.name}
							</span>
						</Button>
					{/each}
				</div>
			{:else}
				<p class="text-muted-foreground text-xs" transition:fade={{ duration: dur() }}>
					No outgoing transitions — this state is terminal.
				</p>
			{/if}
			<p class="text-muted-foreground mt-3 text-xs">
				Workflow:
				<a href="/workflows/{data.issue.workflow.id}" class="hover:underline">{data.issue.workflow.name}</a>
			</p>

			<!-- escape hatch: jump to any state, or move onto another workflow -->
			<details class="mt-4 border-t pt-3">
				<summary class="text-muted-foreground hover:text-foreground cursor-pointer text-xs select-none">
					Move directly…
				</summary>
				<form onsubmit={applyOverride} class="mt-3 space-y-3">
					<div class="space-y-1">
						<label class="text-muted-foreground text-xs font-medium" for="override-workflow">Workflow</label>
						<Select id="override-workflow" bind:value={overrideWorkflowId} class="h-8 text-xs">
							{#each data.workflows as workflow (workflow.id)}
								<option value={workflow.id}>
									{workflow.name}{workflow.is_system ? ' (standard)' : ''}
								</option>
							{/each}
						</Select>
					</div>
					<div class="space-y-1">
						<label class="text-muted-foreground text-xs font-medium" for="override-state">State</label>
						<Select id="override-state" bind:value={overrideStateId} class="h-8 text-xs">
							{#each overrideWorkflow.states as state (state.id)}
								<option value={state.id}>
									{state.name}{overrideWorkflowId === data.issue.workflow.id && state.id === currentState.id ? ' — current' : ''}
								</option>
							{/each}
						</Select>
					</div>
					<div class="flex items-center gap-2">
						<Button type="submit" size="sm" variant="outline" disabled={!overrideDirty || applyingOverride}>
							{applyingOverride ? 'Moving…' : 'Move'}
						</Button>
						<p class="text-muted-foreground text-xs">Bypasses the workflow's transitions.</p>
					</div>
				</form>
			</details>
		</section>

		<!-- dependencies & duplicates -->
		<RelationsCard
			issueId={data.issue.id}
			{links}
			bind:adds={linkAdds}
			bind:removals={linkRemovals}
			onerror={showError}
		/>

		<!-- this issue's slice of the activity log -->
		<section>
			<h2 class="mb-3 text-sm font-semibold">Activity</h2>
			<EventList events={data.events} showIssueLinks={false} emptyMessage="No activity yet." />
		</section>
	</aside>
</div>
