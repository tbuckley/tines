<script lang="ts">
	import type { IssueTransferPreview, IssueTransferResult, Project } from '@tines/shared';
	import { api } from '$lib/api';
	import Modal from '$lib/components/Modal.svelte';
	import { Button } from '$lib/components/ui/button/index.js';

	/**
	 * "Move to project…": choose a destination, review exactly what changes, and
	 * confirm. Distinct from the workflow's "Move directly…", which changes the
	 * issue's state and never its project.
	 *
	 * The token the server returns with a preview is what gets confirmed, so a
	 * review the operator never saw can never be the thing that commits. Nothing
	 * here allocates a number: only the confirmed POST does.
	 */
	let {
		open = $bindable(false),
		issueId,
		currentProjectId,
		projects,
		oncompleted
	}: {
		open?: boolean;
		issueId: string;
		currentProjectId: string;
		/** Active, owned projects; the current one is filtered out here. */
		projects: Project[];
		/** Owned by the page so closing the dialog cannot swallow the result. */
		oncompleted: (result: IssueTransferResult) => void;
	} = $props();

	const destinations = $derived(projects.filter((p) => p.id !== currentProjectId));

	let destination = $state('');
	let preview = $state<IssueTransferPreview | null>(null);
	let loading = $state(false);
	let committing = $state(false);
	let error = $state<string | null>(null);
	let stale = $state(false);
	/** Only the newest request may render: an older reply must not overwrite it. */
	let requestSeq = 0;

	function reset() {
		destination = '';
		preview = null;
		error = null;
		stale = false;
		loading = false;
		committing = false;
	}

	async function review() {
		if (!destination) return;
		const seq = ++requestSeq;
		loading = true;
		error = null;
		stale = false;
		try {
			const next = await api.previewIssueTransfer(issueId, destination);
			if (seq !== requestSeq) return;
			preview = next;
		} catch (e) {
			if (seq !== requestSeq) return;
			error = e instanceof Error ? e.message : 'Could not load the review';
		} finally {
			if (seq === requestSeq) loading = false;
		}
	}

	async function commit() {
		if (!preview?.preview_token || committing) return;
		committing = true;
		error = null;
		try {
			const result = await api.transferIssue(issueId, {
				project_id: preview.destination.id,
				preview_token: preview.preview_token
			});
			open = false;
			oncompleted(result);
			reset();
		} catch (e) {
			const fail = e as { code?: string; message?: string };
			error = fail.message ?? 'The move failed';
			// A refreshed review needs a new, deliberate confirmation: never repost.
			if (fail.code === 'transfer_preview_stale') {
				// The refresh clears the flags it is about to re-raise, so the
				// notice is raised after it: the operator must see what changed.
				await review();
				stale = true;
			} else if (fail.code === 'transfer_conflict') {
				preview = null;
			}
		} finally {
			committing = false;
		}
	}

	const changes = $derived(preview?.context.changes.filter((c) => c.change !== 'retained') ?? []);
</script>

<Modal bind:open title="Move to project…" size="xl" onclose={reset}>
	{#if !preview}
		<div class="space-y-4">
			{#if destinations.length === 0}
				<p class="text-muted-foreground text-sm">No other active projects.</p>
			{:else}
				<label class="block space-y-1 text-sm">
					<span class="font-medium">Destination project</span>
					<select
						bind:value={destination}
						class="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
						data-testid="transfer-destination"
					>
						<option value="">Choose a project…</option>
						{#each destinations as project (project.id)}
							<option value={project.id}>{project.name}</option>
						{/each}
					</select>
				</label>
				<p class="text-muted-foreground text-xs">
					The issue keeps its ID, its whole record and every old reference. Its number is assigned
					when you move.
				</p>
			{/if}
			{#if error}
				<p class="text-destructive text-sm" role="alert">{error}</p>
			{/if}
			<div class="flex justify-end gap-2">
				<Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
				<Button disabled={!destination || loading} onclick={review}>
					{loading ? 'Loading review…' : 'Review move'}
				</Button>
			</div>
		</div>
	{:else}
		<div class="space-y-4 text-sm" data-testid="transfer-review">
			<h3 class="text-base font-medium" tabindex="-1">
				{preview.old_ref.ref} → {preview.destination.name}
			</h3>
			{#if stale}
				<p class="text-sm font-medium" role="alert" data-testid="transfer-stale">
					The issue or its guidance changed. Review the refreshed preview.
				</p>
			{/if}
			<p class="text-muted-foreground text-xs">{preview.number_notice}</p>

			<section class="space-y-1">
				<h4 class="font-medium">Preserved</h4>
				<p class="text-muted-foreground text-xs">
					{preview.preserved.comment_count} comments, {preview.preserved.artifact_count} artifacts ({preview
						.preserved.artifact_version_count} versions), {preview.preserved.run_count} runs, {preview
						.preserved.link_count} links, state, labels, pins and attempts — all unchanged.
				</p>
			</section>

			<section class="space-y-1">
				<h4 class="font-medium">Guidance</h4>
				{#if changes.length === 0}
					<p class="text-muted-foreground text-xs">Unchanged by this move.</p>
				{:else}
					<ul class="space-y-1">
						{#each changes as change (change.item_id)}
							<li>
								<details>
									<summary class="cursor-pointer">
										<span class="font-medium">{change.name}</span>
										<span class="text-muted-foreground text-xs">
											({change.kind}) — {change.change}
										</span>
									</summary>
									<p class="text-muted-foreground pl-4 text-xs">
										{change.scope_before?.label ?? '—'} → {change.scope_after?.label ?? '—'}
									</p>
									{#if change.repo_after}
										<p class="text-muted-foreground pl-4 text-xs break-all">
											{change.repo_after.url} → {change.repo_after.dir}
										</p>
									{/if}
								</details>
							</li>
						{/each}
					</ul>
				{/if}
				{#each preview.context.after.conflicts as conflict (conflict.dir)}
					<p class="text-xs">
						Two repositories still want the “{conflict.dir}” directory at the destination.
					</p>
				{/each}
			</section>

			<section class="space-y-1">
				<h4 class="font-medium">Routing after the move</h4>
				<p class="text-muted-foreground text-xs">
					{preview.routing.after?.verdict ?? 'No routing explanation available.'}
				</p>
				{#if preview.routing.after?.pin}
					<p class="text-muted-foreground text-xs">
						Pinned runner retained: {preview.routing.after.pin.runner_name ??
							preview.routing.after.pin.runner_id}
					</p>
				{/if}
			</section>

			{#if preview.schedule}
				<p class="text-muted-foreground text-xs">{preview.schedule.notice}</p>
			{/if}

			{#each preview.blockers as blocker (blocker.code)}
				<p class="text-destructive text-sm" role="alert" data-testid="transfer-blocker">
					{blocker.message}
				</p>
			{/each}
			{#if error}
				<p class="text-destructive text-sm" role="alert">{error}</p>
			{/if}

			<div class="flex justify-end gap-2">
				<Button variant="ghost" onclick={() => (preview = null)}>Back</Button>
				<Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
				<Button
					disabled={!preview.can_commit || committing || loading}
					onclick={commit}
					data-testid="transfer-confirm"
				>
					{committing ? 'Moving…' : 'Move issue'}
				</Button>
			</div>
		</div>
	{/if}
</Modal>
