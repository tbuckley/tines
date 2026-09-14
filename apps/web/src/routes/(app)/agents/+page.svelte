<script lang="ts">
	import type {
		AgentRun,
		ApiKeyCreated,
		LabelWithUsage,
		QueueBinding,
		ModelTier,
		RoutingRuleWithWarnings,
		RoutingTarget,
		Runner,
		RunnerBudget,
		RunnerTierOverrides,
		ShadowWarning
	} from '@tines/shared';
	import {
		activeStateIds as deriveActiveStateIds,
		ApiError,
		DEFAULT_MANAGED_RUN_COST_USD,
		isActiveRun,
		isStaleTierOverride,
		MODEL_TIERS,
		RUNNER_NAME_PATTERN,
		utilizationLabel
	} from '@tines/shared';
	import IconAlertTriangle from '@tabler/icons-svelte/icons/alert-triangle';
	import IconArrowDown from '@tabler/icons-svelte/icons/arrow-down';
	import IconArrowUp from '@tabler/icons-svelte/icons/arrow-up';
	import IconCloud from '@tabler/icons-svelte/icons/cloud';
	import IconCopy from '@tabler/icons-svelte/icons/copy';
	import IconDeviceLaptop from '@tabler/icons-svelte/icons/device-laptop';
	import IconKey from '@tabler/icons-svelte/icons/key';
	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import IconRobot from '@tabler/icons-svelte/icons/robot';
	import IconTrash from '@tabler/icons-svelte/icons/trash';
	import IconX from '@tabler/icons-svelte/icons/x';
	import { tick, untrack } from 'svelte';
	import { slide } from 'svelte/transition';
	import { afterNavigate, goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import CancelRunDialog from '$lib/components/CancelRunDialog.svelte';
	import FirstRunChecklist from '$lib/components/FirstRunChecklist.svelte';
	import { confirmDialog } from '$lib/components/dialogs.svelte';
	import type { StageStats, StageStatsReport } from '@tines/shared';
	import StageStatsBoard from '$lib/components/StageStatsBoard.svelte';
	import SentBackDrilldown from '$lib/components/SentBackDrilldown.svelte';
	import { stageRunsHref } from '$lib/stage-stats-view';
	import FleetQueuePanel from '$lib/components/FleetQueuePanel.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import NewIssueModal from '$lib/components/NewIssueModal.svelte';
	import PatInstructions from '$lib/components/PatInstructions.svelte';
	import PendingButton from '$lib/components/PendingButton.svelte';
	import RoutingRuleRow from '$lib/components/RoutingRuleRow.svelte';
	import RunRow from '$lib/components/RunRow.svelte';
	import StateBadge from '$lib/components/StateBadge.svelte';
	import SpendPanel from '$lib/components/SpendPanel.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Select } from '$lib/components/ui/select/index.js';
	import type { FirstRunInputs } from '$lib/first-run';
	import { prefersReducedMotion, queueAge, relativeTime } from '$lib/format';
	import { addRunnerToGlobalRule, findGlobalRule } from '$lib/routing';
	import {
		agentsNavigationMessage,
		canonicalSpendChanges,
		patchSpendUrl
	} from '$lib/spend-selection';

	let { data } = $props();
	const agentsView = $derived(
		page.url.searchParams.get('agents_view') === 'spend' ? 'spend' : 'now'
	);
	let pendingAgentsUrl: URL | null = null;
	let failedAgentsUrl = $state<URL | null>(null);
	let navigationError = $state<string | null>(null);
	let navigationGeneration = 0;
	async function navigateAgents(url: URL, replaceState = false) {
		const generation = ++navigationGeneration;
		pendingAgentsUrl = url;
		try {
			await goto(url, { keepFocus: true, noScroll: true, replaceState, state: page.state });
			if (generation === navigationGeneration) {
				failedAgentsUrl = null;
				navigationError = null;
			}
		} catch (error) {
			if (generation === navigationGeneration) {
				failedAgentsUrl = url;
				navigationError = agentsNavigationMessage(error);
			}
		} finally {
			if (generation === navigationGeneration) pendingAgentsUrl = null;
		}
	}
	function patchAgents(values: Record<string, string | null>, replaceState = false) {
		return navigateAgents(patchSpendUrl(pendingAgentsUrl ?? page.url, values), replaceState);
	}
	function chooseAgentsView(view: 'now' | 'spend') {
		if (view === agentsView) return;
		void patchAgents({ agents_view: view === 'now' ? null : 'spend' });
	}

	let sentBackOpen = $state(false);
	let sentBackStage = $state<StageStats | null>(null);
	let sentBackReport = $state<StageStatsReport | null>(null);
	function openSentBack(stage: StageStats) {
		sentBackStage = stage;
		sentBackReport = data.stats;
		sentBackOpen = true;
	}
	const evidenceProject = $derived(data.boardProject);
	$effect(() => {
		evidenceProject;
		sentBackOpen = false;
	});
	async function focusStatsCapacity(stateId: string) {
		if (agentsView !== 'now') await patchAgents({ agents_view: null });
		quotaType = data.settings.quota.type;
		highlight(quotaType === 'state_roster' ? stateId : null);
		await tick();
		const id = quotaType === 'global_cap' ? 'global-limit' : `roster-limit-${stateId}`;
		const control = document.getElementById(id);
		const target = control ?? document.getElementById('quota-policy');
		target?.scrollIntoView({
			block: 'center',
			behavior: prefersReducedMotion() ? 'auto' : 'smooth'
		});
		if (control instanceof HTMLInputElement) control.focus({ preventScroll: true });
		else errorMessage = 'Stage capacity no longer available';
	}
	function filterProject(project: string) {
		void patchAgents({ project: project || null });
	}

	const dur = () => (prefersReducedMotion() ? 0 : 180);

	/**
	 * Every write on this page that can unblock dispatch — a raised cap, a new
	 * rule, the kill switch — queues a pass, and `queueDispatchPass` runs it on
	 * `waitUntil`: the response can land before the pass has claimed anything.
	 * So re-read now (the write's own effect) and once more shortly after (the
	 * pass's), which is what makes the Now row shrink without a reload
	 * (Tines/256). `invalidateAll` re-runs the loader without remounting, so
	 * open dialogs and typed state survive.
	 *
	 * The second read is deliberately untestable locally: under `wrangler dev`
	 * the pass has finished before the write's response returns (traced — the
	 * group is gone by t≈1s), so deleting it leaves the e2e suite green. It
	 * defends the deployed Worker's `waitUntil`, where that ordering is not
	 * guaranteed; the 2s is a margin, not a measurement. Delete it only with a
	 * measurement from production in hand.
	 */
	let dispatchRecheck: ReturnType<typeof setTimeout> | null = null;
	async function refreshAfterDispatch() {
		await invalidateAll();
		if (dispatchRecheck !== null) clearTimeout(dispatchRecheck);
		dispatchRecheck = setTimeout(() => {
			dispatchRecheck = null;
			if (typeof document === 'undefined' || !document.hidden) void invalidateAll();
		}, 2000);
	}
	$effect(() => () => {
		if (dispatchRecheck !== null) clearTimeout(dispatchRecheck);
	});

	/** "N waiting" annotations (Tines/256 Part 3), joined on the queue groups. */
	type Waiting = { count: number; oldest: number; href: string; now: number };
	function tally(
		entries: Iterable<[string, { count: number; oldest_entered_at: number; href: string }]>
	): Map<string, Waiting> {
		const out = new Map<string, Waiting>();
		for (const [key, g] of entries) {
			const seen = out.get(key);
			if (seen) {
				seen.count += g.count;
				seen.oldest = Math.min(seen.oldest, g.oldest_entered_at);
			} else {
				// The queue's own clock rides with the count, so an annotation and
				// the Now row group it links to cannot drift apart on a page left
				// open — the whole reason `queueAge` is shared.
				out.set(key, {
					count: g.count,
					oldest: g.oldest_entered_at,
					href: g.href,
					now: data.queue.generated_at
				});
			}
		}
		return out;
	}
	const waitingByState = $derived(
		tally(
			data.queue.groups.map((g) => [
				g.state_id,
				{ count: g.count, oldest_entered_at: g.oldest_entered_at, href: `#queue-${g.state_id}` }
			])
		)
	);
	const waitingByRunner = $derived(
		tally(
			data.queue.groups
				.filter((g) => g.runner_id !== null)
				.map((g) => [
					g.runner_id as string,
					{
						count: g.count,
						oldest_entered_at: g.oldest_entered_at,
						href: `#queue-runner-${g.runner_id}`
					}
				])
		)
	);
	const waitingByRule = $derived(
		tally(
			data.queue.groups.flatMap((g) =>
				[g.rule_id, ...g.ambiguous_rule_ids]
					.filter((id): id is string => id !== null)
					.map(
						(id) =>
							[
								id,
								{
									count: g.count,
									oldest_entered_at: g.oldest_entered_at,
									href: `#queue-${g.state_id}`
								}
							] as [string, { count: number; oldest_entered_at: number; href: string }]
					)
			)
		)
	);

	/** Runs already active, by the state they started in — the roster's own unit. */
	const activeByStartState = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const run of data.runs) {
			if (!isActiveRun(run.status)) continue;
			const id = run.state_id_at_start;
			if (!id) continue;
			counts.set(id, (counts.get(id) ?? 0) + 1);
		}
		return counts;
	});

	/** Set by the Now row's "Raise cap": the edit dialog focuses Max concurrent. */
	let editFocusCap = $state(false);

	/** Un-park an issue from the Now row's parked block (user flow 9). */
	async function resumeParked(issueId: string) {
		try {
			await api.resumeIssue(issueId);
			await refreshAfterDispatch();
		} catch (err) {
			showError(err);
		}
	}

	/** The roster row the Now row just pointed at; ringed briefly, then released. */
	let highlightStateId = $state<string | null>(null);
	let highlightTimer: ReturnType<typeof setTimeout> | null = null;
	function highlight(stateId: string | null) {
		highlightStateId = stateId;
		if (highlightTimer !== null) clearTimeout(highlightTimer);
		if (stateId === null) return;
		highlightTimer = setTimeout(() => (highlightStateId = null), 2500);
	}

	/** Scroll the quota editor into view and focus whichever control binds. */
	function focusQuota(target: { stateId: string | null; binding: QueueBinding | null }) {
		const binding = target.binding;
		if (binding?.kind === 'state_roster' || (target.stateId && binding?.kind !== 'global_cap')) {
			quotaType = 'state_roster';
		} else if (binding?.kind === 'global_cap') {
			quotaType = 'global_cap';
		}
		const stateId = binding?.kind === 'state_roster' ? binding.state_id : target.stateId;
		if (quotaType === 'state_roster') highlight(stateId);
		queueMicrotask(() => {
			const id = quotaType === 'global_cap' ? 'global-limit' : `roster-limit-${stateId}`;
			const el = document.getElementById(id) ?? document.getElementById('quota-policy');
			el?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
			if (el instanceof HTMLInputElement) el.focus();
		});
	}

	/**
	 * The approved global-cap remedy (Tines/200 answer 3): move the workspace to
	 * a per-state roster whose limits already cover what is queued — the runs
	 * active in each state plus the ones waiting on it. Prefill and focus only;
	 * the roster lives inside the settings form, so the user presses Save.
	 */
	function switchToRoster(prefill: Record<string, number>) {
		quotaType = 'state_roster';
		const next = { ...rosterOverrides };
		for (const [stateId, waiting] of Object.entries(prefill)) {
			next[stateId] = String(waiting + (activeByStartState.get(stateId) ?? 0));
		}
		rosterOverrides = next;
		focusQuota({ stateId: Object.keys(prefill)[0] ?? null, binding: null });
	}

	let errorMessage = $state<string | null>(null);
	function showError(e: unknown) {
		errorMessage = e instanceof ApiError ? e.message : 'Something went wrong — try again.';
		setTimeout(() => (errorMessage = null), 8000);
	}

	// --- first-run checklist -----------------------------------------------------

	// The server decides whether this account has ever had a run; once mounted
	// the checklist stays for this page-session so the first run can land in its
	// last item. A later load never shows it again.
	// svelte-ignore state_referenced_locally
	let checklistVisible = $state(!data.hasAnyRun);
	let newIssueOpen = $state(false);

	const checklistInputs = $derived<FirstRunInputs>({
		surface: 'agents',
		hasAnyIssue: data.hasAnyIssue,
		hasAnyProject: data.projects.length > 0,
		runners: data.runners,
		rules: data.rules,
		enabled: data.settings.enabled,
		issue: data.newestIssue,
		firstRun: data.runs[0] ?? null
	});

	async function routeToSoleRunner() {
		await addRunnerToGlobalRule(data.rules, data.runners[0]);
		await invalidateAll();
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
			await refreshAfterDispatch();
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

	// The queue's own timestamp, so the card and the Now row above it agree on
	// whether a hold is still live; both refresh together on invalidation.
	const now = $derived(data.queue.generated_at);

	/** A live usage-limit hold: the daemon is fine, its provider is not. */
	function rateLimited(runner: Runner, at: number): boolean {
		return runner.backoff_reason === 'rate_limit' && (runner.backoff_until ?? 0) > at;
	}

	function runnerStatusLabel(runner: Runner): string {
		if (runner.status === 'paused') return 'paused';
		if (!runner.online) return 'offline';
		// Ahead of draining: a rate-limited runner polls normally, so "online"
		// would read as healthy while it is quietly taking nothing.
		if (rateLimited(runner, now)) return 'rate limited';
		return runner.draining ? 'restarting to update' : 'online';
	}

	function statusDotClass(runner: Runner): string {
		if (runner.status === 'paused') return 'bg-amber-500';
		if (!runner.online) return 'bg-muted-foreground/40';
		if (rateLimited(runner, now)) return 'bg-amber-500';
		return runner.draining ? 'bg-amber-500' : 'bg-emerald-500';
	}

	// The add-runner wizard. The local path shows the bootstrap command (the
	// daemon registers itself; nothing is created here); the Claude managed
	// path creates the runner with a ping-validated key, inlining the add-PAT
	// step when none is stored, and ends with a skippable add-to-routing step.
	let addRunnerOpen = $state(false);
	let addRunnerType = $state<'local' | 'claude_managed'>('local');
	let runnerName = $state('');
	let runnerHarness = $state('claude-code');
	let runnerCommand = $state('');
	let runnerMaxConcurrent = $state(1);
	let runnerAllowRemoteConcurrency = $state(false);
	let commandCopied = $state(false);
	/** The key created from inside the dialog, shown once and never re-fetchable. */
	let createdKey = $state<ApiKeyCreated | null>(null);
	let creatingKey = $state(false);

	/** `macbook-claude` — the machine, then the harness that runs on it. */
	const HARNESS_SLUG: Record<string, string> = {
		'claude-code': 'claude',
		codex: 'codex',
		custom: 'agent'
	};
	const namePlaceholder = $derived(`macbook-${HARNESS_SLUG[runnerHarness] ?? 'agent'}`);
	const trimmedName = $derived(runnerName.trim());

	/**
	 * What is wrong with the typed name, if anything. An existing *local*
	 * runner is only a warning: `registerRunner` reconnects to it rather than
	 * refusing. A managed collision is a hard 422, so it is an error here.
	 */
	const nameIssue = $derived.by((): { level: 'error' | 'warning'; message: string } | null => {
		if (trimmedName === '') return null;
		if (!RUNNER_NAME_PATTERN.test(trimmedName)) {
			return {
				level: 'error',
				message:
					'Names are CLI addresses: letters, digits, ".", "_" and "-", starting with a letter or digit — try macbook-claude.'
			};
		}
		const existing = data.runners.find((r) => r.name === trimmedName);
		if (!existing) return null;
		return existing.type === 'local'
			? {
					level: 'warning',
					message: `A local runner named ${trimmedName} already exists — starting the daemon with this name reconnects to it rather than creating a second one.`
				}
			: {
					level: 'error',
					message: `A managed runner named ${trimmedName} already exists — pick another name.`
				};
	});
	const nameReady = $derived(trimmedName !== '' && nameIssue?.level !== 'error');

	/** The named local runner, once it has registered and is polling. */
	const namedLocalOnline = $derived(
		data.runners.find((r) => r.type === 'local' && r.name === trimmedName && r.online) ?? null
	);

	const globalRule = $derived(findGlobalRule(data.rules));

	async function createRunnerKey() {
		if (!nameReady || creatingKey || createdKey) return;
		creatingKey = true;
		try {
			createdKey = await api.createApiKey({ name: `runner ${trimmedName}` });
		} catch (err) {
			showError(err);
		} finally {
			creatingKey = false;
		}
	}

	// Claude managed form state (flow 3).
	let claudeApiKey = $state('');
	let claudeMaxConcurrent = $state(3);
	let claudeMaxMinutes = $state(30);
	let claudeDefaultTier = $state<ModelTier>('balanced');
	let claudeCapEnabled = $state(true);
	let claudeCapUsd = $state(DEFAULT_MANAGED_RUN_COST_USD);
	let claudePat = $state('');
	let creatingClaude = $state(false);
	/** Set after a successful create: the wizard's final, skippable routing step. */
	let createdRunner = $state<Runner | null>(null);
	let addingToRouting = $state(false);

	function resetAddRunner() {
		addRunnerOpen = false;
		createdRunner = null;
		claudeApiKey = '';
		claudePat = '';
		runnerName = '';
		runnerAllowRemoteConcurrency = false;
		createdKey = null;
		creatingKey = false;
		commandCopied = false;
	}

	async function createClaudeRunner(e: SubmitEvent) {
		e.preventDefault();
		if (creatingClaude) return;
		creatingClaude = true;
		try {
			// The inlined add-PAT step: stored in supervisor settings (shared
			// across managed runners), written before the runner so the first
			// dispatched run can already clone.
			if (claudePat.trim() !== '') {
				await api.updateSupervisorSettings({ github_pat: claudePat.trim() });
			}
			createdRunner = await api.createRunner({
				type: 'claude_managed',
				name: runnerName.trim(),
				api_key: claudeApiKey.trim(),
				max_concurrent: claudeMaxConcurrent,
				max_run_minutes: claudeMaxMinutes,
				default_tier: claudeDefaultTier,
				// An explicit budget replaces the $5 default wholesale; {} = uncapped.
				budget: claudeCapEnabled ? { max_run_cost_usd: claudeCapUsd } : {}
			});
			claudeApiKey = '';
			claudePat = '';
			await invalidateAll();
		} catch (err) {
			showError(err);
		} finally {
			creatingClaude = false;
		}
	}

	/** The skippable final step of the managed wizard. */
	async function addCreatedToRouting() {
		if (!createdRunner || addingToRouting) return;
		addingToRouting = true;
		try {
			await addRunnerToGlobalRule(data.rules, createdRunner);
			resetAddRunner();
			await invalidateAll();
		} catch (err) {
			showError(err);
		} finally {
			addingToRouting = false;
		}
	}

	/** The local path's one-click rule, from inside the open dialog. */
	async function routeEverythingToNamed() {
		if (!namedLocalOnline || addingToRouting) return;
		addingToRouting = true;
		try {
			await addRunnerToGlobalRule(data.rules, namedLocalOnline);
			resetAddRunner();
			await refreshAfterDispatch();
		} catch (err) {
			showError(err);
		} finally {
			addingToRouting = false;
		}
	}

	// --- runner edit: caps, budget, tier overrides, replace-key ------------------

	let editTarget = $state<Runner | null>(null);
	let editMaxConcurrent = $state(1);
	let editMaxMinutes = $state(30);
	let editDefaultTier = $state<ModelTier>('balanced');
	/** Per-tier override inputs: '' = built-in. */
	let editTierModels = $state<Record<string, string>>({});
	let editTierEfforts = $state<Record<string, string>>({});
	let editCapUsd = $state('');
	let editCapTokens = $state('');
	let editApiKey = $state('');
	let savingEdit = $state(false);

	/**
	 * Opened from the Now row's "Raise cap": land the caret on the field the
	 * remedy is about, rather than making the operator find it in the dialog.
	 * The modal calls this once its content has mounted, so the field exists;
	 * scheduling the focus here instead would race the modal's own parking of
	 * focus on the close button, which wins and leaves the caret nowhere useful.
	 */
	function focusCapField(): HTMLElement | null {
		if (!editFocusCap) return null;
		editFocusCap = false;
		const el = document.getElementById('edit-concurrent');
		if (!(el instanceof HTMLInputElement)) return null;
		el.select();
		return el;
	}

	function openRunnerEdit(runner: Runner) {
		editTarget = runner;
		editMaxConcurrent = runner.max_concurrent;
		editMaxMinutes = runner.max_run_minutes;
		editDefaultTier = runner.default_tier;
		editTierModels = Object.fromEntries(
			MODEL_TIERS.map((tier) => [tier, runner.tiers?.[tier]?.model ?? ''])
		);
		editTierEfforts = Object.fromEntries(
			MODEL_TIERS.map((tier) => [tier, runner.tiers?.[tier]?.effort ?? ''])
		);
		editCapUsd =
			runner.budget?.max_run_cost_usd !== undefined ? String(runner.budget.max_run_cost_usd) : '';
		editCapTokens =
			runner.budget?.max_run_tokens !== undefined ? String(runner.budget.max_run_tokens) : '';
		editApiKey = '';
	}

	async function saveRunnerEdit(e: SubmitEvent) {
		e.preventDefault();
		if (!editTarget || savingEdit) return;
		savingEdit = true;
		try {
			const tiers: RunnerTierOverrides = {};
			for (const tier of MODEL_TIERS) {
				const model = editTierModels[tier]?.trim();
				if (!model) continue;
				const effort = editTierEfforts[tier]?.trim();
				tiers[tier] = { model, ...(effort ? { effort } : {}) };
			}
			const budget: RunnerBudget = {
				...(editTarget.budget?.daily_usd !== undefined
					? { daily_usd: editTarget.budget.daily_usd }
					: {}),
				...(editTarget.budget?.daily_tokens !== undefined
					? { daily_tokens: editTarget.budget.daily_tokens }
					: {}),
				...(editCapUsd.trim() !== '' ? { max_run_cost_usd: Number(editCapUsd) } : {}),
				...(editCapTokens.trim() !== ''
					? { max_run_tokens: Number.parseInt(editCapTokens, 10) }
					: {})
			};
			await api.updateRunner(editTarget.id, {
				...(editMaxConcurrent !== editTarget.max_concurrent
					? {
							max_concurrent: editMaxConcurrent,
							expected_concurrency_revision:
								editTarget.type === 'local' ? editTarget.concurrency_control?.revision : undefined
						}
					: {}),
				max_run_minutes: editMaxMinutes,
				default_tier: editDefaultTier,
				tiers: Object.keys(tiers).length > 0 ? tiers : null,
				budget: Object.keys(budget).length > 0 ? budget : null,
				...(editApiKey.trim() !== '' ? { api_key: editApiKey.trim() } : {})
			});
			editTarget = null;
			await refreshAfterDispatch();
		} catch (err) {
			if (err instanceof ApiError && err.code === 'concurrency_conflict') {
				const current = err.details?.runner as Runner | undefined;
				if (current && current.id === editTarget?.id) {
					// Preserve unrelated unsaved fields, but require the operator to
					// re-enter a cap against the newly loaded revision.
					editTarget = current;
					editMaxConcurrent = current.max_concurrent;
				}
			}
			showError(err);
		} finally {
			savingEdit = false;
		}
	}

	/** Tiers apply unless the runner has a fixed configuration (custom harness). */
	const editTiersApply = $derived(editTarget !== null && editTarget.tier_models !== null);

	function effortChoices(runner: Runner | null, tier: ModelTier, modelOverride = ''): string[] {
		if (!runner) return [];
		const model = modelOverride.trim() || runner.tier_models?.[tier] || '';
		return runner.effort_models?.[model] ?? [];
	}

	const bootstrapCommand = $derived.by(() => {
		const origin = typeof location !== 'undefined' ? location.origin : '<tines-url>';
		const parts = [
			`TINES_API_KEY=${createdKey?.key ?? '<your-api-key>'}`,
			'tines runner install',
			`--url ${origin}`,
			`--name ${runnerName.trim() || '<name>'}`,
			`--harness ${runnerHarness}`
		];
		if (runnerHarness === 'custom') {
			parts.push(`--command '${(runnerCommand || '<template>').replaceAll("'", `'\\''`)}'`);
		}
		if (runnerMaxConcurrent !== 1) parts.push(`--max-concurrent ${runnerMaxConcurrent}`);
		if (runnerAllowRemoteConcurrency) parts.push('--allow-remote-concurrency');
		return parts.join(' \\\n  ');
	});

	/**
	 * While the account has no local runner online — or the dialog is open and
	 * someone is starting a daemon right now — watch for one arriving. A
	 * reconnecting machine emits `runner.updated`, not `runner.registered`, so
	 * this polls the runner list rather than the events feed: one request that
	 * catches register, reconnect and offline→online alike.
	 */
	const shouldPoll = $derived(
		addRunnerOpen ||
			checklistVisible ||
			data.runners.some((r) => r.concurrency_control?.status === 'pending') ||
			!data.runners.some((r) => r.type === 'local' && r.online)
	);
	const runnerSignature = (rs: Runner[]) =>
		rs
			.map(
				(r) =>
					`${r.id}:${r.online ? 1 : 0}:${r.max_concurrent}:${r.concurrency_control?.status ?? ''}:${r.concurrency_control?.reason ?? ''}:${r.concurrency_control?.ceiling ?? ''}:${r.concurrency_control?.revision ?? ''}:${r.concurrency_control?.applied_cap ?? ''}:${r.concurrency_control?.applied_revision ?? ''}:${r.concurrency_control?.applied_at ?? ''}`
			)
			.sort()
			.join(',');
	let syncingRunners = false;
	/** Newest account-level event id; the first non-empty observation also refreshes. */
	let latestAccountEventId: string | null = null;
	async function checkRunners() {
		if (syncingRunners) return;
		syncingRunners = true;
		try {
			// While the checklist shows, a rule, the kill switch and the first run
			// all tick it too — and none of them moves the runner signature. The
			// newest account event is one extra request that catches all three,
			// and only pre-first-run accounts pay for it.
			const [{ items }, events] = await Promise.all([
				api.listRunners(),
				checklistVisible ? api.listEvents({ limit: 1 }) : Promise.resolve(null)
			]);
			const newestEventId = events?.items[0]?.id ?? null;
			const eventMoved = newestEventId !== null && newestEventId !== latestAccountEventId;
			latestAccountEventId = newestEventId ?? latestAccountEventId;
			if (eventMoved || runnerSignature(items) !== runnerSignature(untrack(() => data.runners))) {
				// Re-runs the loader without remounting, so the open dialog,
				// the typed name and any created key survive the refresh.
				await invalidateAll();
			}
		} catch {
			// Transient: the next tick tries again.
		} finally {
			syncingRunners = false;
		}
	}
	$effect(() => {
		if (!shouldPoll) return;
		const tick = () => {
			if (document.visibilityState === 'visible') void checkRunners();
		};
		const timer = setInterval(tick, 5000);
		document.addEventListener('visibilitychange', tick);
		return () => {
			clearInterval(timer);
			document.removeEventListener('visibilitychange', tick);
		};
	});

	/**
	 * What the user actually needs on a fresh machine: the CLI, then one
	 * command that registers the runner and installs the daemon as a
	 * launchd/systemd service (which is what keeps it updated).
	 */
	const bootstrapBlock = $derived(`npm install -g tines\n${bootstrapCommand}`);

	async function copyBootstrapCommand() {
		try {
			await navigator.clipboard.writeText(bootstrapBlock);
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
			await refreshAfterDispatch();
		} catch (err) {
			showError(err);
		}
	}

	async function removeRunner(runner: Runner) {
		const ok = await confirmDialog({
			title: `Remove runner "${runner.name}"?`,
			body: 'Its run history goes with it. (Pausing keeps identity, rules, and history warm instead.)',
			confirmLabel: 'Remove runner',
			destructive: true
		});
		if (!ok) return;
		try {
			await api.deleteRunner(runner.id);
			await invalidateAll();
		} catch (err) {
			// Reject-by-default: the 422 names referencing rules and pins; offer
			// the force cascade (emptied rules are kept, flagged "no targets").
			if (err instanceof ApiError && err.code === 'runner_referenced') {
				const force = await confirmDialog({
					title: 'Strip these references and remove the runner?',
					body: err.message,
					confirmLabel: 'Strip and remove',
					destructive: true
				});
				if (force) {
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

	let showAllRuns = $state(untrack(() => data.runsState !== null));
	$effect(() => {
		if (data.runsState) showAllRuns = true;
	});
	const runStateName = $derived(
		data.workflows.flatMap((w) => w.states).find((s) => s.id === data.runsState)?.name ??
			data.runsState
	);
	const activeRuns = $derived(data.fleetRuns.filter((r) => isActiveRun(r.status)));
	const displayActiveRuns = $derived(data.displayRuns.filter((r) => isActiveRun(r.status)));
	const visibleRuns = $derived(showAllRuns ? data.displayRuns : displayActiveRuns);

	/** Utilization against the active policy — same math the CLI status shows. */
	const utilization = $derived.by(() => {
		const stateNames = new Map(
			data.workflows.flatMap((w) => w.states.map((s) => [s.id, s.name] as const))
		);
		return utilizationLabel(data.settings.quota, activeRuns, (id) => stateNames.get(id) ?? id);
	});

	/** The run awaiting the cancel dialog (strike note + optional comment). */
	let cancelTarget = $state<AgentRun | null>(null);

	// --- routing rules -----------------------------------------------------------

	let ruleModalOpen = $state(false);
	let editingRule = $state<RoutingRuleWithWarnings | null>(null);
	let ruleProjectId = $state('');
	/** Rules scoped to these are kept and badged; the editor keeps them selectable. */
	const archivedProjectIds = $derived(new Set(data.archivedProjects.map((p) => p.id)));
	/**
	 * The rule's own project when it is archived: without an option carrying the
	 * current value, saving would silently broaden the rule's scope.
	 */
	const archivedRuleProject = $derived(
		ruleProjectId && archivedProjectIds.has(ruleProjectId)
			? (data.archivedProjects.find((p) => p.id === ruleProjectId) ?? null)
			: null
	);
	let ruleStateId = $state('');
	let ruleLabelId = $state('');
	let labels = $state<LabelWithUsage[]>([]);
	/**
	 * The rule's own label, when the lazily-fetched list has not arrived (or
	 * no longer holds it): without an option carrying the current value the
	 * select would silently broaden the rule's scope on save.
	 */
	const missingRuleLabel = $derived(
		ruleLabelId && !labels.some((l) => l.id === ruleLabelId)
			? (editingRule?.scope.label_name ?? ruleLabelId)
			: null
	);

	/** One fetch the first time a rule editor opens; a failure just leaves the select empty. */
	function loadLabels() {
		if (labels.length > 0) return;
		api
			.listLabels()
			.then((res) => {
				labels = res.items;
			})
			.catch(() => {});
	}
	let ruleTargets = $state<{ runner_id: string; tier: '' | ModelTier; effort: string }[]>([]);
	let ruleMode = $state<'runners' | 'tier'>('runners');
	let ruleOverrideTier = $state<ModelTier>('smartest');
	let ruleOverrideEffort = $state('');
	let savingRule = $state(false);
	let ruleWarnings = $state<ShadowWarning[]>([]);
	const wildcardEffortChoices = $derived(
		[
			...new Set(data.runners.flatMap((runner) => Object.values(runner.effort_models ?? {}).flat()))
		].sort()
	);

	function targetEffortChoices(target: (typeof ruleTargets)[number]): string[] {
		const runner = data.runners.find((candidate) => candidate.id === target.runner_id);
		if (!runner) return [];
		const tier = target.tier || runner.default_tier;
		const override = runner.tiers?.[tier]?.model ?? '';
		return effortChoices(runner, tier, override);
	}

	/**
	 * The supervisor only dispatches issues in active-category states, so only
	 * those are valid rule scopes — a rule on a backlog/human-review/done
	 * state could never match (the server rejects them too).
	 */
	const routableWorkflows = $derived(
		data.workflows
			.map((w) => ({ ...w, states: w.states.filter((s) => s.category === 'active') }))
			.filter((w) => w.states.length > 0)
	);
	/** A pre-validation rule's scoped state that is no longer (or never was) routable. */
	const staleRuleState = $derived.by(() => {
		if (!ruleStateId) return null;
		const state = data.workflows.flatMap((w) => w.states).find((s) => s.id === ruleStateId);
		return state && state.category !== 'active' ? state : null;
	});
	const activeStateIds = $derived(deriveActiveStateIds(data.workflows));

	function openRuleCreate(prefill: { stateId?: string; projectId?: string } = {}) {
		// Shadow hints belong to the last save; opening an editor stales them.
		ruleWarnings = [];
		editingRule = null;
		ruleProjectId = prefill.projectId ?? data.focusId ?? '';
		ruleStateId = prefill.stateId ?? '';
		ruleLabelId = '';
		ruleTargets =
			data.runners.length > 0 ? [{ runner_id: data.runners[0].id, tier: '', effort: '' }] : [];
		ruleMode = 'runners';
		ruleOverrideTier = 'smartest';
		ruleOverrideEffort = '';
		loadLabels();
		ruleModalOpen = true;
	}

	let handledRuleUrl = '';
	afterNavigate(() => {
		const key = page.url.href;
		const clean = new URL(page.url);
		let changed = false;
		if (key !== handledRuleUrl && page.url.searchParams.get('new') === 'rule') {
			handledRuleUrl = key;
			const projectId = page.url.searchParams.get('project');
			const project = projectId
				? data.projects.find((candidate) => candidate.id === projectId)
				: null;
			// `new` and `project` are one-shot instructions, including when invalid.
			clean.searchParams.delete('new');
			clean.searchParams.delete('project');
			changed = true;
			if (project) openRuleCreate({ projectId: project.id });
			else errorMessage = 'That project is unavailable for routing.';
		}
		if (agentsView === 'spend') {
			const defaults = canonicalSpendChanges(clean, data.focusId);
			for (const [name, value] of Object.entries(defaults)) {
				clean.searchParams.set(name, value as string);
				changed = true;
			}
		}
		if (changed) void navigateAgents(clean, true);
		else if (agentsView === 'now' && page.url.hash === '#runs')
			void tick().then(() => document.getElementById('runs')?.scrollIntoView({ block: 'start' }));
	});

	function openRuleEdit(rule: RoutingRuleWithWarnings) {
		ruleWarnings = [];
		editingRule = rule;
		ruleProjectId = rule.scope.project_id ?? '';
		ruleStateId = rule.scope.workflow_state_id ?? '';
		ruleLabelId = rule.scope.label_id ?? '';
		const tierOnly = rule.targets.length === 1 && rule.targets[0]?.runner_id === '*';
		ruleMode = tierOnly ? 'tier' : 'runners';
		ruleOverrideTier = tierOnly ? (rule.targets[0]!.tier ?? 'smartest') : 'smartest';
		ruleOverrideEffort = tierOnly ? (rule.targets[0]!.effort ?? '') : '';
		ruleTargets = tierOnly
			? data.runners.length > 0
				? [{ runner_id: data.runners[0].id, tier: '', effort: '' }]
				: []
			: rule.targets.map((t) => ({
					runner_id: t.runner_id,
					tier: t.tier ?? '',
					effort: t.effort ?? ''
				}));
		loadLabels();
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
			const targets: RoutingTarget[] =
				ruleMode === 'tier'
					? [
							{
								runner_id: '*',
								tier: ruleOverrideTier,
								...(ruleOverrideEffort ? { effort: ruleOverrideEffort } : {})
							}
						]
					: ruleTargets.map((t) => ({
							runner_id: t.runner_id,
							...(t.tier ? { tier: t.tier } : {}),
							...(t.effort ? { effort: t.effort } : {})
						}));
			const scope = {
				project_id: ruleProjectId || null,
				workflow_state_id: ruleStateId || null,
				label_id: ruleLabelId || null
			};
			const saved = editingRule
				? await api.updateRoutingRule(editingRule.id, { ...scope, targets })
				: await api.createRoutingRule({ ...scope, targets });
			// Shadow hints surface at authoring time, right where the rule was saved.
			ruleWarnings = saved.warnings;
			ruleModalOpen = false;
			await refreshAfterDispatch();
		} catch (err) {
			showError(err);
		} finally {
			savingRule = false;
		}
	}

	async function deleteRule(rule: RoutingRuleWithWarnings) {
		const ok = await confirmDialog({
			title: `Delete the ${rule.scope.label} routing rule?`,
			body: 'Matching issues will be re-evaluated against the remaining rules.',
			confirmLabel: 'Delete rule',
			destructive: true
		});
		if (!ok) return;
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

	// The GitHub PAT: write-only (only the fingerprint hint comes back).
	let patInput = $state('');
	let savingPat = $state(false);
	/** Transient static revoke guidance after a replace (flow 16). */
	let patReplacedNote = $state<string | null>(null);

	async function savePat(e: SubmitEvent) {
		e.preventDefault();
		if (savingPat || patInput.trim() === '') return;
		savingPat = true;
		const replacing = data.settings.github_pat_hint !== null;
		try {
			await api.updateSupervisorSettings({ github_pat: patInput.trim() });
			patInput = '';
			if (replacing) {
				// In-flight runs launched with the old credential are bounded by
				// the largest managed-runner timeout — no live tracking needed.
				const maxMinutes = Math.max(
					0,
					...data.runners.filter((r) => r.type !== 'local').map((r) => r.max_run_minutes)
				);
				patReplacedNote = `Replaced. Safe to revoke the old token in ${maxMinutes || 30} minutes — any in-flight run launched with it is done by then.`;
				setTimeout(() => (patReplacedNote = null), 30_000);
			}
			await invalidateAll();
		} catch (err) {
			showError(err);
		} finally {
			savingPat = false;
		}
	}

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
			await refreshAfterDispatch();
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
		<p class="text-muted-foreground mt-1 max-w-2xl text-xs">
			{data.settings.enabled
				? 'Eligible work can start once a runner is available and routing matches.'
				: 'Automation stays stopped until you resume it.'}
		</p>
	</div>
</div>

<nav class="mb-6 flex gap-2" aria-label="Agents view">
	<Button
		variant={agentsView === 'now' ? 'secondary' : 'ghost'}
		aria-current={agentsView === 'now' ? 'page' : undefined}
		onclick={() => chooseAgentsView('now')}>Now</Button
	>
	<Button
		variant={agentsView === 'spend' ? 'secondary' : 'ghost'}
		aria-current={agentsView === 'spend' ? 'page' : undefined}
		onclick={() => chooseAgentsView('spend')}>Spend</Button
	>
</nav>

{#if navigationError}
	<p
		class="border-destructive/40 bg-destructive/10 text-destructive mb-4 rounded-md border px-4 py-2.5 text-sm"
	>
		Navigation failed: {navigationError}
		{#if failedAgentsUrl}<button
				type="button"
				class="ml-2 underline"
				onclick={() => void navigateAgents(failedAgentsUrl!)}>Retry</button
			>{/if}
	</p>
{/if}

{#if agentsView === 'spend'}
	<SpendPanel
		projects={data.projects}
		archivedProjects={data.archivedProjects}
		workflows={data.workflows}
		focusId={data.focusId}
		navigate={patchAgents}
	/>
{:else}
	{#if errorMessage}
		<div
			class="border-destructive/40 bg-destructive/10 text-destructive mb-4 rounded-md border px-4 py-2.5 text-sm"
			transition:slide={{ duration: dur() }}
		>
			{errorMessage}
		</div>
	{/if}

	<!-- Before the first run the checklist includes automation readiness as one of six steps. -->
	{#if checklistVisible}
		<FirstRunChecklist
			inputs={checklistInputs}
			oncreateissue={() => (newIssueOpen = true)}
			onaddrunner={() => (addRunnerOpen = true)}
			onroute={routeToSoleRunner}
			onenable={() => setEnabled(true)}
			onerror={showError}
		/>
		<NewIssueModal bind:open={newIssueOpen} projects={data.projects} workflows={data.workflows} />
	{:else if !data.settings.enabled}
		<!-- kill-switch off-state banner: persistent while automation is disabled -->
		<div
			class="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-300"
		>
			<span class="flex items-center gap-2">
				<IconAlertTriangle size={16} stroke={1.75} />
				Automation is off — nothing dispatches until you turn it on.
			</span>
			<Button size="sm" onclick={() => setEnabled(true)} disabled={togglingEnabled}
				>Resume automation</Button
			>
		</div>
	{/if}

	<!-- Now row: what is waiting, and why (Tines/256) -->
	<div class="mb-3 flex justify-end">
		<label class="text-muted-foreground flex items-center gap-2 text-xs">
			Board project
			<Select
				value={data.boardProject ?? ''}
				onchange={(event) => filterProject(event.currentTarget.value)}
			>
				<option value="">All projects</option>
				{#each data.projects as project (project.id)}
					<option value={project.id}>{project.name}</option>
				{/each}
			</Select>
		</label>
	</div>

	<FleetQueuePanel
		queue={data.queue}
		runners={data.runners}
		now={data.queue.generated_at}
		onraisecap={(runner) => {
			editFocusCap = true;
			openRunnerEdit(runner);
		}}
		onquota={focusQuota}
		onswitchtoroster={switchToRoster}
		onaddrule={(stateId) => openRuleCreate({ stateId })}
		oneditrule={(ruleId) => {
			const rule = data.rules.find((r) => r.id === ruleId);
			if (rule) openRuleEdit(rule);
		}}
		onresumerunner={(runner) => setRunnerStatus(runner, 'active')}
		onresume={resumeParked}
		onenable={() => setEnabled(true)}
	/>

	<!-- Runners -->
	<StageStatsBoard
		report={data.stats}
		boardProject={data.boardProject}
		oncapacity={focusStatsCapacity}
		onsentback={openSentBack}
	/>
	{#if sentBackStage && sentBackReport}<SentBackDrilldown
			open={sentBackOpen}
			stage={sentBackStage}
			report={sentBackReport}
			project={data.boardProject}
			onclose={() => (sentBackOpen = false)}
		/>{/if}

	<div class="mb-10 scroll-mt-24" id="runners">
		<div class="mb-3 flex items-center justify-between">
			<h2 class="text-sm font-semibold">Runners</h2>
			<Button size="sm" variant="ghost" onclick={() => (addRunnerOpen = true)}>
				<IconPlus size={14} /> Add runner
			</Button>
		</div>
		{#if data.runners.length === 0}
			<div class="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">
				No runners yet. Add a local runner for this machine, or a Claude managed runner that works
				issues in the cloud (Gemini arrives in a later milestone).
				<div class="mt-3">
					<Button size="sm" variant="outline" onclick={() => (addRunnerOpen = true)}>
						<IconPlus size={14} /> Add runner
					</Button>
				</div>
			</div>
		{:else}
			<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{#each data.runners as runner (runner.id)}
					<div class="rounded-lg border p-4" id={`runner-${runner.id}`}>
						<div class="mb-2 flex items-center gap-2">
							<span
								class="bg-muted text-muted-foreground flex size-8 items-center justify-center rounded-md"
							>
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
							{runner.active_runs}/{runner.max_concurrent} runs · {runner.max_run_minutes}m timeout
							{#if runner.concurrency_control}
								· local ceiling {runner.concurrency_control.ceiling ?? 'unknown'}
								· {runner.concurrency_control.status === 'applied'
									? 'applied'
									: runner.concurrency_control.status === 'pending'
										? `pending — daemon last confirmed ${runner.concurrency_control.applied_cap ?? 'none'}`
										: runner.concurrency_control.reason === 'opted_out'
											? 'web adjustment off'
											: 'web adjustment unavailable'}
							{/if}
							· default tier {runner.default_tier}
							{#if waitingByRunner.has(runner.id)}
								{@const runnerWaiting = waitingByRunner.get(runner.id)!}
								·
								<a
									class="text-amber-700 underline underline-offset-2 dark:text-amber-400"
									href={runnerWaiting.href}
								>
									{runnerWaiting.count} waiting
								</a>
							{/if}
							{#if runner.budget?.max_run_cost_usd !== undefined}
								· ${runner.budget.max_run_cost_usd}/run
							{/if}
							{#if rateLimited(runner, now)}
								<span class="text-amber-600 dark:text-amber-400"
									>· usage limit — resumes {new Date(
										runner.backoff_until as number
									).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span
								>
							{/if}
							{#if runner.launch_failures > 0}
								<span class="text-amber-600 dark:text-amber-400"
									>· {runner.launch_failures} consecutive failures</span
								>
							{/if}
						</p>
						<div class="flex flex-wrap gap-2">
							{#if runner.status === 'paused'}
								<Button
									size="sm"
									variant="outline"
									onclick={() => setRunnerStatus(runner, 'active')}>Resume</Button
								>
							{:else}
								<Button
									size="sm"
									variant="outline"
									onclick={() => setRunnerStatus(runner, 'paused')}>Pause</Button
								>
							{/if}
							<Button size="sm" variant="ghost" onclick={() => openRunnerEdit(runner)}>Edit</Button>
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
							<Button
								size="sm"
								variant="ghost"
								class="text-destructive"
								onclick={() => removeRunner(runner)}
							>
								<IconTrash size={14} /> Remove
							</Button>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>

	<!-- Runs -->
	<div class="mb-10 scroll-mt-24" id="runs">
		<div class="mb-3 flex flex-wrap items-center justify-between gap-2">
			<h2 class="text-sm font-semibold">
				Runs
				<span class="text-muted-foreground font-normal">— {utilization}</span>
			</h2>
			{#if data.runsState}
				<a
					class="bg-muted rounded-full px-2 py-1 text-xs hover:underline"
					href={stageRunsHref(page.url, null)}
				>
					Latest runs for this stage: {runStateName} · {data.stats.project?.name ?? 'All projects'} ·
					clear
				</a>
			{/if}
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
					<RunRow {run} showIssueRef oncancel={(r) => (cancelTarget = r)} />
				{/each}
			</ul>
		{/if}
	</div>

	<!-- Routing -->
	<div class="mb-10" id="routing">
		<div class="mb-3 flex items-start justify-between gap-3">
			<div>
				<h2 class="text-sm font-semibold">Routing</h2>
				<p class="text-muted-foreground mt-0.5 text-xs">
					Most specific matching rule wins — label beats project beats state; a global rule is the
					fallback. Listed most specific first.
				</p>
			</div>
			<Button size="sm" variant="ghost" class="shrink-0" onclick={() => openRuleCreate()}>
				<IconPlus size={14} /> Add rule
			</Button>
		</div>
		{#if data.runners.length > 0 && data.rules.length === 0}
			<div
				class="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300"
			>
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
					<button
						type="button"
						class="shrink-0"
						aria-label="Dismiss"
						onclick={() => (ruleWarnings = [])}
					>
						<IconX size={14} />
					</button>
				</div>
			</div>
		{/if}
		{#if data.displayRules.length === 0}
			<div class="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">
				No routing rules. A rule is an ordered runner preference list at a scope — add one to start
				dispatching issues to agents.
				<div class="mt-3">
					{#if data.runners.length === 0}
						<Button size="sm" variant="outline" onclick={() => (addRunnerOpen = true)}>
							<IconPlus size={14} /> Add a runner first
						</Button>
					{:else}
						<Button size="sm" variant="outline" onclick={() => openRuleCreate({ projectId: '' })}>
							<IconPlus size={14} /> Add a global rule
						</Button>
					{/if}
				</div>
			</div>
		{:else}
			<ul class="divide-y rounded-lg border" aria-label="Routing rules">
				{#each data.displayRules as rule (rule.id)}
					<RoutingRuleRow
						{rule}
						{activeStateIds}
						projectArchived={rule.scope.project_id !== null &&
							archivedProjectIds.has(rule.scope.project_id)}
						waiting={waitingByRule.get(rule.id)}
						onedit={openRuleEdit}
						ondelete={deleteRule}
					/>
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
						class="bg-background absolute top-0.5 left-0.5 size-5 rounded-full shadow transition-transform {data
							.settings.enabled
							? 'translate-x-5'
							: ''}"
					></span>
				</button>
			</div>

			<form onsubmit={saveSettings} class="space-y-5">
				<div class="space-y-2">
					<p class="text-sm font-medium" id="quota-policy">Quota policy</p>
					<!-- segmented control -->
					<div class="bg-muted inline-flex rounded-md p-0.5 text-sm">
						<button
							type="button"
							class="rounded px-3 py-1 {quotaType === 'global_cap'
								? 'bg-background font-medium shadow-xs'
								: 'text-muted-foreground'}"
							onclick={() => (quotaType = 'global_cap')}
						>
							Global cap
						</button>
						<button
							type="button"
							class="rounded px-3 py-1 {quotaType === 'state_roster'
								? 'bg-background font-medium shadow-xs'
								: 'text-muted-foreground'}"
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
										<p class="text-muted-foreground mb-1.5 text-xs font-semibold">
											{workflow.name}
										</p>
										<div class="space-y-1.5">
											{#each workflow.states as state (state.id)}
												{@const waiting = waitingByState.get(state.id)}
												<div
													class="flex items-center justify-between gap-2 rounded-md {highlightStateId ===
													state.id
														? 'ring-2 ring-amber-400'
														: ''}"
												>
													<span class="flex min-w-0 items-center gap-2">
														<StateBadge {state} />
														{#if waiting}
															<a
																class="text-xs text-amber-700 underline underline-offset-2 dark:text-amber-400"
																href={waiting.href}
															>
																{waiting.count} waiting · oldest {queueAge(
																	waiting.oldest,
																	waiting.now
																)}
															</a>
														{/if}
													</span>
													<span class="flex items-center gap-2">
														{#if (rosterOverrides[state.id] ?? '') === ''}
															<span class="text-muted-foreground text-xs"
																>inherits {rosterDefault}</span
															>
														{/if}
														<Input
															id="roster-limit-{state.id}"
															type="number"
															min="0"
															max="100"
															class="w-20"
															placeholder={String(rosterDefault)}
															aria-label={`Limit for ${workflow.name} / ${state.name}`}
															value={rosterOverrides[state.id] ?? ''}
															oninput={(e) =>
																(rosterOverrides = {
																	...rosterOverrides,
																	[state.id]: e.currentTarget.value
																})}
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

			<!-- GitHub PAT: one credential shared across managed runners, write-only -->
			<form onsubmit={savePat} class="space-y-1.5 border-t pt-5">
				<p class="text-sm font-medium">GitHub access</p>
				{#if data.settings.github_pat_hint}
					<p class="text-muted-foreground text-xs">
						A personal access token is stored ({data.settings.github_pat_hint}) — write-only; paste
						a new one to replace it.
					</p>
				{:else}
					<p class="text-muted-foreground text-xs">
						No token stored. Managed runners clone repositories with this token; without one, their
						runs fail at clone time.
					</p>
				{/if}
				<div class="flex items-center gap-2">
					<Input
						type="password"
						class="flex-1"
						placeholder={data.settings.github_pat_hint
							? 'Paste a new fine-grained PAT'
							: 'github_pat_…'}
						aria-label="GitHub personal access token"
						bind:value={patInput}
					/>
					<Button type="submit" variant="outline" disabled={savingPat || patInput.trim() === ''}>
						{savingPat ? 'Saving…' : data.settings.github_pat_hint ? 'Replace' : 'Save token'}
					</Button>
				</div>
				{#if patReplacedNote}
					<p
						class="text-xs text-emerald-700 dark:text-emerald-400"
						transition:slide={{ duration: dur() }}
					>
						{patReplacedNote}
					</p>
				{/if}
				<p class="text-muted-foreground text-xs">
					Use a fine-grained token scoped to exactly the repos your context items point at — the
					token never enters an agent's sandbox, but every run wields its full authority, so that
					repo set is the blast radius of a compromised run.
				</p>
				<PatInstructions repoUrls={data.contextRepoUrls} />
			</form>
		</div>
	</div>
{/if}

<!-- add runner: local shows the daemon bootstrap (the daemon registers itself);
     Claude managed creates the runner here with a ping-validated key -->
<Modal bind:open={addRunnerOpen} title="Add runner" onclose={resetAddRunner}>
	{#if createdRunner}
		<!-- final, skippable step: add the new runner to routing (flow 3) -->
		<div class="space-y-4">
			<p class="text-sm">
				Runner <span class="font-medium">{createdRunner.name}</span> is ready — managed runners are always
				online. It won't take work until a routing rule (or an issue pin) targets it.
			</p>
			<p class="text-muted-foreground text-xs">
				{#if globalRule}
					Add it to your global rule as a fallback target?
				{:else}
					Create a global rule routing everything to it?
				{/if}
			</p>
			<div class="flex flex-wrap justify-end gap-2">
				<Button variant="ghost" disabled={addingToRouting} onclick={resetAddRunner}>
					Skip for now
				</Button>
				<PendingButton
					variant="outline"
					pending={addingToRouting}
					pendingLabel="Adding…"
					onclick={addCreatedToRouting}
				>
					Add to routing
				</PendingButton>
			</div>
		</div>
	{:else}
		<div class="space-y-4">
			<div class="bg-muted inline-flex rounded-md p-0.5 text-sm">
				<button
					type="button"
					class="rounded px-3 py-1 {addRunnerType === 'local'
						? 'bg-background font-medium shadow-xs'
						: 'text-muted-foreground'}"
					onclick={() => (addRunnerType = 'local')}
				>
					Local
				</button>
				<button
					type="button"
					class="rounded px-3 py-1 {addRunnerType === 'claude_managed'
						? 'bg-background font-medium shadow-xs'
						: 'text-muted-foreground'}"
					onclick={() => (addRunnerType = 'claude_managed')}
				>
					Claude (managed)
				</button>
			</div>

			{#if addRunnerType === 'claude_managed'}
				<form onsubmit={createClaudeRunner} class="space-y-4">
					<div class="grid grid-cols-2 gap-3">
						<div class="space-y-1.5">
							<label class="text-sm font-medium" for="claude-name">Name</label>
							<Input id="claude-name" bind:value={runnerName} placeholder="cloud-claude" required />
						</div>
						<div class="space-y-1.5">
							<label class="text-sm font-medium" for="claude-tier">Default tier</label>
							<Select id="claude-tier" bind:value={claudeDefaultTier}>
								{#each MODEL_TIERS as tier (tier)}
									<option value={tier}>{tier}</option>
								{/each}
							</Select>
						</div>
					</div>
					<div class="space-y-1.5">
						<label class="text-sm font-medium" for="claude-key">Anthropic API key</label>
						<Input
							id="claude-key"
							type="password"
							bind:value={claudeApiKey}
							placeholder="sk-ant-…"
							required
						/>
						<p class="text-muted-foreground text-xs">
							Validated with a ping before anything is created; encrypted at rest and write-only
							after — the edit view only shows that a key is set.
						</p>
					</div>
					<div class="grid grid-cols-2 gap-3">
						<div class="space-y-1.5">
							<label class="text-sm font-medium" for="claude-cap">Max concurrent runs</label>
							<Input
								id="claude-cap"
								type="number"
								min="1"
								max="100"
								value={claudeMaxConcurrent}
								oninput={(e) =>
									(claudeMaxConcurrent = Number.parseInt(e.currentTarget.value, 10) || 1)}
							/>
						</div>
						<div class="space-y-1.5">
							<label class="text-sm font-medium" for="claude-minutes">Run timeout (minutes)</label>
							<Input
								id="claude-minutes"
								type="number"
								min="1"
								max="1440"
								value={claudeMaxMinutes}
								oninput={(e) =>
									(claudeMaxMinutes = Number.parseInt(e.currentTarget.value, 10) || 30)}
							/>
						</div>
					</div>
					<div class="space-y-1.5">
						<label class="flex items-center gap-2 text-sm font-medium">
							<input type="checkbox" bind:checked={claudeCapEnabled} class="accent-primary" />
							Per-run cost cap
						</label>
						{#if claudeCapEnabled}
							<div class="flex items-center gap-2" transition:slide={{ duration: dur() }}>
								<span class="text-muted-foreground text-sm">$</span>
								<Input
									type="number"
									min="0.01"
									step="0.01"
									class="w-24"
									aria-label="Per-run cost cap in dollars"
									value={claudeCapUsd}
									oninput={(e) =>
										(claudeCapUsd = Number(e.currentTarget.value) || DEFAULT_MANAGED_RUN_COST_USD)}
								/>
								<span class="text-muted-foreground text-xs">
									per run, enforced by the platform — the session pauses at the cap and the run
									ends.
								</span>
							</div>
						{:else}
							<p
								class="text-xs text-amber-700 dark:text-amber-400"
								transition:slide={{ duration: dur() }}
							>
								Uncapped: a run is bounded only by its timeout × burn rate.
							</p>
						{/if}
					</div>
					{#if !data.settings.github_pat_hint}
						<div class="space-y-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
							<label class="text-sm font-medium" for="claude-pat"
								>GitHub access (needed to clone)</label
							>
							<Input
								id="claude-pat"
								type="password"
								bind:value={claudePat}
								placeholder="github_pat_…"
							/>
							<p class="text-muted-foreground text-xs">
								No PAT is stored yet — without one, this runner's first run fails at clone time. Use
								a fine-grained token scoped to exactly the repos your context items point at: the
								token never enters the sandbox, but every run wields its full authority, so that
								repo set is the blast radius of a compromised run. Stored once in supervisor
								settings, shared by all managed runners.
							</p>
							<PatInstructions repoUrls={data.contextRepoUrls} />
						</div>
					{/if}
					<div class="flex flex-wrap justify-end gap-2">
						<Button
							type="button"
							variant="ghost"
							disabled={creatingClaude}
							onclick={resetAddRunner}
						>
							Cancel
						</Button>
						<PendingButton
							type="submit"
							pending={creatingClaude}
							pendingLabel="Validating key…"
							disabled={!runnerName.trim() || !claudeApiKey.trim()}
						>
							Create runner
						</PendingButton>
					</div>
				</form>
			{:else}
				<div class="space-y-4">
					<div class="grid grid-cols-2 gap-3">
						<div class="space-y-1.5">
							<label class="text-sm font-medium" for="runner-name">Name</label>
							<Input
								id="runner-name"
								bind:value={runnerName}
								placeholder={namePlaceholder}
								readonly={createdKey !== null}
								aria-invalid={nameIssue?.level === 'error' || undefined}
								aria-describedby="runner-name-help"
							/>
							<p class="text-muted-foreground text-xs" id="runner-name-help">
								Name it machine-plus-harness, like
								<span class="font-medium">{namePlaceholder}</span> — it is what every agent comment
								will say ("you via {namePlaceholder}") and what routing rules address.
							</p>
							{#if nameIssue}
								<p
									class="text-xs {nameIssue.level === 'error'
										? 'text-destructive'
										: 'text-amber-700 dark:text-amber-300'}"
								>
									{nameIssue.message}
								</p>
							{/if}
							{#if createdKey}
								<p class="text-muted-foreground text-xs">
									The key is named after this runner — close the dialog to start over with another
									name.
								</p>
							{/if}
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
						<label class="text-sm font-medium" for="runner-cap">
							{runnerAllowRemoteConcurrency ? 'Local concurrency ceiling' : 'Max concurrent runs'}
						</label>
						<Input
							id="runner-cap"
							type="number"
							min="1"
							max="100"
							class="w-24"
							value={runnerMaxConcurrent}
							oninput={(e) =>
								(runnerMaxConcurrent = Number.parseInt(e.currentTarget.value, 10) || 1)}
						/>
					</div>
					<label class="flex items-start gap-2 text-sm">
						<input type="checkbox" bind:checked={runnerAllowRemoteConcurrency} class="mt-0.5" />
						<span>
							Allow web adjustment up to this local ceiling. New runners start at 1; a higher
							request can increase machine and provider resource use.
						</span>
					</label>

					<div class="space-y-1.5">
						<p class="text-sm font-medium">Run this on the machine</p>
						<div class="relative">
							<pre
								class="bg-muted overflow-x-auto rounded-md border p-3 pr-10 font-mono text-xs">{bootstrapBlock}</pre>
							<Button
								size="icon"
								variant="ghost"
								class="absolute top-1.5 right-1.5 size-7"
								aria-label="Copy the bootstrap command"
								disabled={!nameReady}
								title={nameReady ? undefined : 'Enter a valid runner name first'}
								onclick={copyBootstrapCommand}
							>
								<IconCopy size={14} />
							</Button>
							{#if commandCopied}
								<span class="text-muted-foreground absolute right-0 -bottom-5 text-xs">copied</span>
							{/if}
						</div>
						<div class="flex flex-wrap items-center gap-2 pt-1">
							{#if !createdKey}
								<PendingButton
									type="button"
									size="sm"
									variant="outline"
									pending={creatingKey}
									pendingLabel="Creating…"
									disabled={!nameReady}
									onclick={createRunnerKey}
								>
									<IconKey size={14} /> Create key
								</PendingButton>
								<span class="text-muted-foreground text-xs">
									Creates an API key named
									<code class="bg-muted rounded px-1 py-0.5">runner {trimmedName || '<name>'}</code>
									and drops it into the command — or use one from
									<a href="/settings/api-keys" class="underline underline-offset-2"
										>Settings → API keys</a
									>.
								</span>
							{:else}
								<span class="text-muted-foreground text-xs">
									Key <code class="bg-muted rounded px-1 py-0.5">runner {trimmedName}</code> created
									and filled in above — copy the block now; the key will not be shown again. Manage
									it on
									<a href="/settings/api-keys" class="underline underline-offset-2"
										>Settings → API keys</a
									>.
								</span>
							{/if}
						</div>
						{#if namedLocalOnline}
							<div
								class="mt-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs"
								transition:slide={{ duration: dur() }}
							>
								<p>
									<span class="font-medium">{namedLocalOnline.name} is online.</span> It won't take work
									until a routing rule targets it.
								</p>
								<div class="mt-2 flex items-center gap-2">
									<PendingButton
										type="button"
										size="sm"
										pending={addingToRouting}
										pendingLabel="Adding…"
										disabled={globalRule?.targets.some((t) => t.runner_id === namedLocalOnline.id)}
										onclick={routeEverythingToNamed}
									>
										{globalRule?.targets.some((t) => t.runner_id === namedLocalOnline.id)
											? 'Already routed'
											: `Route everything to ${namedLocalOnline.name}`}
									</PendingButton>
									<Button size="sm" variant="ghost" onclick={resetAddRunner}>Done</Button>
								</div>
							</div>
						{:else}
							<p class="text-muted-foreground pt-1 text-xs">
								Waiting for <span class="font-medium">{trimmedName || 'the runner'}</span> — the
								install <span class="font-medium">registers</span> it with your API key, stores its own
								long-lived runner token on the machine, and loads the daemon as a service; it appears
								here, online, within seconds. The service reconnects with the stored token — the API key
								is only needed once.
							</p>
						{/if}
						<p class="text-muted-foreground text-xs">
							Keep it running: the install puts the daemon under launchd/systemd, so it survives
							logouts and reboots and restarts itself onto each new release. To run it in the
							foreground instead, use
							<code class="bg-muted rounded px-1 py-0.5">tines runner daemon</code> with the same
							flags (details in
							<code class="bg-muted rounded px-1 py-0.5">docs/runner-daemon.md</code>).
						</p>
					</div>
					<div class="flex justify-end">
						<Button variant="outline" onclick={resetAddRunner}>Done</Button>
					</div>
				</div>
			{/if}
		</div>
	{/if}
</Modal>

<!-- runner edit: caps, budget, tier overrides, replace-key -->
{#if editTarget}
	<Modal
		open={true}
		onclose={() => {
			editTarget = null;
			editFocusCap = false;
		}}
		title="Edit runner"
		initialFocus={focusCapField}
	>
		<form onsubmit={saveRunnerEdit} class="space-y-4">
			<p class="min-w-0 text-sm [overflow-wrap:anywhere]">
				<span class="font-medium">{editTarget.name}</span>
				<span class="text-muted-foreground">({editTarget.type})</span>
			</p>
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
				<div class="min-w-0 space-y-1.5">
					<label class="text-sm font-medium" for="edit-concurrent">
						{editTarget.type === 'local' ? 'Requested concurrency' : 'Max concurrent'}
					</label>
					<Input
						id="edit-concurrent"
						type="number"
						min="1"
						max="100"
						disabled={editTarget.type === 'local' &&
							editTarget.concurrency_control?.status === 'unavailable'}
						value={editMaxConcurrent}
						oninput={(e) => (editMaxConcurrent = Number.parseInt(e.currentTarget.value, 10) || 1)}
					/>
					{#if editTarget.type === 'local'}
						<p class="text-muted-foreground text-xs">
							Effective scheduling cap {editTarget.max_concurrent} · Local ceiling
							{editTarget.concurrency_control?.ceiling ?? 'unknown'} ·
							{editTarget.concurrency_control?.status === 'unavailable'
								? editTarget.concurrency_control.reason === 'opted_out'
									? 'Enable web adjustment locally with --allow-remote-concurrency.'
									: 'Upgrade or reconnect the daemon, then wait for its first poll.'
								: editTarget.concurrency_control?.status === 'applied'
									? 'Applied.'
									: `Pending — daemon last confirmed ${editTarget.concurrency_control?.applied_cap ?? 'none'}.`}
						</p>
					{/if}
				</div>
				<div class="min-w-0 space-y-1.5">
					<label class="text-sm font-medium" for="edit-minutes">Timeout (min)</label>
					<Input
						id="edit-minutes"
						type="number"
						min="1"
						max="1440"
						value={editMaxMinutes}
						oninput={(e) => (editMaxMinutes = Number.parseInt(e.currentTarget.value, 10) || 30)}
					/>
				</div>
				<div class="min-w-0 space-y-1.5">
					<label class="text-sm font-medium" for="edit-default-tier">Default tier</label>
					<Select id="edit-default-tier" bind:value={editDefaultTier} disabled={!editTiersApply}>
						{#each MODEL_TIERS as tier (tier)}
							<option value={tier}>{tier}</option>
						{/each}
					</Select>
				</div>
			</div>

			<div class="space-y-1.5">
				<p class="text-sm font-medium">Tiers</p>
				{#if !editTiersApply}
					<p class="text-muted-foreground text-xs">
						Tiers don't apply to this runner — its custom harness runs a fixed configuration, so it
						satisfies any tier with it (runs record the requested tier with the model unknown).
					</p>
				{:else}
					<p class="text-muted-foreground text-xs">
						Leave a tier blank to use the built-in (it silently improves as models ship); an
						override stays frozen until touched.
					</p>
					{#each MODEL_TIERS as tier (tier)}
						{@const builtin = editTarget.tier_models?.[tier] ?? null}
						{@const stale = isStaleTierOverride(builtin, editTierModels[tier]?.trim() || null)}
						{@const showsEffort =
							editTarget.type === 'claude_managed' || editTarget.type === 'local'}
						<div class="min-w-0 space-y-1">
							<div
								class="grid min-w-0 grid-cols-1 gap-2 sm:items-end {showsEffort
									? 'sm:grid-cols-[5rem_minmax(0,1fr)_7rem]'
									: 'sm:grid-cols-[5rem_minmax(0,1fr)]'}"
							>
								<label
									class="text-muted-foreground text-xs sm:text-right"
									for={`edit-model-${tier}`}>{tier}</label
								>
								<Input
									id={`edit-model-${tier}`}
									class="w-full min-w-0"
									placeholder={builtin ? `${builtin} (built-in)` : 'model id'}
									aria-label={`Model override for ${tier}`}
									value={editTierModels[tier] ?? ''}
									oninput={(e) =>
										(editTierModels = { ...editTierModels, [tier]: e.currentTarget.value })}
								/>
								{#if showsEffort}
									{@const choices = effortChoices(editTarget, tier, editTierModels[tier] ?? '')}
									<div class="min-w-0 space-y-1.5">
										<label class="text-sm font-medium sm:sr-only" for={`edit-effort-${tier}`}
											>Effort</label
										>
										<Select
											id={`edit-effort-${tier}`}
											class="w-full min-w-0"
											aria-label={`Effort for ${tier}`}
											value={editTierEfforts[tier] ?? ''}
											disabled={(editTierModels[tier] ?? '').trim() === '' || choices.length === 0}
											onchange={(e) =>
												(editTierEfforts = { ...editTierEfforts, [tier]: e.currentTarget.value })}
										>
											<option value="">effort —</option>
											{#if editTierEfforts[tier] && !choices.includes(editTierEfforts[tier])}
												<option value={editTierEfforts[tier]}
													>{editTierEfforts[tier]} (incompatible)</option
												>
											{/if}
											{#each choices as effort (effort)}
												<option value={effort}>{effort}</option>
											{/each}
										</Select>
									</div>
								{/if}
							</div>
							{#if stale}
								<p class="text-muted-foreground pl-0 text-xs [overflow-wrap:anywhere] sm:pl-22">
									<span class="text-amber-700 dark:text-amber-400">stale override</span> — the
									built-in for {tier} is now {builtin}
								</p>
							{/if}
						</div>
					{/each}
				{/if}
			</div>

			<div class="space-y-1.5">
				<p class="text-sm font-medium">Per-run caps</p>
				<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
					<div class="min-w-0 space-y-1.5">
						<label class="text-sm font-medium" for="edit-cap-usd">Cost per run (USD)</label>
						<Input
							id="edit-cap-usd"
							type="number"
							min="0.01"
							step="0.01"
							class="w-full"
							placeholder="none"
							aria-label="Per-run cost cap in dollars"
							value={editCapUsd}
							oninput={(e) => (editCapUsd = e.currentTarget.value)}
						/>
					</div>
					<div class="min-w-0 space-y-1.5">
						<label class="text-sm font-medium" for="edit-cap-tokens">Tokens per run</label>
						<Input
							id="edit-cap-tokens"
							type="number"
							min="1"
							class="w-full"
							placeholder="none"
							aria-label="Per-run token cap"
							value={editCapTokens}
							oninput={(e) => (editCapTokens = e.currentTarget.value)}
						/>
					</div>
				</div>
				{#if editTarget.type !== 'local' && editCapUsd.trim() === ''}
					<p class="text-xs text-amber-700 dark:text-amber-400">
						No cost cap: a run is bounded only by its timeout × burn rate.
					</p>
				{/if}
			</div>

			{#if editTarget.type !== 'local'}
				<div class="space-y-1.5">
					<label class="text-sm font-medium" for="edit-api-key">Provider API key</label>
					<Input
						id="edit-api-key"
						type="password"
						bind:value={editApiKey}
						placeholder={editTarget.has_api_key
							? 'A key is set — paste a new one to replace it'
							: 'sk-ant-…'}
					/>
					<p class="text-muted-foreground text-xs">
						Write-only. A replacement is ping-validated first — a bad paste leaves the working key
						in place. In-flight sessions are unaffected; the next launch uses the new key.
					</p>
				</div>
			{/if}

			<div class="flex flex-wrap justify-end gap-2">
				<Button
					type="button"
					variant="ghost"
					disabled={savingEdit}
					onclick={() => (editTarget = null)}
				>
					Cancel
				</Button>
				<PendingButton type="submit" pending={savingEdit} pendingLabel="Saving…">
					Save runner
				</PendingButton>
			</div>
		</form>
	</Modal>
{/if}

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
			<div class="flex flex-wrap justify-end gap-2">
				<Button
					variant="ghost"
					disabled={rotatingRunnerId !== null}
					onclick={() => (rotateTarget = null)}
				>
					Keep current token
				</Button>
				<PendingButton
					variant="outline"
					pending={rotatingRunnerId !== null}
					pendingLabel="Rotating…"
					onclick={() => rotateTarget && rotateToken(rotateTarget)}
				>
					Rotate token
				</PendingButton>
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
			<pre
				class="bg-muted overflow-x-auto rounded-md border p-3 font-mono text-xs select-all">{rotatedToken.token}</pre>
			<p class="text-muted-foreground text-xs">
				The daemon's next poll gets a 401 until it adopts this token: run
				<code class="bg-muted rounded px-1 py-0.5">tines runners rotate-token</code> on the daemon machine
				to store it automatically, or update the entry in its config directory and restart. The runner's
				id, history, and rule references are unchanged.
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
		<div class="flex flex-wrap justify-end gap-2">
			<Button
				variant="ghost"
				disabled={togglingEnabled}
				onclick={() => (disableConfirmOpen = false)}
			>
				Keep running
			</Button>
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
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="rule-project">Project</label>
				<Select id="rule-project" bind:value={ruleProjectId}>
					<option value="">Any project</option>
					{#each data.projects as project (project.id)}
						<option value={project.id}>{project.name}</option>
					{/each}
					{#if archivedRuleProject}
						<option value={archivedRuleProject.id}>{archivedRuleProject.name} (archived)</option>
					{/if}
				</Select>
			</div>
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="rule-state">State</label>
				<Select id="rule-state" bind:value={ruleStateId}>
					<option value="">Any active state</option>
					{#if staleRuleState}
						<option value={staleRuleState.id}>{staleRuleState.name} (never dispatches)</option>
					{/if}
					{#each routableWorkflows as workflow (workflow.id)}
						<optgroup label={workflow.name}>
							{#each workflow.states as state (state.id)}
								<option value={state.id}>{state.name}</option>
							{/each}
						</optgroup>
					{/each}
				</Select>
			</div>
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="rule-label">Label</label>
				<Select id="rule-label" bind:value={ruleLabelId}>
					<option value="">Any label</option>
					{#if missingRuleLabel}
						<option value={ruleLabelId}>{missingRuleLabel}</option>
					{/if}
					{#each labels as label (label.id)}
						<option value={label.id}>{label.name}</option>
					{/each}
				</Select>
			</div>
		</div>
		{#if staleRuleState}
			<p class="text-xs text-amber-700 dark:text-amber-400">
				This rule is scoped to {staleRuleState.name}, which is no longer an active state — it never
				matches anything. Pick an active state (or "Any active state") to save.
			</p>
		{/if}
		<p class="text-muted-foreground text-xs">
			All three empty = a global rule. The most specific matching rule wins — label beats project
			beats state, so a label rule outranks project ∧ state. Concrete runner lists never fall back
			to broader rules when unavailable; tier-only rules inherit their list before availability
			checks. An issue carrying two labels with a rule each matches both equally and will not
			dispatch until one rule is made more specific. Agents only pick up issues in active states —
			backlog, human-review, and done issues never dispatch — so a global rule is already a default
			for all agent work.
		</p>

		<div class="space-y-1.5">
			<label class="text-sm font-medium" for="rule-mode">Routing mode</label>
			<Select id="rule-mode" bind:value={ruleMode}>
				<option value="runners">Choose runners</option>
				<option value="tier">Set tier only</option>
			</Select>
		</div>

		{#if ruleMode === 'tier'}
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="rule-override-tier">Tier</label>
				<Select id="rule-override-tier" bind:value={ruleOverrideTier}>
					{#each MODEL_TIERS as tier (tier)}<option value={tier}>{tier}</option>{/each}
				</Select>
				<label class="text-sm font-medium" for="rule-override-effort">Effort (optional)</label>
				<Select id="rule-override-effort" bind:value={ruleOverrideEffort}>
					<option value="">inherit</option>
					{#if ruleOverrideEffort && !wildcardEffortChoices.includes(ruleOverrideEffort)}
						<option value={ruleOverrideEffort}>{ruleOverrideEffort} (unavailable)</option>
					{/if}
					{#each wildcardEffortChoices as effort (effort)}
						<option value={effort}>{effort}</option>
					{/each}
				</Select>
				<p class="text-muted-foreground text-xs">
					Uses runners from the next lower-priority matching rule. Effort is checked against each
					final model at dispatch.
				</p>
				{#if !ruleProjectId && !ruleStateId && !ruleLabelId}
					<p class="text-xs text-amber-700 dark:text-amber-400">
						Choose a project, state, or label to set only the tier.
					</p>
				{/if}
			</div>
		{:else}
			<div class="space-y-1.5">
				<p class="text-sm font-medium">Targets (preference order)</p>
				{#each ruleTargets as target, i (i)}
					{@const choices = targetEffortChoices(target)}
					<div
						data-routing-target-row
						class="grid min-w-0 gap-2 rounded-md border p-2 sm:grid-cols-[minmax(11.5rem,1fr)_5.5rem_6.5rem] sm:items-end"
					>
						<label class="min-w-0 space-y-1 text-xs">
							<span class="font-medium">{i + 1}. Runner</span>
							<Select
								class="w-full min-w-0"
								aria-label={`Target ${i + 1} runner`}
								value={target.runner_id}
								onchange={(e) =>
									(ruleTargets[i] = { ...ruleTargets[i], runner_id: e.currentTarget.value })}
							>
								{#each data.runners as runner (runner.id)}
									<option value={runner.id}
										>{runner.name}{runner.status === 'paused' ? ' (paused)' : ''}</option
									>
								{/each}
							</Select></label
						>
						<label class="space-y-1 text-xs"
							><span class="font-medium">Effort</span>
							<Select
								class="w-full"
								aria-label={`Target ${i + 1} effort`}
								value={target.effort}
								onchange={(e) =>
									(ruleTargets[i] = { ...ruleTargets[i], effort: e.currentTarget.value })}
							>
								<option value="">inherit</option>
								{#if target.effort && !choices.includes(target.effort)}
									<option value={target.effort}>{target.effort} (incompatible)</option>
								{/if}
								{#each choices as effort (effort)}
									<option value={effort}>{effort}</option>
								{/each}
							</Select></label
						>
						<label class="space-y-1 text-xs"
							><span class="font-medium">Tier</span>
							<Select
								class="w-full"
								aria-label={`Target ${i + 1} tier`}
								value={target.tier}
								onchange={(e) =>
									(ruleTargets[i] = {
										...ruleTargets[i],
										tier: e.currentTarget.value as '' | ModelTier
									})}
							>
								<option value="">default tier</option>
								{#each MODEL_TIERS as tier (tier)}
									<option value={tier}>{tier}</option>
								{/each}
							</Select></label
						>
						<div class="flex items-center justify-end gap-1 sm:col-span-3">
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
					</div>
				{/each}
				<Button
					size="sm"
					variant="ghost"
					type="button"
					disabled={data.runners.length === 0}
					onclick={() =>
						(ruleTargets = [
							...ruleTargets,
							{ runner_id: data.runners[0].id, tier: '', effort: '' }
						])}
				>
					<IconPlus size={14} /> Add target
				</Button>
				<p class="text-muted-foreground text-xs">
					The first target that is online, unpaused, and under its caps takes the issue; if the list
					is exhausted, the issue waits.
				</p>
			</div>
		{/if}

		<div class="flex flex-wrap justify-end gap-2">
			<Button
				type="button"
				variant="ghost"
				disabled={savingRule}
				onclick={() => (ruleModalOpen = false)}
			>
				Cancel
			</Button>
			<PendingButton
				type="submit"
				pending={savingRule}
				pendingLabel="Saving…"
				disabled={(ruleMode === 'runners' && ruleTargets.length === 0) ||
					staleRuleState !== null ||
					(ruleMode === 'tier' && !ruleProjectId && !ruleStateId && !ruleLabelId)}
			>
				{editingRule ? 'Save rule' : 'Create rule'}
			</PendingButton>
		</div>
	</form>
</Modal>
