<script lang="ts">
	import type {
		AgentRun,
		DispatchExplainer,
		IssueConsentReceipt,
		IssueDetail,
		ModelTier,
		Runner
	} from '@tines/shared';
	import { MODEL_TIERS } from '@tines/shared';
	import IconCheck from '@tabler/icons-svelte/icons/check';
	import IconCircleCheck from '@tabler/icons-svelte/icons/circle-check';
	import IconCircleOff from '@tabler/icons-svelte/icons/circle-off';
	import IconInfoCircle from '@tabler/icons-svelte/icons/info-circle';
	import IconPlayerPause from '@tabler/icons-svelte/icons/player-pause';
	import IconPin from '@tabler/icons-svelte/icons/pin';
	import IconRobot from '@tabler/icons-svelte/icons/robot';
	import IconX from '@tabler/icons-svelte/icons/x';
	import { slide } from 'svelte/transition';
	import { invalidateAll } from '$app/navigation';
	import { api } from '$lib/api';
	import RunRow from '$lib/components/RunRow.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Select } from '$lib/components/ui/select/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import type { Snippet } from 'svelte';
	import { prefersReducedMotion } from '$lib/format';
	import PersonalPermissionWarning from '$lib/components/PersonalPermissionWarning.svelte';

	let {
		issue,
		permission = null,
		roster = [],
		dispatch,
		runs,
		runners,
		disabledReason = null,
		ownerControls = true,
		viewerId = null,
		checklist,
		totalSpend,
		onerror
	}: {
		issue: IssueDetail;
		permission?: IssueConsentReceipt | null;
		roster?: { user: { id: string; name: string }; role: 'owner' | 'member'; value: string }[];
		dispatch: DispatchExplainer | null;
		runs: AgentRun[];
		runners: Runner[];
		/** When set, the pin controls render disabled with this as their tooltip. Cancel run stays live. */
		disabledReason?: string | null;
		/**
		 * Off for a shared project's members: runner pins and run logs belong
		 * to the owner's machines. Hold and cancel stay available.
		 */
		ownerControls?: boolean;
		/** Marks "(You)" in the roster; without it the owner row is the viewer. */
		viewerId?: string | null;
		/**
		 * The first-run checklist, before the account's first run. It replaces
		 * both the verdict-and-checks and the Runs list — its last item *is* the
		 * first run, and a second copy of that row would double the log fetches.
		 * The page owns every handler; this card stays dumb.
		 */
		checklist?: Snippet;
		totalSpend?: Snippet;
		onerror: (e: unknown) => void;
	} = $props();

	const readOnly = $derived(disabledReason != null);
	const viewerRole = $derived(ownerControls ? 'owner' : 'member');

	type Person = (typeof roster)[number];
	const isViewer = (person: Person) =>
		viewerId ? person.user.id === viewerId : person.role === 'owner';
	/**
	 * One row per person, the viewer's carrying their switch. The roster always
	 * includes the viewer on a shared issue; the fallback row only keeps the
	 * control reachable if it ever arrives without them.
	 */
	const people = $derived.by((): Person[] => {
		if (!permission || roster.some(isViewer)) return roster;
		const you: Person = {
			user: { id: viewerId ?? 'you', name: 'Me' },
			role: viewerRole,
			value: permission.my_agents.value
		};
		return viewerRole === 'owner' ? [you, ...roster] : [...roster, you];
	});

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
	let savingPermission = $state(false);
	let permissionMessage = $state<string | null>(null);
	/**
	 * The switch's position while a save is in flight, so it flips on click.
	 * Cleared once the reloaded receipt lands — which also snaps it back if
	 * the save failed.
	 */
	let pendingOn = $state<boolean | null>(null);
	async function setPermission(value: 'on' | 'off') {
		if (!permission || savingPermission) return;
		savingPermission = true;
		pendingOn = value === 'on';
		permissionMessage = null;
		try {
			const saved = await api.setIssueConsent(issue.id, {
				value,
				expected_revision: permission.my_agents.revision,
				issue_epoch: permission.my_agents.epoch,
				decision_revision: permission.issue_state.decision_revision,
				...(value === 'on' ? { disclosure_version: 1 } : {})
			});
			permissionMessage = saved.message ?? `Permission ${value === 'on' ? 'enabled' : 'disabled'}.`;
			await invalidateAll();
		} catch (e) {
			permissionMessage =
				'Permission may have changed. Review the current choice before trying again.';
			await invalidateAll();
			onerror(e);
		} finally {
			savingPermission = false;
			pendingOn = null;
		}
	}
	async function setHold(held: boolean) {
		if (!permission || savingPermission) return;
		savingPermission = true;
		try {
			const saved = await api.setIssueHold(issue.id, {
				held,
				expected_revision: permission.agent_hold.revision
			});
			permissionMessage = saved.message;
			await invalidateAll();
		} catch (e) {
			await invalidateAll();
			onerror(e);
		} finally {
			savingPermission = false;
		}
	}
	async function cancelRun(runId: string) {
		try {
			await api.cancelIssueRun(issue.id, runId);
			await invalidateAll();
		} catch (e) {
			onerror(e);
		}
	}
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
	{#if ownerControls && totalSpend}
		{@render totalSpend()}
	{/if}
	{#if permission}
		{@const open = permission.issue_state.category !== 'done'}
		<div class="mb-4 rounded-md border text-sm">
			<div class="flex min-h-10 items-center gap-2 px-3 py-1.5">
				<p class="flex-1 font-medium">Agent permission</p>
				{#if permission.agent_hold.held}
					<span
						class="flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400"
					>
						<IconPlayerPause size={12} stroke={2} /> Held
					</span>
				{/if}
				{#if open}
					<Button
						size="sm"
						variant="ghost"
						class="text-muted-foreground h-7 px-2 text-xs"
						disabled={savingPermission}
						title={permission.agent_hold.held
							? 'Let agents start new work on this issue again'
							: "Stop new work on this issue without changing anyone's permission"}
						onclick={() => setHold(!permission.agent_hold.held)}
						>{permission.agent_hold.held ? 'Release hold' : 'Hold new work'}</Button
					>
				{/if}
			</div>
			<ul class="divide-y border-t" aria-label="Issue permission roster">
				{#each people as person (person.user.id)}
					{@const you = isViewer(person)}
					{@const on =
						person.value === 'on' || (person.role === 'owner' && person.value === 'unset')}
					{@const inherited = person.role === 'owner' && person.value === 'unset'}
					<li class="flex min-h-10 items-center gap-2 px-3 py-1.5">
						<span class="min-w-0 flex-1 truncate" title={person.user.name}
							>{person.user.name}{you ? ' (You)' : ''}</span
						>
						<span class="text-muted-foreground shrink-0 text-xs">{person.role}</span>
						{#if you && open}
							<span class="flex w-20 shrink-0 items-center justify-end gap-1.5">
								{#if inherited && pendingOn === null}<span
										class="text-muted-foreground text-xs"
										title="On by default as the owner">default</span
									>{/if}
								<Switch
									aria-label="Allow my agents"
									bind:checked={() => pendingOn ?? on, (next) => setPermission(next ? 'on' : 'off')}
									disabled={savingPermission}
								/>
							</span>
						{:else}
							<span
								class="flex w-20 shrink-0 items-center justify-end gap-1 text-xs {on
									? 'text-emerald-700 dark:text-emerald-400'
									: 'text-muted-foreground'}"
								title={inherited ? 'On by default as the owner' : undefined}
							>
								{#if on}<IconCircleCheck size={14} stroke={1.75} />{:else}<IconCircleOff
										size={14}
										stroke={1.75}
									/>{/if}
								{on ? 'On' : person.value === 'off' ? 'Off' : 'Not set'}
							</span>
						{/if}
					</li>
				{/each}
			</ul>
			<div class="space-y-1 border-t px-3 py-2 text-xs">
				{#if permissionMessage}<p role="status">{permissionMessage}</p>{/if}
				{#if people.some((person) => person.role === 'member')}
					<p class="text-muted-foreground flex items-start gap-1">
						<IconInfoCircle size={14} stroke={1.75} class="mt-px shrink-0" />
						Only the owner's agents can run in this release.
					</p>
				{/if}
				<PersonalPermissionWarning role={viewerRole}>
					<p>
						Enabling lets your agents use your runner and account resources for this issue. Holding
						stops new work without changing anyone's choice. An admitted run can finish after
						permission turns off.
					</p>
				</PersonalPermissionWarning>
			</div>
		</div>
	{/if}

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
										{target.effort_verification === 'asserted' ? ' (asserted effort)' : ''}
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
	{#if ownerControls}<div class="mt-4 border-t pt-3">
			<p class="text-muted-foreground mb-1.5 flex items-center gap-1 text-xs font-medium">
				<IconPin size={12} stroke={1.75} /> Pin to a runner
			</p>
			{#if runners.length === 0}
				<p class="text-muted-foreground text-xs italic">No runners registered yet.</p>
			{:else}
				<p class="text-muted-foreground mb-1.5 text-xs">No pin uses routing rules.</p>
				<div class="grid min-w-0 gap-1.5">
					<Select
						class="h-8 w-full min-w-0 text-xs"
						bind:value={pinRunnerId}
						aria-label="Pinned runner"
					>
						<option value="">No pin</option>
						{#each runners as runner (runner.id)}
							<option value={runner.id}
								>{runner.name}{runner.status === 'paused' ? ' (paused)' : ''}</option
							>
						{/each}
					</Select>
					<div class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5">
						<Select
							class="h-8 w-full min-w-0 text-xs"
							bind:value={pinTier}
							aria-label="Pinned tier"
							disabled={!pinRunnerId || readOnly}
							title={disabledReason}
						>
							<option value="">Default tier</option>
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
		</div>{/if}

	<!-- this issue's runs (the checklist's last item shows them instead) -->
	{#if !checklist}
		<div class="mt-4 border-t pt-3">
			<p class="text-muted-foreground mb-1.5 text-xs font-medium">Runs</p>
			{#if runs.length === 0}
				<p class="text-muted-foreground text-xs italic">No runs yet.</p>
			{:else}
				<ul class="divide-y rounded-lg border">
					{#each runs as run (run.id)}
						<RunRow
							{run}
							showLogs={ownerControls}
							showCost={ownerControls}
							oncancel={permission ? () => cancelRun(run.id) : undefined}
						/>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</section>
