<script lang="ts">
	import type { AgentRun } from '@tines/shared';
	import { api } from '$lib/api';
	import Modal from '$lib/components/Modal.svelte';
	import PendingButton from '$lib/components/PendingButton.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';

	let {
		run,
		attemptLimit,
		onclose,
		ondone,
		onerror
	}: {
		run: AgentRun;
		attemptLimit: number;
		onclose: () => void;
		/** Called after a successful comment+cancel (parent refreshes). */
		ondone: () => void;
		onerror: (e: unknown) => void;
	} = $props();

	// Whether this run already transitioned the issue decides the strike copy
	// (a cancel is judged like any other end).
	let advanced = $state<boolean | null>(null);
	let attemptCount = $state(0);
	let comment = $state('');
	let canceling = $state(false);

	$effect(() => {
		void (async () => {
			try {
				const [issue, transitions] = await Promise.all([
					api.getIssue(run.issue_id),
					api.listEvents({ issue: run.issue_id, type: 'issue.transitioned', limit: 100 })
				]);
				attemptCount = issue.attempt_count;
				advanced = transitions.items.some((e) => e.actor.run?.run_id === run.id);
			} catch (e) {
				onerror(e);
				onclose();
			}
		})();
	});

	const remaining = $derived(Math.max(0, attemptLimit - attemptCount - 1));

	async function confirmCancel() {
		if (canceling) return;
		canceling = true;
		try {
			// The optional comment posts BEFORE the cancellation — the sanctioned
			// cancel-correct-redispatch maneuver: sub-second re-dispatch can never
			// race past the correction.
			const body = comment.trim();
			if (body) await api.createComment(run.issue_id, { body });
			await api.cancelRun(run.id);
			ondone();
		} catch (e) {
			onerror(e);
		} finally {
			canceling = false;
		}
	}
</script>

<Modal open={true} {onclose} title="Cancel this run?">
	<div class="space-y-3">
		<p class="text-sm">
			Canceling ends the run on <span class="font-medium">{run.runner_name}</span>
			{#if run.issue_ref}
				working {run.issue_ref.project_name}/#{run.issue_ref.number}{/if}.
		</p>
		{#if advanced === null}
			<p class="text-muted-foreground text-xs">Checking this run's progress…</p>
		{:else if advanced}
			<p class="text-muted-foreground text-xs">
				The run already moved the issue, so canceling does not count as a strike.
			</p>
		{:else}
			<p class="text-xs text-amber-700 dark:text-amber-400">
				This run hasn't moved the issue yet — canceling counts as a strike{remaining > 0
					? `, ${remaining} remaining before it parks.`
					: ' and will park the issue.'}
			</p>
		{/if}
		<div class="space-y-1.5">
			<label class="text-sm font-medium" for="cancel-comment">Comment (optional)</label>
			<Textarea
				id="cancel-comment"
				bind:value={comment}
				rows={3}
				placeholder="Why this run was interrupted, or what to do differently…"
			/>
			<p class="text-muted-foreground text-xs">
				Posted before the cancellation, so the very next run's prompt already contains it.
			</p>
		</div>
		<div class="flex flex-wrap justify-end gap-2">
			<Button variant="ghost" disabled={canceling} onclick={onclose}>Keep running</Button>
			<PendingButton
				variant="destructive"
				pending={canceling}
				pendingLabel="Canceling…"
				disabled={advanced === null}
				onclick={confirmCancel}
			>
				Cancel run
			</PendingButton>
		</div>
	</div>
</Modal>
