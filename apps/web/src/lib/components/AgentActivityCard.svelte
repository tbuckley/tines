<script lang="ts">
	import type { AgentRun, DispatchExplainer, IssueDetail, ModelTier, Runner } from '@tines/shared';
	import { MODEL_TIERS, runDurationLabel } from '@tines/shared';
	import IconAlertTriangle from '@tabler/icons-svelte/icons/alert-triangle';
	import IconCheck from '@tabler/icons-svelte/icons/check';
	import IconPin from '@tabler/icons-svelte/icons/pin';
	import IconRobot from '@tabler/icons-svelte/icons/robot';
	import IconX from '@tabler/icons-svelte/icons/x';
	import { slide } from 'svelte/transition';
	import { invalidateAll } from '$app/navigation';
	import { api } from '$lib/api';
	import RunLogViewer from '$lib/components/RunLogViewer.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Select } from '$lib/components/ui/select/index.js';
	import { prefersReducedMotion, relativeTime, runStatusClass } from '$lib/format';

	let {
		issue,
		dispatch,
		runs,
		runners,
		onerror
	}: {
		issue: IssueDetail;
		dispatch: DispatchExplainer | null;
		runs: AgentRun[];
		runners: Runner[];
		onerror: (e: unknown) => void;
	} = $props();

	const dur = () => (prefersReducedMotion() ? 0 : 180);

	const ACTIVE_STATUSES = ['assigned', 'launching', 'running'];

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

	/** Runs expanded to their log-tail viewer. */
	let expandedLogs = $state<Record<string, boolean>>({});
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

	{#if dispatch}
		<!-- the one-line verdict -->
		<p class="text-sm {dispatch.parked ? 'font-medium text-amber-700 dark:text-amber-400' : ''}">
			{dispatch.verdict}
		</p>

		<!-- the full explainer -->
		<details class="group mt-2">
			<summary class="text-muted-foreground hover:text-foreground cursor-pointer text-xs select-none">
				Why?
			</summary>
			<div class="mt-2 space-y-2 text-xs" transition:slide={{ duration: dur() }}>
				<ul class="space-y-1">
					{#each dispatch.checks as check (check.name)}
						<li class="flex items-start gap-1.5">
							{#if check.ok}
								<IconCheck size={14} class="mt-px shrink-0 text-emerald-600 dark:text-emerald-400" />
							{:else}
								<IconX size={14} class="mt-px shrink-0 text-amber-700 dark:text-amber-400" />
							{/if}
							<span class={check.ok ? 'text-muted-foreground' : ''}>{check.detail}</span>
						</li>
					{/each}
				</ul>
				{#if dispatch.matched_rule}
					<p class="text-muted-foreground">
						Matched rule: <span class="text-foreground font-medium">{dispatch.matched_rule.scope_label}</span>
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
						<option value={runner.id}>{runner.name}{runner.status === 'paused' ? ' (paused)' : ''}</option>
					{/each}
				</Select>
				<Select
					class="h-8 w-28 text-xs"
					bind:value={pinTier}
					aria-label="Pinned tier"
					disabled={!pinRunnerId}
				>
					<option value="">default tier</option>
					{#each MODEL_TIERS as tier (tier)}
						<option value={tier}>{tier}</option>
					{/each}
				</Select>
				<Button size="sm" variant="outline" class="h-8" disabled={!pinDirty || savingPin} onclick={savePin}>
					{savingPin ? '…' : 'Save'}
				</Button>
			</div>
			{#if issue.pinned_runner_id}
				<p class="mt-1.5 text-xs text-amber-700 dark:text-amber-400" transition:slide={{ duration: dur() }}>
					Pinned to {issue.pinned_runner_name}{issue.pinned_tier ? `:${issue.pinned_tier}` : ''} — only
					this runner will take it.
				</p>
			{/if}
		{/if}
	</div>

	<!-- this issue's runs -->
	<div class="mt-4 border-t pt-3">
		<p class="text-muted-foreground mb-1.5 text-xs font-medium">Runs</p>
		{#if runs.length === 0}
			<p class="text-muted-foreground text-xs italic">No runs yet.</p>
		{:else}
			<ul class="space-y-1.5">
				{#each runs as run (run.id)}
					<li class="text-xs" transition:slide={{ duration: dur() }}>
						<div class="flex flex-wrap items-center gap-x-1.5">
							{#if ACTIVE_STATUSES.includes(run.status)}
								<span class="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500"></span>
							{/if}
							<span class="font-medium">{run.runner_name}</span>
							<span class="text-muted-foreground">{run.tier}{run.model ? ` · ${run.model}` : ''}</span>
							<span class={runStatusClass(run.status)}>{run.status.replaceAll('_', ' ')}</span>
							{#if run.started_at}
								<span class="text-muted-foreground">· {runDurationLabel(run)}</span>
							{/if}
							<span class="text-muted-foreground ml-auto" title={new Date(run.created_at).toLocaleString()}>
								{relativeTime(run.created_at)}
							</span>
							<button
								type="button"
								class="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
								aria-expanded={expandedLogs[run.id] === true}
								onclick={() => (expandedLogs = { ...expandedLogs, [run.id]: !expandedLogs[run.id] })}
							>
								{expandedLogs[run.id] ? 'hide logs' : 'logs'}
							</button>
						</div>
						{#if run.error}
							<p class="text-muted-foreground mt-0.5 flex items-start gap-1">
								<IconAlertTriangle size={12} class="mt-px shrink-0 text-amber-600 dark:text-amber-400" />
								{run.error}
							</p>
						{/if}
						{#if expandedLogs[run.id]}
							<div transition:slide={{ duration: dur() }}>
								<RunLogViewer runId={run.id} />
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</section>
