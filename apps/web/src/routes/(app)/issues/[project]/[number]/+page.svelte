<script lang="ts">
	import type { AllowedTransition, Comment, ContextItem, WorkflowState } from '@tines/shared';
	import { ApiError } from '@tines/shared';
	import IconAlertTriangle from '@tabler/icons-svelte/icons/alert-triangle';
	import IconArrowRight from '@tabler/icons-svelte/icons/arrow-right';
	import IconBan from '@tabler/icons-svelte/icons/ban';
	import IconCheck from '@tabler/icons-svelte/icons/check';
	import IconChevronLeft from '@tabler/icons-svelte/icons/chevron-left';
	import IconCopy from '@tabler/icons-svelte/icons/copy';
	import IconPencil from '@tabler/icons-svelte/icons/pencil';
	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import IconTrash from '@tabler/icons-svelte/icons/trash';
	import IconRepeat from '@tabler/icons-svelte/icons/repeat';
	import IconRocket from '@tabler/icons-svelte/icons/rocket';
	import { untrack } from 'svelte';
	import { flip } from 'svelte/animate';
	import { fade, slide } from 'svelte/transition';
	import { invalidate } from '$app/navigation';
	import { api } from '$lib/api';
	import AgentActivityCard from '$lib/components/AgentActivityCard.svelte';
	import ArtifactsPanel from '$lib/components/ArtifactsPanel.svelte';
	import ContextItemEditor from '$lib/components/ContextItemEditor.svelte';
	import { confirmDialog } from '$lib/components/dialogs.svelte';
	import ContextItemList from '$lib/components/ContextItemList.svelte';
	import EffectiveContextView from '$lib/components/EffectiveContextView.svelte';
	import EventList from '$lib/components/EventList.svelte';
	import LaunchPromptDialog from '$lib/components/LaunchPromptDialog.svelte';
	import Markdown from '$lib/components/Markdown.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import PendingButton from '$lib/components/PendingButton.svelte';
	import RelationsCard from '$lib/components/RelationsCard.svelte';
	import StateBadge from '$lib/components/StateBadge.svelte';
	import WorkflowGraph from '$lib/components/WorkflowGraph.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Select } from '$lib/components/ui/select/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { actorLabel, prefersReducedMotion, relativeTime } from '$lib/format';
	import { mergeLinks, type PendingAdd } from '$lib/link-overlay';
	import { navMemory } from '$lib/nav-memory.svelte';

	let { data } = $props();

	// Back to the list you came from, as you left it — the issues list with its
	// filters, or the project page. A deep link or a fresh tab has no memory and
	// falls back to the plain issues list.
	const backList = $derived(navMemory.lastList ?? { href: '/issues', label: 'Issues' });

	// Mutations and the live poll refresh THIS page's load only (it declares
	// depends('app:issue')), not the whole load graph: a full invalidate would
	// also re-run the (app) layout and every other load for no reason.
	const refresh = () => invalidate('app:issue');

	// --- streamed panels ---------------------------------------------------------
	// Every refresh — each mutation, and every poll tick that spots someone
	// else's event — replaces data.deferred with FRESH pending promises.
	// Rendering them with {#await} would collapse the panels back to skeletons
	// on each resync, so each panel instead tracks the latest value across
	// promise replacements: pending only before the first value ever arrives,
	// the previous value kept on screen while a newer promise is in flight, and
	// a rejection surfacing as an error only when there is no value to keep
	// (afterwards the stale value stands and the next poll tick retries).
	// The kept value belongs to ONE issue: this component is reused when
	// navigating between issues, so a key change resets the panel to pending
	// rather than showing the previous issue's data.
	type PanelState<T> =
		{ status: 'pending' } | { status: 'loaded'; value: T } | { status: 'failed' };
	function streamed<T>(promise: () => Promise<T>, key: () => unknown) {
		let current = $state<PanelState<T>>({ status: 'pending' });
		let lastKey: unknown;
		$effect(() => {
			// Reading the promise here makes the effect re-run when a refresh
			// swaps data.deferred; the flag parks the superseded promise so an
			// out-of-order settlement can't overwrite a newer one.
			const k = key();
			if (k !== lastKey) {
				lastKey = k;
				current = { status: 'pending' };
			}
			let superseded = false;
			promise().then(
				(value) => {
					if (!superseded) current = { status: 'loaded', value };
				},
				() => {
					if (!superseded && current.status !== 'loaded') current = { status: 'failed' };
				}
			);
			return () => {
				superseded = true;
			};
		});
		return {
			get current() {
				return current;
			}
		};
	}

	const issueKey = () => data.issue.id;
	const contextItemsPanel = streamed(() => data.deferred.contextItems, issueKey);
	const effectiveContextPanel = streamed(() => data.deferred.effectiveContext, issueKey);
	const agentActivityPanel = streamed(
		() => Promise.all([data.deferred.dispatch, data.deferred.issueRuns, data.deferred.runners]),
		issueKey
	);

	const dur = () => (prefersReducedMotion() ? 0 : 180);

	// Everything optimistic on this page renders as server truth + an overlay
	// of in-flight work, never a blind local copy resynced by effect. With the
	// live-updates poll below, a refresh can land at ANY moment — not
	// just at the quiet point after the viewer's own mutation — and a blind
	// copy would snap back to stale data mid-mutation. Each overlay entry is
	// cleared only once its own mutation's reload has settled (or it failed).

	// The state badge/graph/buttons follow the in-flight transition, if any.
	let pendingState = $state<WorkflowState | null>(null);
	const currentState = $derived(pendingState ?? data.issue.state);

	// Comments: server list + in-flight posts. A confirmed overlay entry is
	// hidden as soon as any reload delivers the server copy, so a poll resync
	// racing the post's own refresh can't duplicate it.
	let pendingComments = $state<(Comment & { pending?: boolean })[]>([]);
	const comments = $derived.by((): (Comment & { pending?: boolean })[] => {
		const confirmed = new Set(data.issue.comments.map((c) => c.id));
		return [...data.issue.comments, ...pendingComments.filter((c) => !confirmed.has(c.id))];
	});

	const latestEventId = $derived(data.events[0]?.id ?? null);

	// --- live updates ------------------------------------------------------------
	// Other agents/users can post comments, transition, or edit this issue while
	// it's open here. Every mutation path below already calls refresh() to
	// fully resync; polling the events feed just supplies the missing trigger for
	// when someone *else* changes something.
	// Plain (non-reactive) guard, set before the fetch so an overlapping tick
	// (slow request + interval, or interval + refocus) can't double-resync.
	let syncing = false;
	async function checkForUpdates() {
		if (syncing) return;
		syncing = true;
		try {
			const latest = await api.listEvents({ issue: data.issue.id, limit: 1 });
			const newestId = latest.items[0]?.id ?? null;
			if (newestId !== latestEventId) await refresh();
		} catch {
			// Silent — a missed poll tick just waits for the next one, or the
			// visibility-change backstop below.
		} finally {
			syncing = false;
		}
	}
	$effect(() => {
		function tick() {
			if (document.visibilityState === 'visible') void checkForUpdates();
		}
		// untrack: checkForUpdates reads reactive state synchronously
		// (data.issue.id); tracked, every resync would tear down and rebuild
		// the interval and immediately re-fetch the feed it just loaded.
		untrack(tick); // catch up immediately, including right after a backgrounded tab refocuses
		const timer = setInterval(tick, 5000);
		document.addEventListener('visibilitychange', tick);
		return () => {
			clearInterval(timer);
			document.removeEventListener('visibilitychange', tick);
		};
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
			await refresh();
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
		// Live artifact-requirement statuses come from the server read; they
		// only describe the server's current state, never an optimistic overlay.
		const serverById = new Map(data.issue.allowed_transitions.map((t) => [t.transition_id, t]));
		return data.issue.workflow.transitions
			.filter((t) => t.from_state_id === currentState.id)
			.flatMap((t) => {
				const toState = stateById.get(t.to_state_id);
				if (!toState) return [];
				const requires =
					currentState.id === data.issue.state.id ? serverById.get(t.id)?.requires : undefined;
				return [
					{
						transition_id: t.id,
						name: t.name,
						to_state: toState,
						...(requires ? { requires } : {})
					}
				];
			});
	});

	const unmetFor = (transition: AllowedTransition) =>
		(transition.requires ?? []).filter((r) => r.status !== 'satisfied');

	// The action you came to take goes first: enabled transitions above blocked
	// ones, workflow order kept inside each group. `requires` is undefined while
	// an optimistic move is in flight, so everything counts as enabled then —
	// the split is stable, so nothing reshuffles mid-animation.
	const ordered = $derived([
		...allowed.filter((t) => unmetFor(t).length === 0),
		...allowed.filter((t) => unmetFor(t).length > 0)
	]);

	// The transition dialog: an optional comment posted atomically with the
	// move — comment first, so a sub-second dispatch triggered by the
	// transition already reads it in the launch prompt (SPEC.md "Transition
	// dialogs prompt for an optional comment").
	let pendingTransition = $state<AllowedTransition | null>(null);
	let transitionComment = $state('');
	let transitioning = $state(false);

	function requestMove(transition: AllowedTransition) {
		transitionComment = '';
		pendingTransition = transition;
	}

	async function move(transition: AllowedTransition, comment: string) {
		if (transitioning) return;
		transitioning = true;
		try {
			// Comment BEFORE the transition: re-dispatch can never race past it.
			if (comment) await api.createComment(data.issue.id, { body: comment });
			await api.transitionIssue(data.issue.id, { transition_id: transition.transition_id });
			// Optimistic, but only once the server has accepted: the badge and graph
			// animate ahead of the reload, while the State card behind the dialog is
			// never mutated with the request still in flight (Tines/153).
			pendingState = transition.to_state;
			pendingTransition = null;
			await refresh();
		} catch (e) {
			showError(e);
		} finally {
			// Success: the reload has settled, so server truth already carries
			// the new state. Failure: dropping the overlay is the revert.
			pendingState = null;
			transitioning = false;
		}
	}

	// --- fallback: set any state, or move to another workflow -------------------

	// The form's values are the user's explicit picks overlaid on derived
	// defaults — never effect-reset from `data`, which would wipe a
	// half-filled form whenever the background poll resyncs. A pick that no
	// longer resolves (its workflow/state vanished in a resync) falls back to
	// the default rather than pointing the form at nothing.
	let overrideWorkflowPick = $state<string | null>(null);
	let overrideStatePick = $state<string | null>(null);
	const overrideWorkflowId = $derived(
		overrideWorkflowPick && data.workflows.some((w) => w.id === overrideWorkflowPick)
			? overrideWorkflowPick
			: data.issue.workflow.id
	);
	const overrideWorkflow = $derived(
		data.workflows.find((w) => w.id === overrideWorkflowId) ?? data.issue.workflow
	);
	// Staying on the current workflow starts from the current state; a new
	// workflow starts from its initial state.
	const overrideStateId = $derived(
		overrideStatePick && overrideWorkflow.states.some((s) => s.id === overrideStatePick)
			? overrideStatePick
			: overrideWorkflowId === data.issue.workflow.id
				? currentState.id
				: overrideWorkflow.initial_state_id
	);

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
			await refresh();
			// Applied and reloaded — the defaults now describe the new
			// position, so the picks have served their purpose.
			overrideWorkflowPick = null;
			overrideStatePick = null;
		} catch (err) {
			showError(err);
		} finally {
			applyingOverride = false;
		}
	}

	// --- parked / resume --------------------------------------------------------

	let resuming = $state(false);
	async function resume() {
		if (resuming) return;
		resuming = true;
		try {
			await api.resumeIssue(data.issue.id);
			await refresh();
		} catch (e) {
			showError(e);
		} finally {
			resuming = false;
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
			updated_at: null,
			pending: true
		};
		pendingComments = [...pendingComments, temp];
		try {
			const created = await api.createComment(data.issue.id, { body });
			// Swap in the confirmed comment under its real id; the overlay's
			// dedupe hides it the moment any reload delivers the server copy.
			pendingComments = pendingComments.map((c) => (c.id === temp.id ? created : c));
			await refresh();
			pendingComments = pendingComments.filter((c) => c.id !== created.id);
		} catch (err) {
			pendingComments = pendingComments.filter((c) => c.id !== temp.id);
			draft = body; // give the text back
			showError(err);
		} finally {
			posting = false;
		}
	}

	// Edit/delete are offered on every comment: the signed-in viewer owns this
	// workspace, and the motivating case is a human cleaning up an agent's
	// mis-post. (Run keys are the narrow ones — the server only lets them touch
	// their own comments.)
	let editingCommentId = $state<string | null>(null);
	let commentDraft = $state('');
	// Per-comment, not page-global: a save on one comment must not disable the
	// buttons on every other one.
	let busyCommentId = $state<string | null>(null);

	function startEditComment(comment: Comment) {
		editingCommentId = comment.id;
		commentDraft = comment.body;
	}

	async function saveComment(comment: Comment) {
		const body = commentDraft.trim();
		if (!body || busyCommentId === comment.id) return;
		busyCommentId = comment.id;
		try {
			await api.updateComment(data.issue.id, comment.id, { body });
			editingCommentId = null;
			await refresh();
		} catch (err) {
			showError(err);
		} finally {
			busyCommentId = null;
		}
	}

	async function deleteComment(comment: Comment) {
		if (busyCommentId === comment.id) return;
		const ok = await confirmDialog({
			title: 'Delete this comment?',
			body: 'The comment is removed from the thread; the activity feed keeps a record that it was deleted.',
			confirmLabel: 'Delete comment',
			destructive: true
		});
		if (!ok || busyCommentId === comment.id) return;
		busyCommentId = comment.id;
		try {
			await api.deleteComment(data.issue.id, comment.id);
			if (editingCommentId === comment.id) editingCommentId = null;
			await refresh();
		} catch (err) {
			showError(err);
		} finally {
			busyCommentId = null;
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
			await refresh();
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
			await refresh();
			editingDescription = false;
		} catch (err) {
			showError(err);
		} finally {
			savingDescription = false;
		}
	}
