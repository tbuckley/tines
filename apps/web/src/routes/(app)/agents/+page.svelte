<script lang="ts">
	import type { AgentRun, ModelTier, RoutingRule, RoutingTarget, Runner, ShadowWarning } from '@tines/shared';
	import { ACTIVE_RUN_STATUSES, ApiError, MODEL_TIERS, runDurationLabel, utilizationLabel } from '@tines/shared';
	import IconAlertTriangle from '@tabler/icons-svelte/icons/alert-triangle';
	import IconArrowDown from '@tabler/icons-svelte/icons/arrow-down';
	import IconArrowRight from '@tabler/icons-svelte/icons/arrow-right';
	import IconArrowUp from '@tabler/icons-svelte/icons/arrow-up';
	import IconCloud from '@tabler/icons-svelte/icons/cloud';
	import IconCopy from '@tabler/icons-svelte/icons/copy';
	import IconDeviceLaptop from '@tabler/icons-svelte/icons/device-laptop';
	import IconKey from '@tabler/icons-svelte/icons/key';
	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import IconRobot from '@tabler/icons-svelte/icons/robot';
	import IconTrash from '@tabler/icons-svelte/icons/trash';
	import IconX from '@tabler/icons-svelte/icons/x';
	import { slide } from 'svelte/transition';
	import { invalidateAll } from '$app/navigation';
	import { api } from '$lib/api';
	import CancelRunDialog from '$lib/components/CancelRunDialog.svelte';
	import ContextScopeChips from '$lib/components/ContextScopeChips.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import RunLogViewer from '$lib/components/RunLogViewer.svelte';
	import StateBadge from '$lib/components/StateBadge.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Select } from '$lib/components/ui/select/index.js';
	import { prefersReducedMotion, relativeTime, runStatusClass } from '$lib/format';

	let { data } = $props();

	const dur = () => (prefersReducedMotion() ? 0 : 180);

	let errorMessage = $state<string | null>(null);
	function showError(e: unknown) {
		errorMessage = e instanceof ApiError ? e.message : 'Something went wrong — try again.';
		setTimeout(() => (errorMessage = null), 8000);
	}

	// --- kill switch -------------------------------------------------------------

	let togglingEnabled = $state(false);
	let disableConfirmOpen = $state(false);
	/** Runs the switch alone would leave finishing (assigned ones cancel free). */
	const inFlightRuns = $derived(
		data.runs.filter((r) => r.status === 'launching' || r.status === 'running')
	);

	async function setEnabled(on: boolean, cancelInFlight = false) {
		if (togglingEnabled) return;
		togglingEnabled = true;
		try {
			await api.updateSupervisorSettings({
				enabled: on,
				...(cancelInFlight ? { cancel_in_flight: true } : {})
			});
			disableConfirmOpen = false;
			await invalidateAll();
		} catch (err) {
			showError(err);
		} finally {
			togglingEnabled = false;
		}
	}

	/** Turning off is usually a panic action: offer the bulk cancel when work is in flight. */
	function requestDisable() {
		if (inFlightRuns.length > 0) disableConfirmOpen = true;
		else void setEnabled(false);
	}

	// --- runners -----------------------------------------------------------------

	function runnerStatusLabel(runner: Runner): string {
		if (runner.status === 'paused') return 'paused';
		return runner.online ? 'online' : 'offline';
	}

	function statusDotClass(runner: Runner): string {
		if (runner.status === 'paused') return 'bg-amber-500';
		return runner.online ? 'bg-emerald-500' : 'bg-muted-foreground/40';
	}

	// The add-runner wizard shows the bootstrap command — the daemon registers
	// itself on first start, so nothing is created here.
	let addRunnerOpen = $state(false);
	let runnerName = $state('');
	let runnerHarness = $state('claude-code');
	let runnerCommand = $state('');
	let runnerMaxConcurrent = $state(1);
	let commandCopied = $state(false);

	const bootstrapCommand = $derived.by(() => {
		const origin = typeof location !== 'undefined' ? location.origin : '<tines-url>';
		const parts = [
			'TINES_API_KEY=<your-api-key>',
			'tines runner daemon',
			`--url ${origin}`,
			`--name ${runnerName.trim() || '<name>'}`,
			`--harness ${runnerHarness}`
		];
		if (runnerHarness === 'custom') {
			parts.push(`--command '${(runnerCommand || '<template>').replaceAll("'", `'\\''`)}'`);
		}
		if (runnerMaxConcurrent !== 1) parts.push(`--max-concurrent ${runnerMaxConcurrent}`);
		return parts.join(' \\\n  ');
	});

	async function copyBootstrapCommand() {
		try {
			await navigator.clipboard.writeText(bootstrapCommand);
			commandCopied = true;
			setTimeout(() => (commandCopied = false), 2000);
		} catch {
			// Clipboard unavailable (permissions): the text stays selectable.
		}
	}

	// --- rotate-token: invalidate in place, show the new token exactly once ------

	let rotatedToken = $state<{ runnerName: string; token: string } | null>(null);
	let tokenModalOpen = $state(false);
	/** The runner awaiting rotate confirmation. */
	let rotateTarget = $state<Runner | null>(null);
	let rotatingRunnerId = $state<string | null>(null);

	async function rotateToken(runner: Runner) {
		rotatingRunnerId = runner.id;
		try {
			const rotated = await api.rotateRunnerToken(runner.id);
			rotateTarget = null;
			rotatedToken = { runnerName: rotated.runner.name, token: rotated.runner_token };
			tokenModalOpen = true;
			await invalidateAll();
		} catch (err) {
			showError(err);
		} finally {
			rotatingRunnerId = null;
		}
	}

	async function setRunnerStatus(runner: Runner, status: 'active' | 'paused') {
		try {
			await api.updateRunner(runner.id, { status });
			await invalidateAll();
		} catch (err) {
			showError(err);
		}
	}

	async function removeRunner(runner: Runner) {
		if (
			!confirm(
				`Remove runner "${runner.name}"? Its run history goes with it. (Pausing keeps identity, rules, and history warm instead.)`
			)
		)
			return;
		try {
			await api.deleteRunner(runner.id);
			await invalidateAll();
		} catch (err) {
			// Reject-by-default: the 422 names referencing rules and pins; offer
			// the force cascade (emptied rules are kept, flagged "no targets").
			if (err instanceof ApiError && err.code === 'runner_referenced') {
				if (confirm(`${err.message}\n\nStrip these references and remove the runner?`)) {
					try {
						await api.deleteRunner(runner.id, { force: true });
						await invalidateAll();
					} catch (err2) {
						showError(err2);
					}
				}
				return;
			}
			showError(err);
		}
	}

	// --- runs --------------------------------------------------------------------

	let showAllRuns = $state(false);
	const activeRuns = $derived(
		data.runs.filter((r) => (ACTIVE_RUN_STATUSES as readonly string[]).includes(r.status))
	);
	const visibleRuns = $derived(showAllRuns ? data.runs : activeRuns);

	/** Utilization against the active policy — same math the CLI status shows. */
	const utilization = $derived.by(() => {
		const stateNames = new Map(
			data.workflows.flatMap((w) => w.states.map((s) => [s.id, s.name] as const))
		);
		return utilizationLabel(data.settings.quota, activeRuns, (id) => stateNames.get(id) ?? id);
	});

	/** Run rows expanded to their log-tail viewer. */
	let expandedLogs = $state<Record<string, boolean>>({});

	/** The run awaiting the cancel dialog (strike note + optional comment). */
	let cancelTarget = $state<AgentRun | null>(null);

	// --- routing rules -----------------------------------------------------------

	let ruleModalOpen = $state(false);
	let editingRule = $state<RoutingRule | null>(null);
	let ruleProjectId = $state('');
	let ruleStateId = $state('');
	let ruleTargets = $state<{ runner_id: string; tier: '' | ModelTier }[]>([]);
	let savingRule = $state(false);
	let ruleWarnings = $state<ShadowWarning[]>([]);

	function openRuleCreate() {
		// Shadow hints belong to the last save; opening an editor stales them.
		ruleWarnings = [];
		editingRule = null;
		ruleProjectId = '';
		ruleStateId = '';
		ruleTargets = data.runners.length > 0 ? [{ runner_id: data.runners[0].id, tier: '' }] : [];
		ruleModalOpen = true;
	}

	function openRuleEdit(rule: RoutingRule) {
		ruleWarnings = [];
		editingRule = rule;
		ruleProjectId = rule.scope.project_id ?? '';
		ruleStateId = rule.scope.workflow_state_id ?? '';
		ruleTargets = rule.targets.map((t) => ({ runner_id: t.runner_id, tier: t.tier ?? '' }));
		ruleModalOpen = true;
	}

	function moveTarget(index: number, delta: number) {
		const next = [...ruleTargets];
		const [entry] = next.splice(index, 1);
		next.splice(index + delta, 0, entry);
		ruleTargets = next;
	}

	async function saveRule(e: SubmitEvent) {
		e.preventDefault();
		if (savingRule) return;
		savingRule = true;
		try {
			const targets: RoutingTarget[] = ruleTargets.map((t) =>
				t.tier ? { runner_id: t.runner_id, tier: t.tier } : { runner_id: t.runner_id }
			);
			const scope = { project_id: ruleProjectId || null, workflow_state_id: ruleStateId || null };
			const saved = editingRule
				? await api.updateRoutingRule(editingRule.id, { ...scope, targets })
				: await api.createRoutingRule({ ...scope, targets });
			// Shadow hints surface at authoring time, right where the rule was saved.
			ruleWarnings = saved.warnings;
			ruleModalOpen = false;
			await invalidateAll();
		} catch (err) {
			showError(err);
		} finally {
			savingRule = false;
		}
	}

	async function deleteRule(rule: RoutingRule) {
		if (!confirm(`Delete the ${rule.scope.label} routing rule? Issues it matched stop dispatching.`)) return;
		try {
			await api.deleteRoutingRule(rule.id);
			ruleWarnings = [];
			await invalidateAll();
		} catch (err) {
			showError(err);
		}
	}

	// --- automation settings -----------------------------------------------------

	let quotaType = $state<'global_cap' | 'state_roster'>('global_cap');
	let globalLimit = $state(3);
	let rosterDefault = $state(1);
	/** Per-state inputs as strings; '' = inherit the default. */
	let rosterOverrides = $state<Record<string, string>>({});
	let attemptLimit = $state(3);
	let savingSettings = $state(false);

	$effect(() => {
		const quota = data.settings.quota;
		quotaType = quota.type;
		if (quota.type === 'global_cap') {
			globalLimit = quota.limit;
			rosterDefault = 1;
			rosterOverrides = {};
		} else {
			globalLimit = 3;
			rosterDefault = quota.default_limit;
			rosterOverrides = Object.fromEntries(
				Object.entries(quota.overrides).map(([id, n]) => [id, String(n)])
			);
		}
		attemptLimit = data.settings.attempt_limit;
	});

	async function saveSettings(e: SubmitEvent) {
		e.preventDefault();
		if (savingSettings) return;
		savingSettings = true;
		try {
			const quota =
				quotaType === 'global_cap'
					? { type: 'global_cap' as const, limit: globalLimit }
					: {
							type: 'state_roster' as const,
							default_limit: rosterDefault,
							overrides: Object.fromEntries(
								Object.entries(rosterOverrides)
									.filter(([, v]) => v.trim() !== '')
									.map(([id, v]) => [id, Number.parseInt(v, 10)])
							)
						};
			await api.updateSupervisorSettings({ quota, attempt_limit: attemptLimit });
			await invalidateAll();
		} catch (err) {
			showError(err);
		} finally {
			savingSettings = false;
		}
	}
</script>

<svelte:head><title>Agents · Tines</title></svelte:head>

<div class="mb-6 flex flex-wrap items-start justify-between gap-4">
	<div>
		<h1 class="text-2xl font-semibold tracking-tight">Agents</h1>
		<p class="text-muted-foreground mt-1 max-w-2xl text-sm">
			Runners execute eligible issues; routing rules decide which runner takes what; the automation
			settings bound how much runs at once.
		</p>
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

<!-- kill-switch off-state banner: persistent while automation is disabled -->
{#if !data.settings.enabled}
	<div
		class="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-300"
	>
		<span class="flex items-center gap-2">
			<IconAlertTriangle size={16} stroke={1.75} />
			Automation is off — nothing dispatches until you turn it on.
		</span>
		<Button size="sm" onclick={() => setEnabled(true)} disabled={togglingEnabled}>Turn on</Button>
	</div>
{/if}

<!-- Runners -->
<div class="mb-10">
	<div class="mb-3 flex items-center justify-between">
		<h2 class="text-sm font-semibold">Runners</h2>
		<Button size="sm" variant="ghost" onclick={() => (addRunnerOpen = true)}>
			<IconPlus size={14} /> Add runner
		</Button>
	</div>
	{#if data.runners.length === 0}
		<div class="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">
			No runners yet. Add a local runner for this machine — managed (Claude / Gemini) runners arrive
			in a later milestone.
		</div>
	{:else}
		<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
			{#each data.runners as runner (runner.id)}
				<div class="rounded-lg border p-4">
					<div class="mb-2 flex items-center gap-2">
						<span class="bg-muted text-muted-foreground flex size-8 items-center justify-center rounded-md">
							{#if runner.type === 'local'}
								<IconDeviceLaptop size={18} stroke={1.75} />
							{:else}
								<IconCloud size={18} stroke={1.75} />
							{/if}
						</span>
						<div class="min-w-0">
							<p class="truncate text-sm font-medium">{runner.name}</p>
							<p class="text-muted-foreground flex items-center gap-1.5 text-xs">
								<span class="size-1.5 rounded-full {statusDotClass(runner)}"></span>
								{runnerStatusLabel(runner)}
								{#if runner.last_seen_at}
									· seen {relativeTime(runner.last_seen_at)}
								{/if}
							</p>
						</div>
					</div>
					<p class="text-muted-foreground mb-3 text-xs">
						{runner.active_runs}/{runner.max_concurrent} runs · {runner.max_run_minutes}m timeout ·
						default tier {runner.default_tier}
						{#if runner.launch_failures > 0}
							<span class="text-amber-600 dark:text-amber-400">· {runner.launch_failures} launch failures</span>
						{/if}
					</p>
					<div class="flex flex-wrap gap-2">
						{#if runner.status === 'paused'}
							<Button size="sm" variant="outline" onclick={() => setRunnerStatus(runner, 'active')}>Resume</Button>
						{:else}
							<Button size="sm" variant="outline" onclick={() => setRunnerStatus(runner, 'paused')}>Pause</Button>
						{/if}
						{#if runner.type === 'local'}
							<Button
								size="sm"
								variant="ghost"
								disabled={rotatingRunnerId === runner.id}
								title="Invalidate the runner token and mint a fresh one (shown once)"
								onclick={() => (rotateTarget = runner)}
							>
								<IconKey size={14} /> Rotate token
							</Button>
						{/if}
						<Button size="sm" variant="ghost" class="text-destructive" onclick={() => removeRunner(runner)}>
							<IconTrash size={14} /> Remove
						</Button>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<!-- Runs -->
<div class="mb-10">
	<div class="mb-3 flex flex-wrap items-center justify-between gap-2">
		<h2 class="text-sm font-semibold">
			Runs
			<span class="text-muted-foreground font-normal">— {utilization}</span>
		</h2>
		<label class="text-muted-foreground flex items-center gap-2 text-xs">
			<input type="checkbox" bind:checked={showAllRuns} class="accent-primary" />
			Show ended runs
		</label>
	</div>
	{#if visibleRuns.length === 0}
		<div class="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">
			{showAllRuns
				? 'No runs yet — they appear here as soon as the supervisor dispatches an eligible issue.'
				: 'No active runs.'}
		</div>
	{:else}
		<ul class="divide-y rounded-lg border">
			{#each visibleRuns as run (run.id)}
				<li
					class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm"
					transition:slide={{ duration: dur() }}
				>
					{#if (ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)}
						<span class="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500"></span>
					{/if}
					{#if run.issue_ref}
						<a
							href="/issues/{encodeURIComponent(run.issue_ref.project_name)}/{run.issue_ref.number}"
							class="font-medium hover:underline"
						>
							{run.issue_ref.project_name}/#{run.issue_ref.number}
						</a>
					{/if}
					<span class="text-muted-foreground">{run.runner_name}</span>
					<span class="text-muted-foreground text-xs">
						{run.tier}{run.model ? ` · ${run.model}` : ''}
					</span>
					<span class="text-xs font-medium {runStatusClass(run.status)}">
						{run.status.replaceAll('_', ' ')}
					</span>
					<span class="text-muted-foreground text-xs">{runDurationLabel(run)}</span>
					{#if run.error}
						<span class="max-w-64 truncate text-xs text-amber-700 dark:text-amber-400" title={run.error}>
							{run.error}
						</span>
					{/if}
					<span class="text-muted-foreground ml-auto text-xs" title={new Date(run.created_at).toLocaleString()}>
						{relativeTime(run.created_at)}
					</span>
					<Button
						size="sm"
						variant="ghost"
						class="h-7"
						aria-expanded={expandedLogs[run.id] === true}
						onclick={() => (expandedLogs = { ...expandedLogs, [run.id]: !expandedLogs[run.id] })}
					>
						{expandedLogs[run.id] ? 'Hide logs' : 'Logs'}
					</Button>
					{#if (ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)}
						<Button size="sm" variant="ghost" class="text-destructive h-7" onclick={() => (cancelTarget = run)}>
							Cancel
						</Button>
					{/if}
					{#if expandedLogs[run.id]}
						<div class="w-full" transition:slide={{ duration: dur() }}>
							<RunLogViewer runId={run.id} />
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>

<!-- Routing -->
<div class="mb-10">
	<div class="mb-3 flex items-center justify-between">
		<h2 class="text-sm font-semibold">Routing</h2>
		<Button size="sm" variant="ghost" onclick={openRuleCreate} disabled={data.runners.length === 0}>
			<IconPlus size={14} /> Add rule
		</Button>
	</div>
	{#if data.runners.length > 0 && data.rules.length === 0}
		<div class="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
			You have a runner but no routing rules — nothing will dispatch. Add a global rule to route
			everything.
		</div>
	{/if}
	{#if ruleWarnings.length > 0}
		<div
			class="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300"
			transition:slide={{ duration: dur() }}
		>
			<div class="flex items-start justify-between gap-2">
				<ul class="space-y-0.5">
					{#each ruleWarnings as warning (warning.rule_id + warning.message)}
						<li>{warning.message}</li>
					{/each}
				</ul>
				<button type="button" class="shrink-0" aria-label="Dismiss" onclick={() => (ruleWarnings = [])}>
					<IconX size={14} />
				</button>
			</div>
		</div>
	{/if}
	{#if data.rules.length === 0}
		<div class="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">
			No routing rules. A rule is an ordered runner preference list at a scope — the most specific
			matching rule wins (project ∧ state, then project, then state, then global).
		</div>
	{:else}
		<ul class="divide-y rounded-lg border">
			{#each data.rules as rule (rule.id)}
				<li class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-sm">
					<ContextScopeChips scope={rule.scope} />
					{#if rule.targets.length === 0}
						<span
							class="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400"
							title="A forced runner removal emptied this rule; add targets or delete it"
						>
							no targets
						</span>
					{:else}
						<span class="flex flex-wrap items-center gap-1">
							{#each rule.targets as target, i (target.runner_id + (target.tier ?? '') + i)}
								{#if i > 0}
									<IconArrowRight size={12} class="text-muted-foreground" />
								{/if}
								<span
									class="bg-muted rounded-full px-2 py-0.5 text-xs {target.runner_status === 'paused' ? 'opacity-60' : ''}"
									title={target.runner_status === 'paused' ? 'paused' : undefined}
								>
									{target.runner_name}{target.tier ? `:${target.tier}` : ''}
								</span>
							{/each}
						</span>
					{/if}
					<span class="ml-auto flex gap-1">
						<Button size="sm" variant="ghost" onclick={() => openRuleEdit(rule)}>Edit</Button>
						<Button size="sm" variant="ghost" class="text-destructive" onclick={() => deleteRule(rule)}>
							Delete
						</Button>
					</span>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<!-- Automation settings -->
<div class="mb-10 max-w-2xl">
	<h2 class="mb-3 text-sm font-semibold">Automation settings</h2>
	<div class="space-y-6 rounded-lg border p-5">
		<!-- the kill switch, prominent -->
		<div class="flex items-center justify-between gap-4">
			<div>
				<p class="flex items-center gap-1.5 text-sm font-medium">
					<IconRobot size={16} stroke={1.75} /> Automation
				</p>
				<p class="text-muted-foreground mt-0.5 text-xs">
					The kill switch: while off, no issue is dispatched to any runner.
				</p>
			</div>
			<button
				type="button"
				role="switch"
				aria-checked={data.settings.enabled}
				aria-label="Automation kill switch"
				disabled={togglingEnabled}
				onclick={() => (data.settings.enabled ? requestDisable() : setEnabled(true))}
				class="relative h-6 w-11 shrink-0 rounded-full transition-colors {data.settings.enabled
					? 'bg-emerald-500'
					: 'bg-muted-foreground/30'}"
			>
				<span
					class="bg-background absolute top-0.5 left-0.5 size-5 rounded-full shadow transition-transform {data.settings.enabled
						? 'translate-x-5'
						: ''}"
				></span>
			</button>
		</div>

		<form onsubmit={saveSettings} class="space-y-5">
			<div class="space-y-2">
				<p class="text-sm font-medium">Quota policy</p>
				<!-- segmented control -->
				<div class="bg-muted inline-flex rounded-md p-0.5 text-sm">
					<button
						type="button"
						class="rounded px-3 py-1 {quotaType === 'global_cap' ? 'bg-background shadow-xs font-medium' : 'text-muted-foreground'}"
						onclick={() => (quotaType = 'global_cap')}
					>
						Global cap
					</button>
					<button
						type="button"
						class="rounded px-3 py-1 {quotaType === 'state_roster' ? 'bg-background shadow-xs font-medium' : 'text-muted-foreground'}"
						onclick={() => (quotaType = 'state_roster')}
					>
						Per-state roster
					</button>
				</div>
				{#if quotaType === 'global_cap'}
					<div class="flex items-center gap-2" transition:slide={{ duration: dur() }}>
						<label class="text-muted-foreground text-sm" for="global-limit">At most</label>
						<Input
							id="global-limit"
							type="number"
							min="1"
							max="100"
							class="w-20"
							value={globalLimit}
							oninput={(e) => (globalLimit = Number.parseInt(e.currentTarget.value, 10) || 1)}
						/>
						<span class="text-muted-foreground text-sm">concurrent runs across everything</span>
					</div>
				{:else}
					<div class="space-y-3" transition:slide={{ duration: dur() }}>
						<div class="flex items-center gap-2">
							<label class="text-muted-foreground text-sm" for="roster-default">Default</label>
							<Input
								id="roster-default"
								type="number"
								min="0"
								max="100"
								class="w-20"
								value={rosterDefault}
								oninput={(e) => (rosterDefault = Number.parseInt(e.currentTarget.value, 10) || 0)}
							/>
							<span class="text-muted-foreground text-sm">concurrent runs per state</span>
						</div>
						<p class="text-muted-foreground text-xs">
							Counted by the state a run started in. Leave a state blank to inherit the default; 0
							means no agents work that stage.
						</p>
						<!-- every state, grouped by workflow, inherited default shown -->
						<div class="max-h-72 space-y-3 overflow-y-auto rounded-md border p-3">
							{#each data.workflows as workflow (workflow.id)}
								<div>
									<p class="text-muted-foreground mb-1.5 text-xs font-semibold">{workflow.name}</p>
									<div class="space-y-1.5">
										{#each workflow.states as state (state.id)}
											<div class="flex items-center justify-between gap-2">
												<StateBadge {state} />
												<span class="flex items-center gap-2">
													{#if (rosterOverrides[state.id] ?? '') === ''}
														<span class="text-muted-foreground text-xs">inherits {rosterDefault}</span>
													{/if}
													<Input
														type="number"
														min="0"
														max="100"
														class="w-20"
														placeholder={String(rosterDefault)}
														aria-label={`Limit for ${workflow.name} / ${state.name}`}
														value={rosterOverrides[state.id] ?? ''}
														oninput={(e) =>
															(rosterOverrides = { ...rosterOverrides, [state.id]: e.currentTarget.value })}
													/>
												</span>
											</div>
										{/each}
									</div>
								</div>
							{/each}
						</div>
					</div>
				{/if}
			</div>

			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="attempt-limit">Attempt limit</label>
				<div class="flex items-center gap-2">
					<Input
						id="attempt-limit"
						type="number"
						min="1"
						max="100"
						class="w-20"
						value={attemptLimit}
						oninput={(e) => (attemptLimit = Number.parseInt(e.currentTarget.value, 10) || 1)}
					/>
					<span class="text-muted-foreground text-sm">
						strikes (runs that end without moving the issue) before it parks for a human
					</span>
				</div>
			</div>

			<div class="flex justify-end">
				<Button type="submit" disabled={savingSettings}>
					{savingSettings ? 'Saving…' : 'Save settings'}
				</Button>
			</div>
		</form>
	</div>
</div>

<!-- add runner: the copy-pasteable daemon bootstrap (the daemon registers itself) -->
<Modal bind:open={addRunnerOpen} title="Add local runner">
	<div class="space-y-4">
		<div class="grid grid-cols-2 gap-3">
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="runner-name">Name</label>
				<Input id="runner-name" bind:value={runnerName} placeholder="e.g. laptop-m4" />
				<p class="text-muted-foreground text-xs">
					Unique — routing rules and the CLI address runners by name. Defaults to the hostname.
				</p>
			</div>
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="runner-harness">Harness</label>
				<Select id="runner-harness" bind:value={runnerHarness}>
					<option value="claude-code">Claude Code</option>
					<option value="codex">codex</option>
					<option value="custom">Custom command</option>
				</Select>
			</div>
		</div>
		{#if runnerHarness === 'custom'}
			<div class="space-y-1.5" transition:slide={{ duration: dur() }}>
				<label class="text-sm font-medium" for="runner-command">Command template</label>
				<Input
					id="runner-command"
					bind:value={runnerCommand}
					placeholder={'my-agent {prompt_file} --workspace {workspace}'}
				/>
				<p class="text-muted-foreground text-xs">
					Placeholders: {'{prompt_file}'}, {'{workspace}'}, {'{model}'}.
				</p>
			</div>
		{/if}
		<div class="space-y-1.5">
			<label class="text-sm font-medium" for="runner-cap">Max concurrent runs</label>
			<Input
				id="runner-cap"
				type="number"
				min="1"
				max="100"
				class="w-24"
				value={runnerMaxConcurrent}
				oninput={(e) => (runnerMaxConcurrent = Number.parseInt(e.currentTarget.value, 10) || 1)}
			/>
		</div>

		<div class="space-y-1.5">
			<p class="text-sm font-medium">Run this on the machine</p>
			<div class="relative">
				<pre class="bg-muted overflow-x-auto rounded-md border p-3 pr-10 font-mono text-xs">{bootstrapCommand}</pre>
				<Button
					size="icon"
					variant="ghost"
					class="absolute top-1.5 right-1.5 size-7"
					aria-label="Copy the bootstrap command"
					onclick={copyBootstrapCommand}
				>
					<IconCopy size={14} />
				</Button>
				{#if commandCopied}
					<span class="text-muted-foreground absolute -bottom-5 right-0 text-xs">copied</span>
				{/if}
			</div>
			<p class="text-muted-foreground pt-1 text-xs">
				The first start <span class="font-medium">registers</span> the runner with your API key and
				stores its own long-lived runner token on the machine; it appears here, online, within
				seconds. Later starts reconnect with the stored token — the API key is only needed once.
			</p>
			<p class="text-muted-foreground text-xs">
				Keep it running: the runner is infrastructure — put the daemon under launchd/systemd so it
				survives logouts and reboots (service snippets in
				<code class="bg-muted rounded px-1 py-0.5">docs/runner-daemon.md</code>).
			</p>
		</div>
		<div class="flex justify-end">
			<Button variant="outline" onclick={() => (addRunnerOpen = false)}>Done</Button>
		</div>
	</div>
</Modal>

<!-- cancel a run: strike note + optional comment posted before the cancel -->
{#if cancelTarget}
	<CancelRunDialog
		run={cancelTarget}
		attemptLimit={data.settings.attempt_limit}
		onclose={() => (cancelTarget = null)}
		ondone={async () => {
			cancelTarget = null;
			await invalidateAll();
		}}
		onerror={(e) => {
			cancelTarget = null;
			showError(e);
		}}
	/>
{/if}

<!-- rotate token: confirmation before invalidating the old one -->
{#if rotateTarget}
	<Modal open={true} onclose={() => (rotateTarget = null)} title="Rotate runner token?">
		<div class="space-y-3">
			<p class="text-sm">
				Rotate the token for <span class="font-medium">{rotateTarget.name}</span>? The old token
				dies immediately — the daemon's next poll gets a 401 until it adopts the new one. The
				runner's id, history, and rule references are unchanged.
			</p>
			<div class="flex justify-end gap-2">
				<Button variant="ghost" onclick={() => (rotateTarget = null)}>Keep current token</Button>
				<Button
					variant="outline"
					disabled={rotatingRunnerId !== null}
					onclick={() => rotateTarget && rotateToken(rotateTarget)}
				>
					{rotatingRunnerId ? 'Rotating…' : 'Rotate token'}
				</Button>
			</div>
		</div>
	</Modal>
{/if}

<!-- rotated token: shown exactly once -->
<Modal bind:open={tokenModalOpen} onclose={() => (rotatedToken = null)} title="New runner token">
	{#if rotatedToken}
		<div class="space-y-3">
			<p class="text-sm">
				The token for <span class="font-medium">{rotatedToken.runnerName}</span> was rotated. This is
				the only time the new token is shown — the old one is already dead.
			</p>
			<pre class="bg-muted overflow-x-auto rounded-md border p-3 font-mono text-xs select-all">{rotatedToken.token}</pre>
			<p class="text-muted-foreground text-xs">
				The daemon's next poll gets a 401 until it adopts this token: run
				<code class="bg-muted rounded px-1 py-0.5">tines runners rotate-token</code> on the daemon
				machine to store it automatically, or update the entry in its config directory and restart.
				The runner's id, history, and rule references are unchanged.
			</p>
			<div class="flex justify-end">
				<Button
					variant="outline"
					onclick={() => {
						tokenModalOpen = false;
						rotatedToken = null;
					}}
				>
					Done
				</Button>
			</div>
		</div>
	{/if}
</Modal>

<!-- kill-switch off: offer the bulk cancel of in-flight runs -->
<Modal bind:open={disableConfirmOpen} title="Turn automation off?">
	<div class="space-y-3">
		<p class="text-sm">
			Nothing new will dispatch, and not-yet-started assignments are canceled. But
			<span class="font-medium">
				{inFlightRuns.length} run{inFlightRuns.length === 1 ? ' is' : 's are'} still running
			</span>
			— cancel {inFlightRuns.length === 1 ? 'it' : 'them'} too?
		</p>
		<p class="text-muted-foreground text-xs">
			Canceling counts as an ordinary cancel per run — a run that hasn't moved its issue takes a
			strike. Left alone, running work finishes normally.
		</p>
		<div class="flex justify-end gap-2">
			<Button variant="ghost" onclick={() => (disableConfirmOpen = false)}>Keep running</Button>
			<Button variant="outline" disabled={togglingEnabled} onclick={() => setEnabled(false)}>
				Turn off only
			</Button>
			<Button
				variant="destructive"
				disabled={togglingEnabled}
				onclick={() => setEnabled(false, true)}
			>
				Turn off and cancel {inFlightRuns.length} run{inFlightRuns.length === 1 ? '' : 's'}
			</Button>
		</div>
	</div>
</Modal>

<!-- rule editor -->
<Modal bind:open={ruleModalOpen} title={editingRule ? 'Edit routing rule' : 'New routing rule'}>
	<form onsubmit={saveRule} class="space-y-4">
		<div class="grid grid-cols-2 gap-3">
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="rule-project">Project</label>
				<Select id="rule-project" bind:value={ruleProjectId}>
					<option value="">Any project</option>
					{#each data.projects as project (project.id)}
						<option value={project.id}>{project.name}</option>
					{/each}
				</Select>
			</div>
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="rule-state">State</label>
				<Select id="rule-state" bind:value={ruleStateId}>
					<option value="">Any state</option>
					{#each data.workflows as workflow (workflow.id)}
						<optgroup label={workflow.name}>
							{#each workflow.states as state (state.id)}
								<option value={state.id}>{state.name}</option>
							{/each}
						</optgroup>
					{/each}
				</Select>
			</div>
		</div>
		<p class="text-muted-foreground text-xs">
			Both empty = a global rule. The most specific matching rule wins: project ∧ state, then
			project, then state, then global — no fallback across rules.
		</p>

		<div class="space-y-1.5">
			<p class="text-sm font-medium">Targets (preference order)</p>
			{#each ruleTargets as target, i (i)}
				<div class="flex items-center gap-1.5">
					<span class="text-muted-foreground w-4 text-right text-xs">{i + 1}.</span>
					<Select
						class="flex-1"
						aria-label={`Target ${i + 1} runner`}
						value={target.runner_id}
						onchange={(e) => (ruleTargets[i] = { ...ruleTargets[i], runner_id: e.currentTarget.value })}
					>
						{#each data.runners as runner (runner.id)}
							<option value={runner.id}>{runner.name}{runner.status === 'paused' ? ' (paused)' : ''}</option>
						{/each}
					</Select>
					<Select
						class="w-32"
						aria-label={`Target ${i + 1} tier`}
						value={target.tier}
						onchange={(e) => (ruleTargets[i] = { ...ruleTargets[i], tier: e.currentTarget.value as '' | ModelTier })}
					>
						<option value="">default tier</option>
						{#each MODEL_TIERS as tier (tier)}
							<option value={tier}>{tier}</option>
						{/each}
					</Select>
					<Button
						size="icon"
						variant="ghost"
						type="button"
						class="size-8"
						disabled={i === 0}
						aria-label="Move up"
						onclick={() => moveTarget(i, -1)}
					>
						<IconArrowUp size={14} />
					</Button>
					<Button
						size="icon"
						variant="ghost"
						type="button"
						class="size-8"
						disabled={i === ruleTargets.length - 1}
						aria-label="Move down"
						onclick={() => moveTarget(i, 1)}
					>
						<IconArrowDown size={14} />
					</Button>
					<Button
						size="icon"
						variant="ghost"
						type="button"
						class="text-destructive size-8"
						aria-label="Remove target"
						onclick={() => (ruleTargets = ruleTargets.filter((_, j) => j !== i))}
					>
						<IconX size={14} />
					</Button>
				</div>
			{/each}
			<Button
				size="sm"
				variant="ghost"
				type="button"
				disabled={data.runners.length === 0}
				onclick={() => (ruleTargets = [...ruleTargets, { runner_id: data.runners[0].id, tier: '' }])}
			>
				<IconPlus size={14} /> Add target
			</Button>
			<p class="text-muted-foreground text-xs">
				The first target that is online, unpaused, and under its caps takes the issue; if the list
				is exhausted, the issue waits.
			</p>
		</div>

		<div class="flex justify-end gap-2">
			<Button type="button" variant="ghost" onclick={() => (ruleModalOpen = false)}>Cancel</Button>
			<Button type="submit" disabled={savingRule || ruleTargets.length === 0}>
				{savingRule ? 'Saving…' : editingRule ? 'Save rule' : 'Create rule'}
			</Button>
		</div>
	</form>
</Modal>
