<script lang="ts">
	import type { AgentRun, DispatchExplainer, IssueDetail, ModelTier, Runner } from '@tines/shared';
	import { MODEL_TIERS } from '@tines/shared';
	import IconCheck from '@tabler/icons-svelte/icons/check';
	import IconPin from '@tabler/icons-svelte/icons/pin';
	import IconRobot from '@tabler/icons-svelte/icons/robot';
	import IconX from '@tabler/icons-svelte/icons/x';
	import { slide } from 'svelte/transition';
	import { invalidateAll } from '$app/navigation';
	import { api } from '$lib/api';
	import RunRow from '$lib/components/RunRow.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Select } from '$lib/components/ui/select/index.js';
	import type { Snippet } from 'svelte';
	import { prefersReducedMotion } from '$lib/format';

	let {
		issue,
		dispatch,
		runs,
		runners,
		disabledReason = null,
		checklist,
		onerror
	}: {
		issue: IssueDetail;
		dispatch: DispatchExplainer | null;
		runs: AgentRun[];
		runners: Runner[];
		/** When set, the pin controls render disabled with this as their tooltip. Cancel run stays live. */
		disabledReason?: string | null;
		/**
		 * The first-run checklist, before the account's first run. It replaces
		 * both the verdict-and-checks and the Runs list — its last item *is* the
		 * first run, and a second copy of that row would double the log fetches.
		 * The page owns every handler; this card stays dumb.
		 */
		checklist?: Snippet;
		onerror: (e: unknown) => void;
	} = $props();

	const readOnly = $derived(disabledReason != null);

	const dur = () => (prefersReducedMotion() ? 0 : 180);

	// --- pin control ------------------------------------------------------------

	// svelte-ignore state_referenced_locally
	let pinRunnerId = $state(issue.pinned_runner_id ?? '');
	// svelte-ignore state_referenced_locally
	let pinTier = $state<'' | ModelTier>(issue.pinned_tier ?? '');
	$effect(() => {
		pinRunnerId = issue.pinned_runner_id ?? '';
		pinTier = issue.pinned_tier ?? '';
	});
	const pinDirty = $derived(
		pinRunnerId !== (issue.pinned_runner_id ?? '') || pinTier !== (issue.pinned_tier ?? '')
	);

	let savingPin = $state(false);
	async function savePin() {
		if (savingPin) return;
		savingPin = true;
		try {
			await api.updateIssue(issue.id, {
				pinned_runner_id: pinRunnerId || null,
				pinned_tier: pinRunnerId && pinTier ? pinTier : null
			});
			await invalidateAll();
		} catch (e) {
			onerror(e);
		} finally {
			savingPin = false;
		}
	}
</script>