</script>

<svelte:head
	><title>{data.issue.project_name}/#{data.issue.number} · {data.issue.title} · Tines</title
	></svelte:head
>

<!--
	A streamed panel that never arrived. The panels below the fold are sent as
	promises so the page can paint (and the View Transition commit) on the first
	D1 wave; a rejection here is a failed panel, not a failed page.
-->
{#snippet loadFailed(what: string)}
	<div class="text-muted-foreground flex items-center gap-2 py-2 text-sm">
		<IconAlertTriangle size={16} class="text-destructive" />
		<span>Couldn't load {what}.</span>
		<Button size="sm" variant="ghost" onclick={refresh}>Retry</Button>
	</div>
{/snippet}

<div class="mb-6">
	<a
		href={backList.href}
		class="text-muted-foreground hover:text-foreground mb-3 inline-flex max-w-full min-w-0 items-center gap-1 text-sm"
	>
		<IconChevronLeft size={16} class="shrink-0" />
		<span class="truncate">{backList.label}</span>
	</a>
	<div class="flex flex-wrap items-start justify-between gap-4">
		<div class="min-w-0">
			<p class="text-muted-foreground text-sm">
				<a href="/projects/{data.issue.project_id}" class="hover:underline"
					>{data.issue.project_name}</a
				>
				<span class="font-mono">#{data.issue.number}</span>
				{#if data.issue.scheduled_task_id}
					<a
						href="/projects/{data.issue.project_id}?schedule={data.issue.scheduled_task_id}"
						class="bg-muted text-muted-foreground hover:text-foreground ml-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 align-middle text-xs"
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
					<Button type="button" size="sm" variant="ghost" onclick={() => (editingTitle = false)}
						>Cancel</Button
					>
				</form>
			{:else}
				<!-- wrap-anywhere: a title is arbitrary user text, and one unbroken
				     token (a pasted URL is enough) otherwise sets the document width
				     and drags every card on the page wider than the viewport. -->
				<h1
					class="group mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight wrap-anywhere"
				>
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
		<p class="min-w-0 wrap-anywhere">
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

{#if data.issue.needs_attention}
	<!-- parked banner: above the fold, cleared by Resume or any manual move -->
	<div
		class="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-800 dark:text-amber-300"
		transition:slide={{ duration: dur() }}
	>
		<span class="flex items-center gap-2">
			<IconAlertTriangle size={16} stroke={1.75} class="shrink-0" />
			Agents struck out {data.issue.attempt_count}
			time{data.issue.attempt_count === 1 ? '' : 's'} here — the last run ended without moving the issue.
			It won't be dispatched again until you act.
		</span>
		<Button size="sm" disabled={resuming} onclick={resume}>
			{resuming ? 'Resuming…' : 'Resume'}
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
	onsaved={refresh}
/>

<LaunchPromptDialog bind:open={promptDialogOpen} issueId={data.issue.id} />

<!-- `lg:grid-rows-[auto_1fr]`: the State card is its own grid item in row 1
     while main spans both rows, so with default auto rows grid distributes
     main's height across them and stretches the card's border to fill row 1
     (~1000px of empty box on a long issue). Row 1 sized to content, row 2
     absorbing the rest, keeps the card exactly as tall as it was inside the
     aside. -->
<div class="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:grid-rows-[auto_1fr]">
	<!-- state & transitions — first in DOM so a phone gets it before the
	     description; pinned to the right column on desktop, where the aside
	     picks up below it. -->
	<!-- On a duplicate the section stops pretending to be the source of
	     truth (muted), but the graph and buttons still act on this issue's
	     own, dormant state — moving a duplicate is allowed. -->
	<section
		class="min-w-0 rounded-lg border p-4 transition-opacity duration-200 lg:col-start-2 lg:row-start-1 {duplicateOf
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
		{#if ordered.length > 0}
			<div class="flex flex-col gap-2">
				{#each ordered as transition (transition.transition_id)}
					{@const unmet = unmetFor(transition)}
					{@const reqId = `transition-req-${transition.transition_id}`}
					<div class="min-w-0" animate:flip={{ duration: dur() }}>
						<!-- Reason lines are SIBLINGS of the button, never children: the
						     button's accessible name stays "<name> → <state>". -->
						<Button
							size="sm"
							variant="outline"
							class="w-full justify-between"
							disabled={transitioning || unmet.length > 0}
							aria-describedby={transition.requires?.length ? reqId : undefined}
							onclick={() => requestMove(transition)}
							title={transition.name}
						>
							<span class="min-w-0 truncate text-left">{transition.name}</span>
							<span
								class="text-muted-foreground inline-flex shrink-0 items-center gap-1 text-xs font-normal"
							>
								<IconArrowRight size={12} />
								{transition.to_state.name}
							</span>
						</Button>
						{#if transition.requires?.length}
							<ul id={reqId} class="mt-1 space-y-1 px-1">
								{#each transition.requires as r (r.artifact)}
									<li
										class="flex items-start gap-1.5 text-xs {r.status === 'satisfied'
											? 'text-muted-foreground'
											: 'text-amber-700 dark:text-amber-400'}"
									>
										{#if r.status === 'satisfied'}
											<IconCheck size={13} class="mt-0.5 shrink-0" />
											<span class="min-w-0">
												<span class="font-mono">{r.artifact}</span> is fresh (v{r.current_version
													?.version}).
											</span>
										{:else}
											<IconBan size={13} class="mt-0.5 shrink-0" />
											<span class="min-w-0">
												{#if r.status === 'missing'}
													Needs artifact <span class="font-mono">{r.artifact}</span> — attach it in
													<a href="#artifacts" class="underline">Artifacts</a>.
												{:else if r.status === 'stale'}
													<span class="font-mono">{r.artifact}</span> is stale — this state began
													{relativeTime(data.issue.state_entered_at)}; attach a new version or
													reaffirm it.
												{:else if r.type !== undefined && r.current_type !== r.type}
													<span class="font-mono">{r.artifact}</span> must be a {r.type} artifact{#if r.content_type}{' '}
														({r.content_type}){/if} — the attached one is {r.current_type}.
												{:else}
													<!-- Only the content type differs; the API doesn't report the
													     attached version's own content type, so don't name it. -->
													<span class="font-mono">{r.artifact}</span> must be
													{r.content_type} — the attached {r.current_type} isn't.
												{/if}
												{#if r.description}
													<span
														class="text-muted-foreground mt-0.5 line-clamp-2 italic"
														title={r.description}>{r.description}</span
													>
												{/if}
											</span>
										{/if}
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				{/each}
			</div>
		{:else}
			<p class="text-muted-foreground text-xs" transition:fade={{ duration: dur() }}>
				No outgoing transitions — this state is terminal.
			</p>
		{/if}
		<p class="text-muted-foreground mt-3 text-xs">
			Workflow:
			<a href="/workflows/{data.issue.workflow.id}" class="hover:underline"
				>{data.issue.workflow.name}</a
			>
		</p>

		<!-- escape hatch: jump to any state, or move onto another workflow -->
		<details class="mt-4 border-t pt-3">
			<summary
				class="text-muted-foreground hover:text-foreground cursor-pointer text-xs select-none"
			>
				Move directly…
			</summary>
			<form onsubmit={applyOverride} class="mt-3 space-y-3">
				<div class="space-y-1">
					<label class="text-muted-foreground text-xs font-medium" for="override-workflow"
						>Workflow</label
					>
					<Select
						id="override-workflow"
						bind:value={
							() => overrideWorkflowId,
							(v) => {
								overrideWorkflowPick = v;
								overrideStatePick = null; // a new workflow restarts the state default
							}
						}
						class="h-8 text-xs"
					>
						{#each data.workflows as workflow (workflow.id)}
							<option value={workflow.id}>
								{workflow.name}{workflow.is_system ? ' (standard)' : ''}
							</option>
						{/each}
					</Select>
				</div>
				<div class="space-y-1">
					<label class="text-muted-foreground text-xs font-medium" for="override-state">State</label
					>
					<Select
						id="override-state"
						bind:value={() => overrideStateId, (v) => (overrideStatePick = v)}
						class="h-8 text-xs"
					>
						{#each overrideWorkflow.states as state (state.id)}
							<option value={state.id}>
								{state.name}{overrideWorkflowId === data.issue.workflow.id &&
								state.id === currentState.id
									? ' — current'
									: ''}
							</option>
						{/each}
					</Select>
				</div>
				<div class="flex items-center gap-2">
					<Button
						type="submit"
						size="sm"
						variant="outline"
						disabled={!overrideDirty || applyingOverride}
					>
						{applyingOverride ? 'Moving…' : 'Move'}
					</Button>
					<p class="text-muted-foreground text-xs">Bypasses the workflow's transitions.</p>
				</div>
			</form>
		</details>
	</section>

	<div class="min-w-0 space-y-8 lg:col-start-1 lg:row-span-2 lg:row-start-1">
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
						<Textarea
							bind:value={descriptionDraft}
							rows={8}
							placeholder="Describe the work (Markdown)…"
						/>
						<div class="mt-2 flex gap-2">
							<Button size="sm" onclick={saveDescription} disabled={savingDescription}>
								{savingDescription ? 'Saving…' : 'Save'}
							</Button>
							<Button size="sm" variant="ghost" onclick={() => (editingDescription = false)}
								>Cancel</Button
							>
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
							({data.issue.context_summary.prompts} prompt{data.issue.context_summary.prompts === 1
								? ''
								: 's'},
							{data.issue.context_summary.skills} skill{data.issue.context_summary.skills === 1
								? ''
								: 's'},
							{data.issue.context_summary.repos} repo{data.issue.context_summary.repos === 1
								? ''
								: 's'})
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
					{#if contextItemsPanel.current.status === 'pending'}
						<Skeleton class="h-16 w-full" />
					{:else if contextItemsPanel.current.status === 'loaded'}
						<ContextItemList
							items={contextItemsPanel.current.value}
							onselect={openContextEdit}
							emptyMessage="Nothing attached to this issue yet — add a note, skill, or repo."
						/>
					{:else}
						{@render loadFailed("this issue's context")}
					{/if}
				</div>
				<details class="group border-t pt-3">
					<summary
						class="text-muted-foreground hover:text-foreground cursor-pointer text-sm select-none"
					>
						Effective context
						<span class="text-xs">
							— everything that applies while in
							<span class="font-medium">{currentState.name}</span> (changes as the issue transitions)
						</span>
					</summary>
					<div class="mt-3">
						{#if effectiveContextPanel.current.status === 'pending'}
							<Skeleton class="h-24 w-full" />
						{:else if effectiveContextPanel.current.status === 'loaded'}
							<EffectiveContextView context={effectiveContextPanel.current.value} />
						{:else}
							{@render loadFailed('the effective context')}
						{/if}
					</div>
				</details>
			</div>
		</section>

		<!-- artifacts: the issue's attached work products -->
		<ArtifactsPanel
			issueId={data.issue.id}
			artifacts={data.artifacts}
			allowedTransitions={data.issue.allowed_transitions}
			onchanged={refresh}
			onerror={showError}
		/>

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
						<header
							class="text-muted-foreground flex items-center gap-2 border-b px-4 py-2 text-xs"
						>
							<span class="text-foreground font-medium">{actorLabel(comment.actor)}</span>
							<span title={new Date(comment.created_at).toLocaleString()}>
								{comment.pending ? 'sending…' : relativeTime(comment.created_at)}
							</span>
							{#if comment.updated_at}
								<span class="italic" title={new Date(comment.updated_at).toLocaleString()}>
									(edited)
								</span>
							{/if}
							{#if !comment.pending}
								<div class="ml-auto flex items-center gap-1">
									<Button
										variant="ghost"
										size="icon"
										class="size-6"
										title="Edit comment"
										aria-label="Edit comment"
										disabled={busyCommentId === comment.id}
										onclick={() => startEditComment(comment)}
									>
										<IconPencil size={14} stroke={1.5} />
									</Button>
									<Button
										variant="ghost"
										size="icon"
										class="size-6"
										title="Delete comment"
										aria-label="Delete comment"
										disabled={busyCommentId === comment.id}
										onclick={() => deleteComment(comment)}
									>
										<IconTrash size={14} stroke={1.5} />
									</Button>
								</div>
							{/if}
						</header>
						<div class="p-4">
							{#if editingCommentId === comment.id}
								<Textarea bind:value={commentDraft} rows={6} />
								<div class="mt-2 flex justify-end gap-2">
									<Button
										variant="ghost"
										size="sm"
										disabled={busyCommentId === comment.id}
										onclick={() => (editingCommentId = null)}>Cancel</Button
									>
									<Button
										size="sm"
										disabled={!commentDraft.trim() || busyCommentId === comment.id}
										onclick={() => saveComment(comment)}>Save</Button
									>
								</div>
							{:else}
								<Markdown source={comment.body} />
							{/if}
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

	<!-- min-w-0, like the main column: a grid item defaults to a min-content
	     floor, so one nowrap row in here (a truncated linked-issue title) would
	     otherwise widen the column past the viewport. -->
	<aside class="min-w-0 space-y-8 lg:col-start-2 lg:row-start-2">
		<!-- the supervisor's view of this issue -->
		{#if agentActivityPanel.current.status === 'pending'}
			<Skeleton class="h-40 w-full" />
		{:else if agentActivityPanel.current.status === 'loaded'}
			{@const [dispatch, runs, runners] = agentActivityPanel.current.value}
			<AgentActivityCard issue={data.issue} {dispatch} {runs} {runners} onerror={showError} />
		{:else}
			{@render loadFailed('agent activity')}
		{/if}

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

<!-- transition dialog: optional comment posted atomically with the move -->
{#if pendingTransition}
	{@const transition = pendingTransition}
	<Modal
		open={true}
		onclose={() => (pendingTransition = null)}
		title={`${transition.name} → ${transition.to_state.name}`}
	>
		<form
			class="space-y-3"
			onsubmit={(e) => {
				e.preventDefault();
				void move(transition, transitionComment.trim());
			}}
		>
			<p class="text-sm">
				Move this issue to <span class="font-medium">{transition.to_state.name}</span>
				({transition.to_state.category.replaceAll('_', ' ')})?
			</p>
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="transition-comment">Comment (optional)</label>
				<Textarea
					id="transition-comment"
					bind:value={transitionComment}
					rows={3}
					placeholder="Feedback, context, or instructions for whoever picks this up…"
				/>
				<p class="text-muted-foreground text-xs">
					Posted with the transition — if this move hands the issue to an agent, its very next run's
					prompt already contains it.
				</p>
			</div>
			<div class="flex flex-wrap justify-end gap-2">
				<Button
					type="button"
					variant="ghost"
					disabled={transitioning}
					onclick={() => (pendingTransition = null)}
				>
					Cancel
				</Button>
				<PendingButton
					type="submit"
					pending={transitioning}
					pendingLabel="Moving…"
					title={transition.name}
				>
					{transition.name}
				</PendingButton>
			</div>
		</form>
	</Modal>
{/if}
