<script lang="ts">
	import type { FleetQueue, QueueBinding, QueueGroup, QueueVerdict, Runner } from '@tines/shared';
	import IconAlertTriangle from '@tabler/icons-svelte/icons/alert-triangle';
	import IconClock from '@tabler/icons-svelte/icons/clock';
	import PendingButton from '$lib/components/PendingButton.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { queueAge, relativeTime } from '$lib/format';
	import { waitingCountsByState } from '$lib/queue';

	/**
	 * The Now row (Tines/256): every eligible issue with no active run, grouped
	 * by *why* it is waiting, with each verdict's remedy offered as a control
	 * rather than described in prose.
	 *
	 * Every callback is optional, the house convention from `RoutingRuleRow`:
	 * omitted → the block renders read-only.
	 */
	let {
		queue,
		runners,
		now = Date.now(),
		onraisecap,
		onquota,
		onswitchtoroster,
		onaddrule,
		oneditrule,
		onresumerunner,
		onresume,
		onenable
	}: {
		queue: FleetQueue;
		runners: Runner[];
		now?: number;
		/** `at_capacity` — open the runner editor with Max concurrent focused. */
		onraisecap?: (runner: Runner) => void;
		/** `quota_exhausted` — focus the quota editor, highlighting the binding row. */
		onquota?: (target: { stateId: string | null; binding: QueueBinding | null }) => void;
		/** Global cap binding — switch to a per-state roster, prefilled from the queue. */
		onswitchtoroster?: (prefill: Record<string, number>) => void;
		onaddrule?: (stateId: string) => void;
		oneditrule?: (ruleId: string) => void;
		onresumerunner?: (runner: Runner) => void;
		onresume?: (issueId: string) => Promise<void>;
		onenable?: () => void;
	} = $props();

	const runnerById = $derived(new Map(runners.map((r) => [r.id, r])));

	/** The parked issue whose Resume is in flight. */
	let resumingId = $state<string | null>(null);

	async function resume(issueId: string) {
		if (!onresume) return;
		resumingId = issueId;
		try {
			await onresume(issueId);
		} finally {
			resumingId = null;
		}
	}

	/**
	 * The API keys groups by `{state, verdict, runner}` so Part 3's annotations
	 * can join on a state or a rule; the panel reads better aggregated one level
	 * up, since every state behind the same offline runner has the same remedy.
	 */
	type Block = {
		key: string;
		verdict: QueueVerdict;
		runnerId: string | null;
		runnerName: string | null;
		detail: string;
		binding: QueueBinding | null;
		ruleId: string | null;
		ambiguousRuleIds: string[];
		count: number;
		oldest: number;
		groups: QueueGroup[];
	};

	const blocks = $derived.by((): Block[] => {
		const byKey = new Map<string, Block>();
		for (const g of queue.groups) {
			const key = `${g.verdict}|${g.runner_id ?? ''}`;
			const existing = byKey.get(key);
			if (existing) {
				existing.count += g.count;
				existing.oldest = Math.min(existing.oldest, g.oldest_entered_at);
				existing.groups.push(g);
				existing.binding ??= g.binding;
				for (const id of g.ambiguous_rule_ids) {
					if (!existing.ambiguousRuleIds.includes(id)) existing.ambiguousRuleIds.push(id);
				}
				existing.ruleId ??= g.rule_id;
				continue;
			}
			byKey.set(key, {
				key,
				verdict: g.verdict,
				runnerId: g.runner_id,
				runnerName: g.runner_name,
				detail: g.detail,
				binding: g.binding,
				ruleId: g.rule_id,
				ambiguousRuleIds: [...g.ambiguous_rule_ids],
				count: g.count,
				oldest: g.oldest_entered_at,
				groups: [g]
			});
		}
		return [...byKey.values()].sort((a, b) => b.count - a.count || a.oldest - b.oldest);
	});

	/** Automation off is one line, not a list: the banner above already says it. */
	const automationOff = $derived(!queue.automation_enabled && queue.waiting > 0);

	function headline(b: Block): string {
		const runner = b.runnerName ?? 'the routed runner';
		switch (b.verdict) {
			case 'ok':
				return 'dispatching next pass';
			case 'at_capacity':
				return b.binding?.kind === 'max_concurrent'
					? `at capacity on ${runner} (${b.binding.current}/${b.binding.limit})`
					: `at capacity on ${runner}`;
			case 'quota_exhausted':
				if (b.binding?.kind === 'global_cap')
					return `global cap reached (${b.binding.current}/${b.binding.limit})`;
				if (b.binding?.kind === 'state_roster')
					return `roster limit reached (${b.binding.current}/${b.binding.limit})`;
				return 'quota exhausted';
			case 'offline':
				return `${runner} offline`;
			case 'paused':
				return `${runner} paused`;
			case 'draining':
				return `${runner} draining`;
			case 'backing_off':
				return `${runner} backing off`;
			case 'no_rule':
				return 'no matching routing rule';
			case 'no_targets':
				return 'the matching rule has no targets';
			case 'ambiguous_rule':
				return 'two routing rules tie';
			case 'pin_missing':
				return 'pinned to a runner that is gone';
			case 'automation_off':
				return 'automation is off';
			case 'parked':
				return 'parked';
		}
	}
