<script lang="ts">
	import type {
		DispatchExplainer,
		EffectiveContext,
		IssueTransferPreview,
		IssueTransferResult,
		Project,
		TransferConflictParticipant
	} from '@tines/shared';
	import { deriveTransferConflictDeltas } from '@tines/shared';
	import { tick } from 'svelte';
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
	let uncertain = $state(false);
	let destinationSelect = $state<HTMLSelectElement | null>(null);
	let reviewHeading = $state<HTMLHeadingElement | null>(null);
	/** Only the newest request may render: an older reply must not overwrite it. */
	let requestSeq = 0;

	function reset() {
		destination = '';
		preview = null;
		error = null;
		stale = false;
		uncertain = false;
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
			await tick();
			reviewHeading?.focus({ preventScroll: true });
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
			} else if (!fail.code) {
				uncertain = true;
				error =
					'The response was lost, so the move may have completed. Check the current issue before trying again.';
			}
		} finally {
			committing = false;
		}
	}

	const changes = $derived(preview?.context.changes ?? []);

	const participation = (change: (typeof changes)[number]) =>
		({
			added: 'added by destination',
			removed: 'removed with source',
			retained: 'retained',
			rescoped: 'moves with the issue',
			replaced: 'effective selection changes'
		})[change.change];

	const effectiveness = (present: boolean, effective: boolean) =>
		!present ? 'not present' : effective ? 'effective' : 'overridden candidate';

	const repoDetail = (repo: { url: string; branch?: string | null; dir: string }) =>
		`${repo.url}; branch ${repo.branch ?? 'repository default branch'}; directory ${repo.dir}`;

	const contextSides = (value: IssueTransferPreview) =>
		[
			{ label: 'Before', context: value.context.before },
			{ label: 'After', context: value.context.after }
		] satisfies { label: string; context: EffectiveContext }[];

	const routingSides = (value: IssueTransferPreview) =>
		[
			{ label: 'Before', routing: value.routing.before },
			{ label: 'After', routing: value.routing.after }
		] satisfies { label: string; routing: DispatchExplainer | null }[];

	const conflictDeltas = $derived(
		preview ? deriveTransferConflictDeltas(preview.context.before, preview.context.after) : []
	);

	const conflictParticipants = (participants: TransferConflictParticipant[]) =>
		participants
			.map((participant) =>
				participant.name && participant.scope_label
					? `${participant.name} (${participant.scope_label})`
					: participant.item_id
			)
			.join(', ');

	function itemContent(context: EffectiveContext, itemId: string): string[] {
		const prompt = context.prompt.parts.find((item) => item.item_id === itemId);
		if (prompt) return [prompt.body];
		const skill = context.skills.find((item) => item.item_id === itemId);
		if (skill) return skill.files.map((file) => `${file.path}\n${file.content}`);
		const repo = context.repos.find((item) => item.item_id === itemId);
		if (repo) return [`${repo.url}${repo.branch ? ` @ ${repo.branch}` : ''} → ${repo.dir}`];
		return [];
	}

	function reviewedContent(before: EffectiveContext, after: EffectiveContext, itemId: string) {
		const beforeContent = itemContent(before, itemId);
		const afterContent = itemContent(after, itemId);
		if (JSON.stringify(beforeContent) === JSON.stringify(afterContent) && beforeContent.length) {
			return beforeContent.map((content) => ({ label: 'Before and after', content }));
		}
		return [
			...beforeContent.map((content) => ({ label: 'Before', content })),
			...afterContent.map((content) => ({ label: 'After', content }))
		];
	}

	async function recover() {
		const issue = await api.getIssue(issueId);
		window.location.assign(`/issues/${encodeURIComponent(issue.project_name)}/${issue.number}`);
	}
</script>

<Modal
	bind:open
	title="Move to project…"
	size="xl"
	onclose={reset}
	initialFocus={() => destinationSelect}
