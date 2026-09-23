<script lang="ts">
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	let { data } = $props();
	let commentDraft = $state('');
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
			await refresh();
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
			await refresh();
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
<main class="mx-auto max-w-4xl px-4 py-6">
	<a class="text-sm underline" href={`/projects/${data.issue.project.id}`}
		>← {data.issue.project.name}</a
	>
	<p class="text-muted-foreground mt-5 text-sm">
		#{data.issue.number} · {data.issue.state.name} · Shared by {data.issue.project.owner.name}
	</p>
	<h1 class="mt-2 text-2xl font-semibold">{data.issue.title}</h1>
	{#if error}<p role="alert" class="text-destructive mt-3">
			{error} Refresh before trying a stale decision again.
		</p>{/if}
	{#if notice}<p role="status" class="mt-3">{notice}</p>{/if}
	{#if data.issue.description}<div class="mt-5 whitespace-pre-wrap">
			{data.issue.description}
		</div>{/if}
	{#if data.issue.blocked_by_private_issue}<p class="mt-5" role="status">
			Blocked by another issue.
		</p>{/if}
	{#if data.issue.capabilities.decide}
		<section class="mt-6 rounded-lg border p-4" aria-labelledby="decision-heading">
			<h2 id="decision-heading" class="font-semibold">Decide this issue</h2>
			<select
				aria-label="Transition"
				class="mt-3 min-h-11 rounded border p-2"
				bind:value={decisionId}
				onchange={() => (transitionAllowsAgents = data.issue.my_choice.value !== 'off')}
				disabled={saving}
			>
				<option value="">Choose a transition</option>
				{#each data.issue.workflow.transitions as transition (transition.id)}
					<option value={transition.id}>{transition.name}</option>
				{/each}
			</select>
			{#if chosenDestination?.category === 'active'}
				<label class="mt-3 block" for="transition-permission">My agents after this decision</label>
				<select
					id="transition-permission"
					class="mt-2 min-h-11 rounded border p-2"
					bind:value={transitionAllowsAgents}
					disabled={saving}
				>
					<option value={true}>On</option><option value={false}>Off</option>
				</select>
				{#if transitionAllowsAgents}<p class="mt-2 text-sm">
						Permission covers this evolving issue and your own allowance. Your agents may run later
						when setup is ready, including after member execution is released. Turning permission
						off cannot reverse external actions or recall downloaded content.
					</p>{/if}
			{/if}
			<button
				class="ml-2 min-h-11 rounded border px-4"
				onclick={decide}
				disabled={saving || !decisionId}>Apply decision</button
			>
		</section>
	{/if}
	{#if data.issue.links.length > 0}
		<section class="mt-6" aria-labelledby="links-heading">
			<h2 id="links-heading" class="font-semibold">Linked issues</h2>
			<ul class="mt-2 space-y-2">
				{#each data.issue.links as link (link.id)}
					<li>
						{link.relation} ·
						<a
							class="underline"
							href={`/issues/${encodeURIComponent(link.project_id)}/${link.number}`}
							>{link.project_name}/#{link.number} · {link.title}</a
						>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
	<section class="mt-8" aria-labelledby="people-heading">
		<h2 id="people-heading" class="text-lg font-semibold">People and permission</h2>
		<ul class="mt-3 space-y-2">
			{#each data.issue.roster as person (person.user.id)}<li class="rounded border p-3">
					{person.user.name}{person.user.id === data.issue.viewer_id ? ' (You)' : ''} · {person.role}
					· {person.value}
				</li>{/each}
		</ul>
		{#if data.issue.capabilities.personal_permission}
			<div class="mt-4 rounded border p-3">
				<label for="my-issue-permission" class="block font-medium">My agents on this issue</label>
				<select
					id="my-issue-permission"
					class="mt-2 min-h-11 rounded border p-2"
					bind:value={choice}
					onchange={() => (choiceDirty = true)}
					disabled={saving}
				>
					<option value="off">Off</option><option value="on">On</option>
				</select>
				<button class="ml-2 min-h-11 rounded border px-4" onclick={saveChoice} disabled={saving}
					>Save permission</button
				>
				<details class="mt-3">
					<summary>What permission covers</summary>
					<p class="mt-2 text-sm">
						Permission covers this evolving issue and your own allowance. Your agents may run later
						when setup is ready, including after member execution is released. Turning permission
						off cannot reverse external actions or recall downloaded content.
					</p>
				</details>
			</div>
		{/if}
		<p class="mt-2">
			Your agents cannot run on this project in this release. Uses this project's guidance and
			workflows. Execution guidance will be available with member execution.
		</p>
		<a class="mt-2 inline-block underline" href={`/projects/${data.issue.project.id}/people`}
			>View people</a
		>
	</section>
	<section class="mt-8" aria-labelledby="run-heading">
		<h2 id="run-heading" class="text-lg font-semibold">Latest run</h2>
		<p class="mt-2">{data.issue.latest_run?.status ?? 'No run yet'}</p>
	</section>
	<section class="mt-8" aria-labelledby="comments-heading">
		<h2 id="comments-heading" class="text-lg font-semibold">Comments</h2>
		{#if data.issue.comments.length === 0}<p class="mt-3">No comments yet.</p>{:else}<ul
				class="mt-3 space-y-4"
			>
				{#each data.issue.comments as comment (comment.id)}<li class="rounded-lg border p-4">
						<p class="text-sm font-medium">
							{comment.author.name}{comment.author.run ? ` · via ${comment.author.run.name}` : ''}
						</p>
						<p class="mt-2 whitespace-pre-wrap">{comment.body}</p>
						{#if comment.editor}<p class="text-muted-foreground mt-2 text-xs">
								Edited by {comment.editor.name}
							</p>{/if}
						{#if comment.author.id === data.issue.viewer_id}
							{#if editingId === comment.id}
								<textarea
									aria-label="Edit comment"
									class="mt-3 w-full rounded border p-2"
									bind:value={editingDraft}></textarea>
								<button
									class="min-h-11 rounded border px-3"
									onclick={() => editComment(comment.id)}
									disabled={saving}>Save edit</button
								>
							{:else}<button
									class="mt-2 min-h-11 underline"
									onclick={() => {
										editingId = comment.id;
										editingDraft = comment.body;
									}}>Edit</button
								>{/if}
							<button
								class="ml-3 min-h-11 underline"
								onclick={() => removeComment(comment.id)}
								disabled={saving}>Delete</button
							>
						{/if}
					</li>{/each}
			</ul>{/if}
		<textarea
			aria-label="New comment"
			class="mt-4 min-h-24 w-full rounded border p-2"
			bind:value={commentDraft}></textarea>
		<button
			class="mt-2 min-h-11 rounded border px-4"
			onclick={addComment}
			disabled={saving || !commentDraft.trim()}>Post comment</button
		>
	</section>
	<section class="mt-8" aria-labelledby="artifacts-heading">
		<h2 id="artifacts-heading" class="text-lg font-semibold">Artifacts</h2>
		{#if data.issue.artifacts.length === 0}<p class="mt-3">No artifacts yet.</p>{:else}<ul
				class="mt-3 space-y-2"
			>
				{#each data.issue.artifacts as artifact (artifact.id)}<li>
						<a
							class="underline"
							href={`/api/v1/issues/${data.issue.id}/artifacts/${encodeURIComponent(artifact.name)}/content`}
							>{artifact.name}</a
						>
					</li>{/each}
			</ul>{/if}
	</section>
	<section class="mt-8" aria-labelledby="history-heading">
		<h2 id="history-heading" class="text-lg font-semibold">History</h2>
		{#if data.issue.history.length === 0}<p class="mt-3">No shared history yet.</p>{:else}<ul
				class="mt-3 space-y-2"
			>
				{#each data.issue.history as event (event.id)}<li>
						{event.type} · {new Date(event.created_at).toLocaleString()}
					</li>{/each}
			</ul>{/if}
	</section>
</main>