</script>

<section class="mb-10" aria-labelledby="queue-heading">
	<div class="mb-3 flex items-center justify-between">
		<h2 id="queue-heading" class="flex items-center gap-2 text-sm font-semibold">
			<IconClock size={14} stroke={1.75} />
			Waiting for an agent — {queue.waiting}
			{queue.waiting === 1 ? 'issue' : 'issues'}
		</h2>
	</div>

	{#if automationOff}
		<div
			class="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-300"
		>
			<span class="flex flex-wrap items-center justify-between gap-3">
				<span class="flex items-center gap-2">
					<IconAlertTriangle size={16} stroke={1.75} />
					Automation is off — {queue.waiting} eligible
					{queue.waiting === 1 ? 'issue is' : 'issues are'} waiting.
				</span>
				{#if onenable}
					<Button size="sm" onclick={() => onenable()}>Turn on</Button>
				{/if}
			</span>
		</div>
	{:else if queue.waiting === 0 && queue.parked.count === 0}
		<p class="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
			Nothing waiting — every eligible issue has a run.
		</p>
	{:else}
		<ul class="divide-y rounded-lg border">
			{#each blocks as block (block.key)}
				{@const runner = block.runnerId ? runnerById.get(block.runnerId) : undefined}
				<li class="px-4 py-3" id={block.runnerId ? `queue-runner-${block.runnerId}` : undefined}>
					<div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
						<div class="min-w-0">
							<p class="text-sm font-medium">
								{block.count}
								{block.count === 1 ? 'issue' : 'issues'} · {headline(block)}
							</p>
							<p class="text-muted-foreground mt-0.5 text-xs">
								oldest {queueAge(block.oldest, now)}{block.detail ? ` · ${block.detail}` : ''}
							</p>
							{#if block.verdict === 'offline'}
								<p class="text-muted-foreground mt-1 text-xs">
									Start the daemon on the machine that registered {block.runnerName ?? 'it'}:
									<code class="bg-muted rounded px-1 py-0.5">tines runner daemon</code>
									{#if runner?.last_seen_at}
										· last seen {relativeTime(runner.last_seen_at, now)}
									{/if}
								</p>
							{:else if block.verdict === 'backing_off'}
								<p class="text-muted-foreground mt-1 text-xs">
									Retries automatically; check the daemon log if it keeps failing.
								</p>
							{/if}
						</div>
						<span class="flex shrink-0 flex-wrap gap-1">
							{#if block.verdict === 'at_capacity' && runner && onraisecap}
								<Button size="sm" onclick={() => onraisecap(runner)}>
									Raise cap on {runner.name}
								</Button>
							{/if}
							{#if block.verdict === 'at_capacity' && onquota}
								<Button
									size="sm"
									variant="ghost"
									onclick={() =>
										onquota({ stateId: block.groups[0]?.state_id ?? null, binding: block.binding })}
								>
									Quota policy
								</Button>
							{/if}
							{#if block.verdict === 'quota_exhausted' && block.binding?.kind === 'global_cap'}
								{#if onquota}
									<Button
										size="sm"
										onclick={() => onquota({ stateId: null, binding: block.binding })}
									>
										Raise global cap
									</Button>
								{/if}
								{#if onswitchtoroster}
									<Button
										size="sm"
										variant="ghost"
										onclick={() =>
											onswitchtoroster(
												// Waiting counts per state, summed across the groups that
												// share one (a state can appear in several); the page adds
												// the runs already active in each, which only it has to hand.
												waitingCountsByState(queue.groups)
											)}
									>
										Switch to per-state roster
									</Button>
								{/if}
							{/if}
							{#if block.verdict === 'quota_exhausted' && block.binding?.kind === 'state_roster' && onquota}
								<Button
									size="sm"
									onclick={() =>
										onquota({ stateId: block.groups[0]?.state_id ?? null, binding: block.binding })}
								>
									Edit roster row
								</Button>
							{/if}
							{#if block.verdict === 'paused' && runner && onresumerunner}
								<Button size="sm" onclick={() => onresumerunner(runner)}
									>Resume {runner.name}</Button
								>
							{/if}
							{#if block.verdict === 'no_rule' && onaddrule}
								<Button size="sm" onclick={() => onaddrule(block.groups[0].state_id)}>
									Add rule for {block.groups[0].state_name}
								</Button>
							{/if}
							{#if block.verdict === 'no_targets' && block.ruleId && oneditrule}
								{@const ruleId = block.ruleId}
								<Button size="sm" onclick={() => oneditrule(ruleId)}>Add targets</Button>
							{/if}
							{#if block.verdict === 'ambiguous_rule' && block.ambiguousRuleIds.length > 0 && oneditrule}
								{@const ruleId = block.ambiguousRuleIds[0]}
								<Button size="sm" onclick={() => oneditrule(ruleId)}
									>Make a rule more specific</Button
								>
							{/if}
						</span>
					</div>
					<ul class="mt-2 space-y-1">
						{#each block.groups as group (group.state_id)}
							<li id="queue-{group.state_id}" class="text-muted-foreground text-xs">
								<span class="text-foreground font-medium">{group.state_name}</span>
								· {group.count} waiting · oldest {queueAge(group.oldest_entered_at, now)}
								<span class="ml-1">
									{#each group.issues as issue (issue.id)}
										<a
											class="hover:text-foreground mr-1 underline underline-offset-2"
											href="/issues/{issue.id}"
											title={issue.title}
										>
											{issue.project_name}/{issue.number}
										</a>
									{/each}
									{#if group.count > group.issues.length}
										<span>+{group.count - group.issues.length} more</span>
									{/if}
								</span>
							</li>
						{/each}
					</ul>
				</li>
			{/each}

			{#if queue.parked.count > 0}
				<li class="px-4 py-3" id="queue-parked">
					<p class="text-sm font-medium">
						{queue.parked.count} parked
						{#if queue.parked.oldest_entered_at !== null}
							· oldest {queueAge(queue.parked.oldest_entered_at, now)}
						{/if}
					</p>
					<p class="text-muted-foreground mt-0.5 text-xs">
						Parked issues need a human before an agent picks them up again.
					</p>
					<ul class="mt-2 space-y-1">
						{#each queue.parked.issues as issue (issue.id)}
							<li class="flex items-center gap-2 text-xs">
								<a
									class="hover:text-foreground underline underline-offset-2"
									href="/issues/{issue.id}"
									title={issue.title}
								>
									{issue.project_name}/{issue.number}
								</a>
								<span class="text-muted-foreground truncate">{issue.title}</span>
								{#if onresume}
									<PendingButton
										size="sm"
										variant="ghost"
										class="ml-auto"
										pending={resumingId === issue.id}
										onclick={() => resume(issue.id)}
										pendingLabel="Resuming…"
									>
										Resume
									</PendingButton>
								{/if}
							</li>
						{/each}
					</ul>
				</li>
			{/if}
		</ul>
	{/if}

	{#if queue.awaiting_human.count > 0}
		<p class="text-muted-foreground mt-2 text-xs">
			Awaiting you: {queue.awaiting_human.count}
			{queue.awaiting_human.count === 1 ? 'issue' : 'issues'}
			{#if queue.awaiting_human.oldest_entered_at !== null}
				· oldest {queueAge(queue.awaiting_human.oldest_entered_at, now)}
			{/if}
		</p>
	{/if}
</section>
