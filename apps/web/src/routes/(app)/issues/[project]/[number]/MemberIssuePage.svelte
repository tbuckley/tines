<script lang="ts">
	import { goto, invalidate, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import PersonalPermissionWarning from '$lib/components/PersonalPermissionWarning.svelte';
	import EventList from '$lib/components/EventList.svelte';
	import Markdown from '$lib/components/Markdown.svelte';
	import StateBadge from '$lib/components/StateBadge.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Select } from '$lib/components/ui/select/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import IconChevronLeft from '@tabler/icons-svelte/icons/chevron-left';
	import { relativeTime } from '$lib/format';
	import type { TinesEvent } from '@tines/shared';
	let { data } = $props();
	let commentDraft = $state('');
	const historyEvents = $derived(
		data.issue.history.map(
			(event: {
				id: string;
				type: string;
				created_at: number;
				actor_user_id: string;
				actor_name: string;
				payload: Record<string, unknown>;
			}): TinesEvent => ({
				id: event.id,
				type: event.type,
				created_at: event.created_at,
				actor: {
					user_id: event.actor_user_id,
					user_name: event.actor_name,
					api_key_id: null,
					api_key_name: null
				},
				issue_id: data.issue.id,
				project_id: data.issue.project.id,
				issue_ref: {
					project_id: data.issue.project.id,
					project_name: data.issue.project.name,
					number: data.issue.number,
					title: data.issue.title
				},
				project_name: data.issue.project.name,
				payload: event.payload
			})
		)
	);
	let editingId = $state<string | null>(null);
	let editingDraft = $state('');
	let saving = $state(false);
	let error = $state('');
	let notice = $state('');
	let choice = $state<'on' | 'off'>('off');
	let choiceDirty = $state(false);
	$effect(() => {
		if (!choiceDirty) choice = data.issue.my_choice.value === 'on' ? 'on' : 'off';
	});
	let decisionId = $state('');
	let transitionAllowsAgents = $state(true);
	let chosenTransition = $derived(
		data.issue.workflow.transitions.find(
			(entry: { id: string; to_state_id: string }) => entry.id === decisionId
		)
	);
	let chosenDestination = $derived(
		data.issue.workflow.states.find(
			(state: { id: string; category: string }) => state.id === chosenTransition?.to_state_id
		)
	);
	const refresh = () => invalidate('app:issue');
	function fail(e: unknown) {
		error = e instanceof Error ? e.message : 'Save failed. Try again.';
	}
	async function saveChoice() {
		if (saving) return;
		saving = true;
		error = '';
		notice = '';
		try {
			await api.setIssueConsent(data.issue.id, {
				value: choice,
				expected_revision: data.issue.my_choice.revision,
				issue_epoch: data.issue.my_choice.epoch,
				decision_revision: data.issue.decision_revision,
				...(choice === 'on' ? { disclosure_version: 1 } : {})
			});
			notice = 'Permission saved. Member execution is not available in this release.';
			choiceDirty = false;
			await invalidateAll();
		} catch (e) {
			fail(e);
		} finally {
			saving = false;
		}
	}
	async function addComment() {
		if (saving || !commentDraft.trim()) return;
		saving = true;
		error = '';
		try {
			await api.createComment(data.issue.id, { body: commentDraft });
			commentDraft = '';
			await refresh();
		} catch (e) {
			fail(e);
		} finally {
			saving = false;
		}
	}
	async function editComment(id: string) {
		if (saving || !editingDraft.trim()) return;
		saving = true;
		error = '';
		try {
			await api.updateComment(data.issue.id, id, { body: editingDraft });
			editingId = null;
			await refresh();
		} catch (e) {
			fail(e);
		} finally {
			saving = false;
		}
	}
	async function removeComment(id: string) {
		if (saving) return;
		saving = true;
		error = '';
		try {
			await api.deleteComment(data.issue.id, id);
			await refresh();
		} catch (e) {
			fail(e);
		} finally {
			saving = false;
		}
	}
	async function decide() {
		if (saving || !decisionId) return;
		saving = true;
		error = '';
		try {
			await api.transitionIssue(data.issue.id, {
				transition_id: decisionId,
				expected_state_id: data.issue.state.id,
				expected_decision_revision: data.issue.decision_revision,
				expected_workflow_revision: data.issue.workflow_revision,
				expected_consent_revision: data.issue.my_choice.revision,
				expected_consent_epoch: data.issue.my_choice.epoch,
				...(chosenDestination?.category === 'active'
					? {
							allow_my_agents: transitionAllowsAgents,
							...(transitionAllowsAgents ? { disclosure_version: 1 } : {})
						}
					: {})
			});
			decisionId = '';
			await invalidateAll();
		} catch (e) {
			fail(e);
		} finally {
			saving = false;
		}
	}
	$effect(() => {
		if (page.url.pathname !== data.canonicalPath)
			void goto(`${data.canonicalPath}${page.url.search}${page.url.hash}`, {
				replaceState: true,
				keepFocus: true,
				noScroll: true
			});
	});
</script>

<svelte:head><title>{data.issue.title} · Tines</title></svelte:head>
<div class="mb-6">
	<a
		href={`/projects/${data.issue.project.id}`}
		class="text-muted-foreground hover:text-foreground mb-3 inline-flex max-w-full min-w-0 items-center gap-1 text-sm"
	>
		<IconChevronLeft size={16} class="shrink-0" /><span class="truncate"
			>{data.issue.project.name}</span
		>
	</a>
	<p class="text-muted-foreground text-sm">
		{data.issue.project.name}/#{data.issue.number} · Shared by {data.issue.project.owner.name}
	</p>
	<div class="mt-2 flex flex-wrap items-center gap-3">
		<h1 class="min-w-0 text-2xl font-semibold tracking-tight wrap-anywhere">{data.issue.title}</h1>
		<StateBadge state={data.issue.state} />
	</div>
</div>
{#if error}<p
		role="alert"
		class="border-destructive/40 bg-destructive/10 text-destructive mb-4 rounded-md border p-3 text-sm"
	>
		{error} Refresh before trying a stale decision again.
	</p>{/if}
{#if notice}<p role="status" class="bg-muted mb-4 rounded-md p-3 text-sm">{notice}</p>{/if}
{#if data.issue.blocked_by_private_issue}<p
		class="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
		role="status"
	>
		Blocked by another issue.
	</p>{/if}

<div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:grid-rows-[auto_1fr]">
	{#if data.issue.capabilities.decide}<section
			class="rounded-lg border p-4 lg:col-start-2 lg:row-start-1"
			aria-labelledby="decision-heading"
		>
			<h2 id="decision-heading" class="text-sm font-semibold">Decide this issue</h2>
			<label for="member-transition" class="mt-3 block text-sm">Transition</label>
			<Select
				id="member-transition"
				aria-label="Transition"
				class="mt-1 min-h-11"
				bind:value={decisionId}
				onchange={() => (transitionAllowsAgents = data.issue.my_choice.value !== 'off')}
				disabled={saving}
			>
				<option value="">Choose a transition</option
				>{#each data.issue.workflow.transitions as transition (transition.id)}<option
						value={transition.id}>{transition.name}</option
					>{/each}
			</Select>
			{#if chosenDestination?.category === 'active'}<label
					class="mt-3 block text-sm"
					for="transition-permission">My agents after this decision</label
				><Select
					id="transition-permission"
					class="mt-1 min-h-11"
					bind:value={transitionAllowsAgents}
					disabled={saving}
					><option value={true}>On</option><option value={false}>Off</option></Select
				>{#if transitionAllowsAgents}<PersonalPermissionWarning role="member" />{/if}{/if}
			<Button class="mt-3 w-full" onclick={decide} disabled={saving || !decisionId}
				>Apply decision</Button
			>
		</section>{/if}
	<div class="min-w-0 space-y-6 lg:col-start-1 lg:row-span-2 lg:row-start-1">
		<section class="rounded-lg border" aria-labelledby="description-heading">
			<header class="border-b px-4 py-2.5">
				<h2 id="description-heading" class="text-sm font-semibold">Description</h2>
			</header>
			<div class="p-4">
				{#if data.issue.description}<Markdown source={data.issue.description} />{:else}<p
						class="text-muted-foreground text-sm italic"
					>
						No description.
					</p>{/if}
			</div>
		</section>
		<section aria-labelledby="comments-heading">
			<h2 id="comments-heading" class="mb-3 text-sm font-semibold">Comments</h2>
			{#if data.issue.comments.length === 0}<p
					class="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm"
				>
					No comments yet.
				</p>{:else}
				<ul class="space-y-3">
					{#each data.issue.comments as comment (comment.id)}<li class="rounded-lg border p-4">
							<div class="flex flex-wrap items-center justify-between gap-2">
								<p class="text-sm font-medium">
									{comment.author.name}{comment.author.run
										? ` · via ${comment.author.run.name}`
										: ''}
								</p>
								<time
									class="text-muted-foreground text-xs"
									datetime={new Date(comment.created_at).toISOString()}
									>{relativeTime(comment.created_at)}</time
								>
							</div>
							<div class="mt-2"><Markdown source={comment.body} /></div>
							{#if comment.editor}<p class="text-muted-foreground mt-2 text-xs">
									Edited by {comment.editor.name}
								</p>{/if}
							{#if comment.author.id === data.issue.viewer_id}
								<div class="mt-2 flex flex-wrap items-center gap-2">
									{#if editingId === comment.id}<Textarea
											aria-label="Edit comment"
											class="min-h-24 w-full"
											bind:value={editingDraft}
										/><Button size="sm" onclick={() => editComment(comment.id)} disabled={saving}
											>Save edit</Button
										><Button size="sm" variant="ghost" onclick={() => (editingId = null)}
											>Cancel</Button
										>
									{:else}<Button
											size="sm"
											variant="ghost"
											onclick={() => {
												editingId = comment.id;
												editingDraft = comment.body;
											}}>Edit</Button
										>{/if}
									<Button
										size="sm"
										variant="ghost"
										onclick={() => removeComment(comment.id)}
										disabled={saving}>Delete</Button
									>
								</div>
							{/if}
						</li>{/each}
				</ul>
			{/if}
			<div class="mt-4 space-y-2">
				<label class="text-sm font-medium" for="member-new-comment">Add a comment</label><Textarea
					id="member-new-comment"
					aria-label="New comment"
					class="min-h-24"
					bind:value={commentDraft}
					placeholder="Write a comment in Markdown…"
				/><Button onclick={addComment} disabled={saving || !commentDraft.trim()}
					>Post comment</Button
				>
			</div>
		</section>
		<section class="rounded-lg border" aria-labelledby="history-heading">
			<header class="border-b px-4 py-2.5">
				<h2 id="history-heading" class="text-sm font-semibold">History</h2>
			</header>
			<div class="p-3">
				<EventList
					events={historyEvents}
					showIssueLinks={false}
					emptyMessage="No shared history yet."
				/>
			</div>
		</section>
	</div>
	<aside
		class="min-w-0 space-y-6 lg:col-start-2 {data.issue.capabilities.decide
			? 'lg:row-start-2'
			: 'lg:row-start-1'}"
	>
		<section class="rounded-lg border p-4" aria-labelledby="people-heading">
			<h2 id="people-heading" class="text-sm font-semibold">People and permission</h2>
			<ul class="mt-3 divide-y text-sm">
				{#each data.issue.roster as person (person.user.id)}<li
						class="flex flex-wrap items-center justify-between gap-2 py-2"
					>
						<span
							>{person.user.name}{person.user.id === data.issue.viewer_id ? ' (You)' : ''}<span
								class="text-muted-foreground"
							>
								· {person.role}</span
							></span
						><span class="bg-muted rounded-full px-2 py-0.5 text-xs capitalize">{person.value}</span
						>
					</li>{/each}
			</ul>
			{#if data.issue.capabilities.personal_permission}<div class="mt-4 border-t pt-4">
					<label for="my-issue-permission" class="text-sm font-medium"
						>My agents on this issue</label
					><Select
						id="my-issue-permission"
						class="mt-2 min-h-11"
						bind:value={choice}
						onchange={() => (choiceDirty = true)}
						disabled={saving}><option value="off">Off</option><option value="on">On</option></Select
					><Button class="mt-2 w-full" onclick={saveChoice} disabled={saving}
						>Save permission</Button
					>{#if choice === 'on'}<PersonalPermissionWarning role="member" />{/if}
				</div>{/if}
			<p class="text-muted-foreground mt-3 text-xs">
				Your agents cannot run on this project in this release. Execution guidance will be available
				with member execution.
			</p>
			<a
				class="text-primary mt-3 inline-block text-sm hover:underline"
				href={`/projects/${data.issue.project.id}/people`}>View people</a
			>
		</section>
		<section class="rounded-lg border p-4" aria-labelledby="run-heading">
			<h2 id="run-heading" class="text-sm font-semibold">Latest run</h2>
			<p class="text-muted-foreground mt-2 text-sm">
				{data.issue.latest_run?.status ?? 'No run yet'}
			</p>
		</section>
		{#if data.issue.links.length > 0}<section
				class="rounded-lg border p-4"
				aria-labelledby="links-heading"
			>
				<h2 id="links-heading" class="text-sm font-semibold">Linked issues</h2>
				<ul class="mt-2 space-y-2 text-sm">
					{#each data.issue.links as link (link.id)}<li>
							{link.relation} ·
							<a
								class="text-primary hover:underline"
								href={`/issues/${encodeURIComponent(link.project_id)}/${link.number}`}
								>{link.project_name}/#{link.number} · {link.title}</a
							>
						</li>{/each}
				</ul>
			</section>{/if}
		<section class="rounded-lg border p-4" aria-labelledby="artifacts-heading">
			<h2 id="artifacts-heading" class="text-sm font-semibold">Artifacts</h2>
			{#if data.issue.artifacts.length === 0}<p class="text-muted-foreground mt-2 text-sm">
					No artifacts yet.
				</p>{:else}<ul class="mt-2 space-y-2 text-sm">
					{#each data.issue.artifacts as artifact (artifact.id)}<li>
							<a
								class="text-primary hover:underline"
								href={`/api/v1/issues/${data.issue.id}/artifacts/${encodeURIComponent(artifact.name)}/content`}
								>{artifact.name}</a
							>
						</li>{/each}
				</ul>{/if}
		</section>
	</aside>
</div>
