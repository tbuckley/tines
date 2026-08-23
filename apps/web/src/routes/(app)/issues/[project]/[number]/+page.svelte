<script lang="ts">
	import type { AllowedTransition, Comment } from '@tines/shared';
	import { ApiError } from '@tines/shared';
	import IconArrowRight from '@tabler/icons-svelte/icons/arrow-right';
	import IconChevronLeft from '@tabler/icons-svelte/icons/chevron-left';
	import IconPencil from '@tabler/icons-svelte/icons/pencil';
	import IconRepeat from '@tabler/icons-svelte/icons/repeat';
	import { fade, slide } from 'svelte/transition';
	import { invalidateAll } from '$app/navigation';
	import { api } from '$lib/api';
	import EventList from '$lib/components/EventList.svelte';
	import Markdown from '$lib/components/Markdown.svelte';
	import StateBadge from '$lib/components/StateBadge.svelte';
	import WorkflowGraph from '$lib/components/WorkflowGraph.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Select } from '$lib/components/ui/select/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { actorLabel, prefersReducedMotion, relativeTime } from '$lib/format';

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

	let errorMessage = $state<string | null>(null);
	function showError(e: unknown) {
		errorMessage = e instanceof ApiError ? e.message : 'Something went wrong — try again.';
		setTimeout(() => (errorMessage = null), 6000);
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
		<span
			class="vt-shared"
			style:view-transition-name="issue-state-{data.issue.id}"
			style:view-transition-class="vt-fit"
		>
			<StateBadge state={currentState} class="text-sm" />
		</span>
	</div>
</div>

{#if errorMessage}
	<div
		class="border-destructive/40 bg-destructive/10 text-destructive mb-4 rounded-md border px-4 py-2.5 text-sm"
		transition:slide={{ duration: dur() }}
	>
		{errorMessage}
	</div>
{/if}

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
		<section class="rounded-lg border p-4">
			<h2 class="mb-3 text-sm font-semibold">State</h2>
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

		<!-- this issue's slice of the activity log -->
		<section>
			<h2 class="mb-3 text-sm font-semibold">Activity</h2>
			<EventList events={data.events} showIssueLinks={false} emptyMessage="No activity yet." />
		</section>
	</aside>
</div>