>
	{#if !preview}
		<div class="space-y-4">
			{#if destinations.length === 0}
				<p class="text-muted-foreground text-sm">No other active projects.</p>
			{:else}
				<label class="block space-y-1 text-sm">
					<span class="font-medium">Destination project</span>
					<select
						bind:this={destinationSelect}
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
			<h3 class="text-base font-medium wrap-anywhere" tabindex="-1" bind:this={reviewHeading}>
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
				<p class="text-muted-foreground text-xs">
					Runner pin: {preview.preserved.pinned_runner_id ?? 'none'}; tier pin: {preview.preserved
						.pinned_tier ?? 'none'}; attempts: {preview.preserved.attempt_count}; parked: {preview
						.preserved.parked
						? 'yes'
						: 'no'}.
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
											({change.kind}) — {participation(change)}
										</span>
									</summary>
									<p class="text-muted-foreground pl-4 text-xs">
										{change.scope_before?.label ?? '—'} → {change.scope_after?.label ?? '—'}
									</p>
									<p class="text-muted-foreground pl-4 text-xs">
										Before: {effectiveness(Boolean(change.scope_before), change.effective_before)};
										after: {effectiveness(Boolean(change.scope_after), change.effective_after)}
									</p>
									{#each reviewedContent(preview.context.before, preview.context.after, change.item_id) as item}
										<p class="mt-1 pl-4 text-xs font-medium">{item.label}</p>
										<pre
											class="bg-muted mt-1 max-h-48 overflow-auto p-2 text-xs break-all whitespace-pre-wrap">{item.content}</pre>
									{/each}
								</details>
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			<section class="space-y-1">
				<h4 class="font-medium">Effective repositories</h4>
				<div class="grid gap-3 sm:grid-cols-2">
					{#each contextSides(preview) as side (side.label)}
						<div class="min-w-0 space-y-1">
							<h5 class="text-xs font-medium">{side.label}</h5>
							{#if side.context.repos.length === 0}<p class="text-muted-foreground text-xs">
									none
								</p>{/if}
							{#each side.context.repos as repo (repo.item_id)}
								<p class="text-xs wrap-anywhere">
									<strong>{repo.name}</strong> — effective ({repo.scope.label})
								</p>
								<p class="text-muted-foreground text-xs wrap-anywhere">{repoDetail(repo)}</p>
								{#each side.context.overridden.filter((item) => item.kind === 'repo' && item.name === repo.name) as loser (loser.item_id)}
									<p class="text-xs wrap-anywhere">
										Overridden candidate: {loser.name} ({loser.scope.label}) — overridden by {loser.overridden_by}
									</p>
									<p class="text-muted-foreground text-xs wrap-anywhere">
										{loser.repo
											? repoDetail(loser.repo)
											: 'Checkout details unavailable from this server.'}
									</p>
								{/each}
							{/each}
						</div>
					{/each}
				</div>
			</section>

			<section class="space-y-1">
				<h4 class="font-medium">Repository checkout conflicts</h4>
				{#if conflictDeltas.length === 0}
					<p class="text-muted-foreground text-xs">None.</p>
				{:else}
					<ul class="space-y-2">
						{#each conflictDeltas as delta (delta.key + delta.change)}
							<li class="min-w-0 text-xs wrap-anywhere" data-testid="transfer-conflict-row">
								<p class="font-medium capitalize">{delta.change} — {delta.dir}</p>
								{#if delta.before.length}<p>Before: {conflictParticipants(delta.before)}</p>{/if}
								{#if delta.after.length}<p>After: {conflictParticipants(delta.after)}</p>{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			<section class="space-y-2">
				<h4 class="font-medium">Routing</h4>
				<div class="grid gap-3 sm:grid-cols-2">
					{#each routingSides(preview) as side (side.label)}
						<div class="min-w-0 space-y-1">
							<h5 class="text-xs font-medium">{side.label}</h5>
							<p class="text-muted-foreground text-xs">
								{side.routing?.verdict ?? 'No routing explanation available.'}
							</p>
							{#if side.routing}
								{#if side.routing.pin}<p class="text-xs">
										Pin: {side.routing.pin.runner_name ?? side.routing.pin.runner_id}; tier {side
											.routing.pin.tier ?? 'default'}
									</p>{/if}
								{#each side.routing.checks as check (check.name)}
									<div class="min-w-0 text-xs wrap-anywhere">
										<p>
											<strong>{check.ok ? 'Pass' : 'Failed'} {check.name}:</strong>
											{check.detail}
										</p>
										{#if check.action?.href}
											<a class="underline" href={check.action.href}>{check.action.label}</a>
										{:else if check.action?.cli}
											<code class="block wrap-anywhere whitespace-pre-wrap">{check.action.cli}</code
											>
										{/if}
									</div>
								{/each}
								{#if side.routing.matched_rule}<p class="text-xs">
										Matched rule: {side.routing.matched_rule.scope_label}
									</p>{/if}
								{#if side.routing.runner_rule}<p class="text-xs">
										Runner source rule: {side.routing.runner_rule.scope_label}
									</p>{/if}
								{#if side.routing.tier_override}<p class="text-xs">
										Tier override: {side.routing.tier_override}
									</p>{/if}
								{#each side.routing.ambiguous_rules as rule (rule.rule_id)}<p class="text-xs">
										Tied rule: {rule.scope_label}
									</p>{/each}
								{#each side.routing.targets as target (target.runner_id)}<p
										class="text-xs wrap-anywhere"
									>
										Target {target.runner_name} — {target.tier}{target.model
											? ` / ${target.model}`
											: ''}: {target.verdict} — {target.detail}
									</p>{/each}
								{#if side.routing.active_run}<p class="text-xs">
										Active run: {side.routing.active_run.id} on {side.routing.active_run
											.runner_name}
										({side.routing.active_run.status})
									</p>{/if}
								{#if side.routing.queue_position !== null}<p class="text-xs">
										Queue position: {side.routing.queue_position}
									</p>{/if}
								<p class="text-xs">
									Attempts: {side.routing.attempt_count}/{side.routing.attempt_limit}; parked: {side
										.routing.parked
										? 'yes'
										: 'no'}
								</p>
							{/if}
						</div>
					{/each}
				</div>
				<p class="text-muted-foreground text-xs">
					Capacity, heartbeats and spending are advisory and may change at any moment.
				</p>
			</section>

			{#if preview.schedule}
				<p class="text-muted-foreground text-xs">{preview.schedule.notice}</p>
			{/if}

			{#each preview.blockers as blocker (blocker.code)}
				<div class="text-destructive text-sm" role="alert" data-testid="transfer-blocker">
					<p>{blocker.message}</p>
					{#if blocker.remedy}<p class="font-mono text-xs">{blocker.remedy}</p>{/if}
				</div>
			{/each}
			{#if error}
				<p class="text-destructive text-sm" role="alert">{error}</p>
			{/if}
			{#if uncertain}
				<Button variant="outline" onclick={recover}>Check current issue</Button>
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