<section class="rounded-lg border p-4">
	<h2 class="mb-3 flex items-center gap-1.5 text-sm font-semibold">
		<IconRobot size={16} stroke={1.75} /> Agent activity
	</h2>

	{#if checklist}
		{@render checklist()}
	{:else if dispatch}
		<!-- the one-line verdict -->
		<p class="text-sm {dispatch.parked ? 'font-medium text-amber-700 dark:text-amber-400' : ''}">
			{dispatch.verdict}
		</p>

		<!-- the full explainer -->
		<details class="group mt-2">
			<summary
				class="text-muted-foreground hover:text-foreground cursor-pointer text-xs select-none"
			>
				Why?
			</summary>
			<div class="mt-2 space-y-2 text-xs" transition:slide={{ duration: dur() }}>
				<ul class="space-y-1">
					{#each dispatch.checks as check (check.name)}
						<li class="flex items-start gap-1.5">
							{#if check.ok}
								<IconCheck
									size={14}
									class="mt-px shrink-0 text-emerald-600 dark:text-emerald-400"
								/>
							{:else}
								<IconX size={14} class="mt-px shrink-0 text-amber-700 dark:text-amber-400" />
							{/if}
							<span class={check.ok ? 'text-muted-foreground' : ''}>
								{check.detail}
								{#if check.action}
									{#if check.action.href}
										<a href={check.action.href} class="ml-1 underline underline-offset-2"
											>{check.action.label}</a
										>
									{:else if check.action.cli}
										<code class="bg-muted ml-1 rounded px-1 py-0.5">{check.action.cli}</code>
									{/if}
								{/if}
							</span>
						</li>
					{/each}
				</ul>
				{#if dispatch.matched_rule}
					<p class="text-muted-foreground">
						Matched rule: <span class="text-foreground font-medium"
							>{dispatch.matched_rule.scope_label}</span
						>
					</p>
				{/if}
				{#if dispatch.tier_override}
					<p class="text-muted-foreground">
						Tier override: <span class="text-foreground font-medium">{dispatch.tier_override}</span>
						{#if dispatch.runner_rule}
							· runners from <span class="text-foreground font-medium"
								>{dispatch.runner_rule.scope_label}</span
							>{/if}
					</p>
				{/if}
				{#if dispatch.targets.length > 0}
					<div>
						<p class="text-muted-foreground mb-1">Targets, in preference order:</p>
						<ul class="space-y-1">
							{#each dispatch.targets as target, i (target.runner_id + i)}
								<li class="flex flex-wrap items-center gap-x-1.5">
									<span class="font-medium">{target.runner_name}</span>
									<span class="text-muted-foreground">
										{target.tier}{target.model ? ` → ${target.model}` : ''}
									</span>
									{#if target.verdict === 'ok'}
										<span class="text-emerald-600 dark:text-emerald-400">available</span>
									{:else}
										<span class="text-amber-700 dark:text-amber-400" title={target.detail}>
											{target.verdict.replaceAll('_', ' ')}
										</span>
									{/if}
								</li>
							{/each}
						</ul>
					</div>
				{/if}
				{#if dispatch.queue_position !== null && dispatch.queue_position > 0}
					<p class="text-muted-foreground">
						{dispatch.queue_position} eligible issue{dispatch.queue_position === 1 ? '' : 's'} ahead of
						this one in the queue.
					</p>
				{/if}
				{#if dispatch.attempt_count > 0 && !dispatch.parked}
					<p class="text-muted-foreground">
						{dispatch.attempt_count}/{dispatch.attempt_limit} strikes — parks at the limit.
					</p>
				{/if}
			</div>
		</details>
	{/if}

	<!-- pin control: replaces rule matching entirely for this issue -->
	<div class="mt-4 border-t pt-3">
		<p class="text-muted-foreground mb-1.5 flex items-center gap-1 text-xs font-medium">
			<IconPin size={12} stroke={1.75} /> Pin to a runner
		</p>
		{#if runners.length === 0}
			<p class="text-muted-foreground text-xs italic">No runners registered yet.</p>
		{:else}
			<div class="flex items-center gap-1.5">
				<Select class="h-8 flex-1 text-xs" bind:value={pinRunnerId} aria-label="Pinned runner">
					<option value="">No pin — routing rules apply</option>
					{#each runners as runner (runner.id)}
						<option value={runner.id}
							>{runner.name}{runner.status === 'paused' ? ' (paused)' : ''}</option
						>
					{/each}
				</Select>
				<Select
					class="h-8 w-28 text-xs"
					bind:value={pinTier}
					aria-label="Pinned tier"
					disabled={!pinRunnerId || readOnly}
					title={disabledReason}
				>
					<option value="">default tier</option>
					{#each MODEL_TIERS as tier (tier)}
						<option value={tier}>{tier}</option>
					{/each}
				</Select>
				<Button
					size="sm"
					variant="outline"
					class="h-8"
					disabled={!pinDirty || savingPin || readOnly}
					title={disabledReason}
					onclick={savePin}
				>
					{savingPin ? '…' : 'Save'}
				</Button>
			</div>
			{#if issue.pinned_runner_id}
				<p
					class="mt-1.5 text-xs text-amber-700 dark:text-amber-400"
					transition:slide={{ duration: dur() }}
				>
					Pinned to {issue.pinned_runner_name}{issue.pinned_tier ? `:${issue.pinned_tier}` : ''} — only
					this runner will take it.
				</p>
			{/if}
		{/if}
	</div>

	<!-- this issue's runs (the checklist's last item shows them instead) -->
	{#if !checklist}
		<div class="mt-4 border-t pt-3">
			<p class="text-muted-foreground mb-1.5 text-xs font-medium">Runs</p>
			{#if runs.length === 0}
				<p class="text-muted-foreground text-xs italic">No runs yet.</p>
			{:else}
				<ul class="divide-y rounded-lg border">
					{#each runs as run (run.id)}
						<RunRow {run} />
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</section>
