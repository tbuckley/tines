<script lang="ts">
	import type { PageData } from './$types';
	import type {
		IssueTransferResult,
		AllowedTransition,
		Comment,
		ContextItem,
		ContextKind,
		RoutingRule,
		WorkflowState
	} from '@tines/shared';
	import { ApiError } from '@tines/shared';
	import IconAlertTriangle from '@tabler/icons-svelte/icons/alert-triangle';
	import IconArchive from '@tabler/icons-svelte/icons/archive';
	import IconBan from '@tabler/icons-svelte/icons/ban';
	import IconChevronLeft from '@tabler/icons-svelte/icons/chevron-left';
	import IconCopy from '@tabler/icons-svelte/icons/copy';
	import IconPencil from '@tabler/icons-svelte/icons/pencil';
	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import IconTrash from '@tabler/icons-svelte/icons/trash';
	import IconRepeat from '@tabler/icons-svelte/icons/repeat';
	import IconRocket from '@tabler/icons-svelte/icons/rocket';
	import { tick, untrack } from 'svelte';
	import { fade, slide } from 'svelte/transition';
	import { afterNavigate, goto, invalidate, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import AgentActivityCard from '$lib/components/AgentActivityCard.svelte';
	import PersonalPermissionWarning from '$lib/components/PersonalPermissionWarning.svelte';
	import FirstRunChecklist from '$lib/components/FirstRunChecklist.svelte';
	import ArtifactsPanel from '$lib/components/ArtifactsPanel.svelte';
	import Clamp from '$lib/components/Clamp.svelte';
	import ContextItemEditor from '$lib/components/ContextItemEditor.svelte';
	import { confirmDialog } from '$lib/components/dialogs.svelte';
	import ContextItemList from '$lib/components/ContextItemList.svelte';
	import EffectiveContextView from '$lib/components/EffectiveContextView.svelte';
	import EventList from '$lib/components/EventList.svelte';
	import LabelChip from '$lib/components/LabelChip.svelte';
	import LabelsCard from '$lib/components/LabelsCard.svelte';
	import LaunchPromptDialog from '$lib/components/LaunchPromptDialog.svelte';
	import Markdown from '$lib/components/Markdown.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import IssueTransferModal from '$lib/components/IssueTransferModal.svelte';
	import IssueUsage from '$lib/components/IssueUsage.svelte';
	import MoveDirectlyForm from '$lib/components/MoveDirectlyForm.svelte';
	import PendingButton from '$lib/components/PendingButton.svelte';
	import PhoneFold from '$lib/components/PhoneFold.svelte';
	import RelationsCard from '$lib/components/RelationsCard.svelte';
	import RunLogViewer from '$lib/components/RunLogViewer.svelte';
	import StateBadge from '$lib/components/StateBadge.svelte';
	import TransitionBar from '$lib/components/TransitionBar.svelte';
	import TransitionList from '$lib/components/TransitionList.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { PROJECT_ARCHIVED_TOOLTIP } from '$lib/archived';
	import { checklistItems, checklistProgress, type FirstRunInputs } from '$lib/first-run';
	import { addRunnerToGlobalRule } from '$lib/routing';
	import { actorLabel, compactActorLabel, prefersReducedMotion, relativeTime } from '$lib/format';
	import { mergeLinks, type PendingAdd } from '$lib/link-overlay';
	import { issueBackTarget, navMemory } from '$lib/nav-memory.svelte';
	import { focusHint } from '$lib/focus.svelte';
	import { resolveClientFocus } from '$lib/focus';
	import { planTransitions } from '$lib/transitions';

	let { data }: { data: Extract<PageData, { mode: 'owner' }> } = $props();

	// Data requests cannot server-redirect without losing a fragment that only
	// the browser knows. Replace the stale alias in place while retaining
	// meaningful query/hash targets and keyboard focus.
	$effect(() => {
		if (page.url.pathname === data.canonicalPath) return;
		void goto(`${data.canonicalPath}${page.url.search}${page.url.hash}`, {
			replaceState: true,
			keepFocus: true,
			noScroll: true
		});
	});

	// The project move lives on the page, not in the dialog: closing the dialog
	// must never be able to swallow a move the server already committed.
	let transferOpen = $state(false);
	let transferNotice = $state<string | null>(null);
	async function transferCompleted(result: IssueTransferResult) {
		if (result.status === 'transferred') {
			transferNotice = `Moved ${result.old_ref.ref} to ${result.new_ref.ref}`;
			// Stay on the issue at its new canonical address; lists and counts on
			// both projects moved too, so the whole tree is invalidated once.
			await goto(`${result.issue_path}${page.url.hash}`, { replaceState: true, keepFocus: true });
			await invalidateAll();
		}
	}

	/** An archived project's issues read normally and write nowhere. */
	const archived = $derived(data.issue.project_archived_at !== null);
	const reason = $derived(archived ? PROJECT_ARCHIVED_TOOLTIP : null);

	// Back to the list you came from, as you left it — the issues list with its
	// filters, or the project page. A deep link or a fresh tab has no memory and
	// falls back to the plain issues list.
	const effectiveFocus = $derived(resolveClientFocus(focusHint.project, data.focus, data.projects));
	const backList = $derived(
		issueBackTarget(navMemory.lastList, effectiveFocus?.id ?? null, navMemory.issuesHref)
	);
	const issueProject = $derived(
		data.projects.find((project) => project.id === data.issue.project_id)
	);
	const canOfferFocus = $derived(!archived && effectiveFocus?.id !== data.issue.project_id);
	let focusing = $state(false);
	let focusError = $state<string | null>(null);
	async function focusIssueProject() {
		if (!issueProject || focusing) return;
		focusing = true;
		focusError = null;
		try {
			await api.updatePreferences({ focused_project_id: issueProject.id });
			focusHint.clear();
			await invalidate('app:preferences');
		} catch (err) {
			focusError = err instanceof ApiError ? err.message : 'Failed to focus this project.';
		} finally {
			focusing = false;
		}
	}

	// Mutations and the live poll refresh THIS page's load only (it declares
	// depends('app:issue')), not the whole load graph: a full invalidate would
	// also re-run the (app) layout and every other load for no reason.
	const refresh = () => invalidate('app:issue');

	// --- streamed panels ---------------------------------------------------------
	// Every refresh — each mutation, and every poll tick that spots someone
	// else's event — replaces data.deferred with FRESH pending promises.
	// Rendering them with {#await} would collapse the panels back to skeletons
	// on each resync, so each panel instead tracks the latest value across
	// promise replacements: pending only before the first value ever arrives,
	// the previous value kept on screen while a newer promise is in flight, and
	// a rejection surfacing as an error only when there is no value to keep
	// (afterwards the stale value stands and the next poll tick retries).
	// The kept value belongs to ONE issue: this component is reused when
	// navigating between issues, so a key change resets the panel to pending
	// rather than showing the previous issue's data.
	type PanelState<T> =
		{ status: 'pending' } | { status: 'loaded'; value: T } | { status: 'failed' };
	function streamed<T>(promise: () => Promise<T>, key: () => unknown) {
		let current = $state<PanelState<T>>({ status: 'pending' });
		let lastKey: unknown;
		$effect(() => {
			// Reading the promise here makes the effect re-run when a refresh
			// swaps data.deferred; the flag parks the superseded promise so an
			// out-of-order settlement can't overwrite a newer one.
			const k = key();
			if (k !== lastKey) {
				lastKey = k;
				current = { status: 'pending' };
			}
			let superseded = false;
			promise().then(
				(value) => {
					if (!superseded) current = { status: 'loaded', value };
				},
				() => {
					if (!superseded && current.status !== 'loaded') current = { status: 'failed' };
				}
			);
			return () => {
				superseded = true;
			};
		});
		return {
			get current() {
				return current;
			}
		};
	}

	const issueKey = () => data.issue.id;
	const contextItemsPanel = streamed(() => data.deferred.contextItems, issueKey);
	const effectiveContextPanel = streamed(() => data.deferred.effectiveContext, issueKey);
	const agentActivityPanel = streamed(
		() =>
			Promise.all([
				data.deferred.dispatch,
				data.deferred.issueRuns,
				data.deferred.runners,
				data.deferred.hasAnyRun,
				data.deferred.rules
			]),
		issueKey
	);
	const usagePanel = streamed(() => data.deferred.usage, issueKey);

	const dur = () => (prefersReducedMotion() ? 0 : 180);

	// --- first-run checklist -----------------------------------------------------
	// While the account has never had an agent run, the card shows the same
	// seven-item checklist as the Agents tab in place of the verdict and its
	// checks. The server flag decides whether it mounts; once mounted it stays
	// for this page-session, so the first run can land in the last item rather
	// than the checklist vanishing at the moment it pays off. A later load
	// (this issue or any other) never shows it again.
	let checklistVisible = $state(false);
	// The server deliberately stops fetching account rules once the first run
	// exists, because a fresh page will not mount this checklist. Keep the last
	// run-free snapshot for the checklist that stays mounted through its landing
	// moment, so a completed routing item cannot regress when item 7 fills in.
	let checklistRules = $state<RoutingRule[]>([]);
	/**
	 * On a phone the card is one folded row, so the checklist would hide behind
	 * it. Opened once, the first time the checklist appears — never forced
	 * afterwards, so closing it stays closed.
	 */
	let agentFoldOpen = $state(false);
	let agentFoldOpened = false;
	// svelte-ignore state_referenced_locally
	let checklistIssueId = $state(data.issue.id);
	$effect(() => {
		const panel = agentActivityPanel.current;
		if (panel.status !== 'loaded') return;
		if (!panel.value[3]) checklistRules = panel.value[4];
		if (panel.value[3]) return;
		checklistVisible = true;
		if (!agentFoldOpened) {
			agentFoldOpened = true;
			agentFoldOpen = true;
		}
	});
	$effect(() => {
		// A different issue: the sticky flag belongs to the page-session of one.
		const issueId = data.issue.id;
		if (issueId === checklistIssueId) return;
		checklistIssueId = issueId;
		untrack(() => {
			checklistVisible = false;
			agentFoldOpened = false;
		});
	});

	const checklistInputs = $derived.by((): FirstRunInputs | null => {
		const panel = agentActivityPanel.current;
		if (!checklistVisible || panel.status !== 'loaded') return null;
		const [dispatch, runs, runners, hasAnyRun, rules] = panel.value;
		return {
			surface: 'issue',
			hasAnyIssue: true,
			hasAnyProject: true,
			runners,
			rules: hasAnyRun ? checklistRules : rules,
			enabled: dispatch?.checks.find((c) => c.name === 'automation_enabled')?.ok ?? false,
			issue: {
				project_name: data.issue.project_name,
				number: data.issue.number,
				title: data.issue.title,
				has_description: data.issue.description.trim() !== '',
				// The issue's *effective* context: a repo item at any scope that
				// covers it is a repo the agent would clone.
				has_repo: data.issue.context_summary.repos > 0
			},
			firstRun: runs[0] ?? null,
			// A run exists on the account but not on this issue.
			runElsewhere: runs.length === 0 && panel.value[3]
		};
	});

	async function enableAutomation() {
		await api.updateSupervisorSettings({ enabled: true });
		await refresh();
	}

	async function routeToSoleRunner() {
		const panel = agentActivityPanel.current;
		if (panel.status !== 'loaded') return;
		const [, , runners, , rules] = panel.value;
		const updated = await addRunnerToGlobalRule(rules, runners[0]);
		// Routing can dispatch immediately now. Capture the completed rule before
		// refresh observes the first run and freezes the landing snapshot.
		checklistRules = [...rules.filter((rule) => rule.id !== updated.id), updated];
		await refresh();
	}

	function startDescription() {
		descriptionDraft = data.issue.description;
		editingDescription = true;
		tick().then(() => descriptionTextarea?.focus());
	}

	// Everything optimistic on this page renders as server truth + an overlay
	// of in-flight work, never a blind local copy resynced by effect. With the
	// live-updates poll below, a refresh can land at ANY moment — not
	// just at the quiet point after the viewer's own mutation — and a blind
	// copy would snap back to stale data mid-mutation. Each overlay entry is
	// cleared only once its own mutation's reload has settled (or it failed).

	// The state badge/graph/buttons follow the in-flight transition, if any.
	let pendingState = $state<WorkflowState | null>(null);
	let transitionAllowsAgents = $state(true);
	const currentState = $derived(pendingState ?? data.issue.state);

	// Comments: server list + in-flight posts. A confirmed overlay entry is
	// hidden as soon as any reload delivers the server copy, so a poll resync
	// racing the post's own refresh can't duplicate it.
	let pendingComments = $state<(Comment & { pending?: boolean })[]>([]);
	const comments = $derived.by((): (Comment & { pending?: boolean })[] => {
		const confirmed = new Set(data.issue.comments.map((c) => c.id));
		return [...data.issue.comments, ...pendingComments.filter((c) => !confirmed.has(c.id))];
	});
	// The newest few render; earlier ones sit behind one "Show N earlier" row
	// until asked for, unrendered — a long thread costs nothing to open.
	const SHOWN_COMMENTS = 2;
	let showAllComments = $state(false);
	afterNavigate(async ({ to }) => {
		if (!to?.url.hash.startsWith('#comment-')) return;
		showAllComments = true;
		await tick();
		document.getElementById(to.url.hash.slice(1))?.scrollIntoView({ block: 'center' });
	});
	const earlierCount = $derived(
		showAllComments ? 0 : Math.max(0, comments.length - SHOWN_COMMENTS)
	);
	const shownComments = $derived(comments.slice(earlierCount));

	const latestEventId = $derived(data.events[0]?.id ?? null);

	// --- live updates ------------------------------------------------------------
	// Other agents/users can post comments, transition, or edit this issue while
	// it's open here. Every mutation path below already calls refresh() to
	// fully resync; polling the events feed just supplies the missing trigger for
	// when someone *else* changes something.
	// Plain (non-reactive) guard, set before the fetch so an overlapping tick
	// (slow request + interval, or interval + refocus) can't double-resync.
	let syncing = false;
	/** Newest account-level event id; the first non-empty observation also refreshes. */
	let latestAccountEventId: string | null = null;
	async function checkForUpdates() {
		if (syncing) return;
		syncing = true;
		try {
			// While the checklist shows, three of its items tick on account-level
			// writes (a runner registering, the rule, the kill switch) that this
			// issue's own feed never sees — so the newest account event is watched
			// alongside it, for that population only.
			const watchAccount = checklistVisible;
			const [latest, account] = await Promise.all([
				api.listEvents({ issue: data.issue.id, limit: 1 }),
				watchAccount ? api.listEvents({ limit: 1 }) : Promise.resolve(null)
			]);
			const newestId = latest.items[0]?.id ?? null;
			const newestAccountId = account?.items[0]?.id ?? null;
			const accountMoved = newestAccountId !== null && newestAccountId !== latestAccountEventId;
			latestAccountEventId = newestAccountId ?? latestAccountEventId;
			if (newestId !== latestEventId || accountMoved) await refresh();
		} catch {
			// Silent — a missed poll tick just waits for the next one, or the
			// visibility-change backstop below.
		} finally {
			syncing = false;
		}
	}
	$effect(() => {
		function tick() {
			if (document.visibilityState === 'visible') void checkForUpdates();
		}
		// untrack: checkForUpdates reads reactive state synchronously
		// (data.issue.id); tracked, every resync would tear down and rebuild
		// the interval and immediately re-fetch the feed it just loaded.
		untrack(tick); // catch up immediately, including right after a backgrounded tab refocuses
		const timer = setInterval(tick, 5000);
		document.addEventListener('visibilitychange', tick);
		return () => {
			clearInterval(timer);
			document.removeEventListener('visibilitychange', tick);
		};
	});

	// Links render as server truth + an overlay of in-flight operations —
	// never a blind local copy. A blind copy resynced on every reload wiped
	// pending adds (add #2 vanished when add #1's reload landed) and
	// resurrected pending removals (the server still had row #2 when remove
	// #1's reload landed). The overlay entries outlive other operations'
	// reloads; each is cleared only once its own reload has settled.
	let linkAdds = $state<PendingAdd[]>([]);
	let linkRemovals = $state<string[]>([]);
	const links = $derived(mergeLinks(data.issue.links, linkAdds, linkRemovals));

	let errorMessage = $state<string | null>(null);
	function showError(e: unknown) {
		errorMessage = e instanceof ApiError ? e.message : 'Something went wrong — try again.';
		setTimeout(() => (errorMessage = null), 6000);
	}

	// --- links ------------------------------------------------------------------

	const duplicateOf = $derived(links.duplicate_of);
	/**
	 * The badge shows the effective state: a duplicate's is its chain
	 * terminus's, so list and detail agree; otherwise it is the issue's own
	 * (optimistically updated) state.
	 */
	const headerState = $derived(duplicateOf ? data.issue.effective_state : currentState);
	const openBlockers = $derived(
		links.blocked_by.filter((l) => l.effective_state.category !== 'done')
	);

	let removingDuplicate = $state(false);
	async function removeDuplicate() {
		const prev = links.duplicate_of;
		if (!prev || removingDuplicate) return;
		// Optimistic via the overlay: the banner slides away and the badge
		// morphs back to this issue's own state — which never changed while
		// the link existed.
		linkRemovals = [...linkRemovals, prev.link_id];
		removingDuplicate = true;
		try {
			await api.removeIssueLink(data.issue.id, prev.link_id);
			await refresh();
			linkAdds = linkAdds.filter((a) => a.entry.link_id !== prev.link_id);
		} catch (e) {
			showError(e);
		} finally {
			linkRemovals = linkRemovals.filter((id) => id !== prev.link_id);
			removingDuplicate = false;
		}
	}

	async function scrollToRelations() {
		relationsOpen = true;
		await tick();
		document
			.getElementById('relations')
			?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
	}

	// Allowed transitions follow the (possibly optimistic) current state.
	const allowed = $derived.by((): AllowedTransition[] => {
		const stateById = new Map(data.issue.workflow.states.map((s) => [s.id, s]));
		// Live artifact-requirement statuses come from the server read; they
		// only describe the server's current state, never an optimistic overlay.
		const serverById = new Map(data.issue.allowed_transitions.map((t) => [t.transition_id, t]));
		return data.issue.workflow.transitions
			.filter((t) => t.from_state_id === currentState.id)
			.flatMap((t) => {
				const toState = stateById.get(t.to_state_id);
				if (!toState) return [];
				const requires =
					currentState.id === data.issue.state.id ? serverById.get(t.id)?.requires : undefined;
				return [
					{
						transition_id: t.id,
						name: t.name,
						to_state: toState,
						...(requires ? { requires } : {})
					}
				];
			});
	});

	const unmetFor = (transition: AllowedTransition) =>
		(transition.requires ?? []).filter((r) => r.status !== 'satisfied');

	// Order and the one filled button both come from `$lib/transitions.ts`:
	// forward moves first (enabled, then blocked with their requirement line as
	// the next action), then steps back, then the escape lane, and a fill only
	// on the workflow's expected next step. `requires` is undefined while an
	// optimistic move is in flight, so everything counts as enabled then.
	const plan = $derived(
		planTransitions(
			allowed,
			currentState,
			data.issue.workflow.states,
			(t) => unmetFor(t).length > 0
		)
	);
	const ordered = $derived(plan.ordered);
	const primaryId = $derived(plan.primaryId);

	// Phone-only surfaces: the State sheet behind the bar, and the fold the
	// header's "Blocked" chip opens before scrolling to it.
	let stateSheetOpen = $state(false);
	let relationsOpen = $state(false);
	// The active run's logs, one tap from the header at any width.
	let logsOpen = $state(false);

	// --- fold summaries: what a closed section holds, in a few words ----------
	const countLabel = (n: number) => (n === 0 ? 'none' : String(n));
	const relationCount = $derived(
		links.blocked_by.length +
			links.blocks.length +
			links.duplicated_by.length +
			(links.duplicate_of ? 1 : 0)
	);
	const contextSummaryLabel = $derived.by(() => {
		const c = data.issue.context_summary;
		const parts = [
			[c.prompts, 'prompt'],
			[c.skills, 'skill'],
			[c.repos, 'repo'],
			[c.envs, 'env']
		]
			.filter(([n]) => (n as number) > 0)
			.map(([n, word]) => `${n} ${word}${n === 1 ? '' : 's'}`);
		return parts.length > 0 ? parts.join(', ') : 'none';
	});
	const agentSummaryLabel = $derived.by(() => {
		// The checklist is the whole card while it shows, and on a phone the fold
		// row is all you see of it until you open it: say how far along it is.
		if (checklistInputs) {
			const { done, total } = checklistProgress(checklistItems(checklistInputs));
			return `first run · ${done} of ${total}`;
		}
		const parts: string[] = [];
		if (data.issue.active_run) parts.push(`${data.issue.active_run.runner_name} running`);
		if (agentActivityPanel.current.status === 'loaded') {
			const runs = agentActivityPanel.current.value[1].length;
			parts.push(`${runs} run${runs === 1 ? '' : 's'}`);
		}
		return parts.join(' · ');
	});

	// The transition dialog: an optional comment posted atomically with the
	// move — comment first, so a sub-second dispatch triggered by the
	// transition already reads it in the launch prompt (SPEC.md "Transition
	// dialogs prompt for an optional comment").
	let pendingTransition = $state<AllowedTransition | null>(null);
	let transitionComment = $state('');
	let transitioning = $state(false);

	function requestMove(transition: AllowedTransition) {
		transitionComment = '';
		transitionAllowsAgents = data.permissionReceipt?.my_agents.value !== 'off';
		// From the phone's State sheet, the confirm dialog takes the sheet's
		// place rather than stacking on it.
		stateSheetOpen = false;
		pendingTransition = transition;
	}

	async function move(transition: AllowedTransition, comment: string) {
		if (transitioning) return;
		transitioning = true;
		try {
			// Comment BEFORE the transition: re-dispatch can never race past it.
			if (comment) await api.createComment(data.issue.id, { body: comment });
			const permission = data.permissionReceipt;
			await api.transitionIssue(data.issue.id, {
				transition_id: transition.transition_id,
				...(permission
					? {
							expected_state_id: permission.issue_state.id,
							expected_decision_revision: permission.issue_state.decision_revision,
							expected_workflow_revision: permission.issue_state.workflow_revision,
							expected_consent_epoch: permission.my_agents.epoch,
							expected_consent_revision: permission.my_agents.revision,
							...(transition.to_state.category === 'active'
								? {
										allow_my_agents: transitionAllowsAgents,
										...(transitionAllowsAgents ? { disclosure_version: 1 } : {})
									}
								: {})
						}
					: {})
			});
			// Optimistic, but only once the server has accepted: the badge and graph
			// animate ahead of the reload, while the State card behind the dialog is
			// never mutated with the request still in flight (Tines/153).
			pendingState = transition.to_state;
			pendingTransition = null;
			stateSheetOpen = false;
			await refresh();
		} catch (e) {
			showError(e);
		} finally {
			// Success: the reload has settled, so server truth already carries
			// the new state. Failure: dropping the overlay is the revert.
			pendingState = null;
			transitioning = false;
		}
	}

	// --- fallback: set any state, or move to another workflow -------------------
	// The form itself is MoveDirectlyForm; this applies its pick and rethrows,
	// so the form keeps the pick for a retry after the error banner.
	async function applyOverride(patch: { workflow_id?: string; state: string }) {
		try {
			await api.updateIssue(data.issue.id, patch);
			await refresh();
		} catch (err) {
			showError(err);
			throw err;
		}
	}

	// --- parked / resume --------------------------------------------------------

	let resuming = $state(false);
	async function resume() {
		if (resuming) return;
		resuming = true;
		try {
			await api.resumeIssue(data.issue.id);
			await refresh();
		} catch (e) {
			showError(e);
		} finally {
			resuming = false;
		}
	}

	// --- comments -------------------------------------------------------------

	let draft = $state('');
	let posting = $state(false);
	async function postComment(e: SubmitEvent) {
		e.preventDefault();
		const body = draft.trim();
		if (!body || posting) return;
		draft = '';
		posting = true;
		const temp: Comment & { pending: boolean } = {
			id: `pending-${Date.now()}`,
			issue_id: data.issue.id,
			body,
			actor: { user_id: '', user_name: data.user.name, api_key_id: null, api_key_name: null },
			created_at: Date.now(),
			updated_at: null,
			pending: true
		};
		pendingComments = [...pendingComments, temp];
		try {
			const created = await api.createComment(data.issue.id, { body });
			// Swap in the confirmed comment under its real id; the overlay's
			// dedupe hides it the moment any reload delivers the server copy.
			pendingComments = pendingComments.map((c) => (c.id === temp.id ? created : c));
			await refresh();
			pendingComments = pendingComments.filter((c) => c.id !== created.id);
		} catch (err) {
			pendingComments = pendingComments.filter((c) => c.id !== temp.id);
			draft = body; // give the text back
			showError(err);
		} finally {
			posting = false;
		}
	}

	// Edit/delete are offered on every comment: the signed-in viewer owns this
	// workspace, and the motivating case is a human cleaning up an agent's
	// mis-post. (Run keys are the narrow ones — the server only lets them touch
	// their own comments.)
	let editingCommentId = $state<string | null>(null);
	let commentDraft = $state('');
	// Per-comment, not page-global: a save on one comment must not disable the
	// buttons on every other one.
	let busyCommentId = $state<string | null>(null);

	function startEditComment(comment: Comment) {
		editingCommentId = comment.id;
		commentDraft = comment.body;
	}

	async function saveComment(comment: Comment) {
		const body = commentDraft.trim();
		if (!body || busyCommentId === comment.id) return;
		busyCommentId = comment.id;
		try {
			await api.updateComment(data.issue.id, comment.id, { body });
			editingCommentId = null;
			await refresh();
		} catch (err) {
			showError(err);
		} finally {
			busyCommentId = null;
		}
	}

	async function deleteComment(comment: Comment) {
		if (busyCommentId === comment.id) return;
		const ok = await confirmDialog({
			title: 'Delete this comment?',
			body: 'The comment is removed from the thread; the activity feed keeps a record that it was deleted.',
			confirmLabel: 'Delete comment',
			destructive: true
		});
		if (!ok || busyCommentId === comment.id) return;
		busyCommentId = comment.id;
		try {
			await api.deleteComment(data.issue.id, comment.id);
			if (editingCommentId === comment.id) editingCommentId = null;
			await refresh();
		} catch (err) {
			showError(err);
		} finally {
			busyCommentId = null;
		}
	}

	// --- title / description editing -------------------------------------------

	let editingTitle = $state(false);
	let titleDraft = $state('');
	async function saveTitle(e: SubmitEvent) {
		e.preventDefault();
		const title = titleDraft.trim();
		editingTitle = false;
		if (!title || title === data.issue.title) return;
		try {
			await api.updateIssue(data.issue.id, { title });
			await refresh();
		} catch (err) {
			showError(err);
		}
	}

	// --- context ----------------------------------------------------------------

	let contextEditorOpen = $state(false);
	let editingContextItem = $state<ContextItem | null>(null);
	let promptDialogOpen = $state(false);

	// The editor reads these when it opens, so each entry point sets them: the
	// aside's own button attaches to this issue, the checklist's repo hint
	// attaches a repo to the project.
	let contextEditorDefaults = $state<{ project_id?: string; issue_id?: string }>({});
	let contextEditorKind = $state<ContextKind | undefined>(undefined);

	function openContextCreate() {
		editingContextItem = null;
		contextEditorDefaults = { issue_id: data.issue.id };
		contextEditorKind = undefined;
		contextEditorOpen = true;
	}
	function openContextEdit(item: ContextItem) {
		editingContextItem = item;
		contextEditorOpen = true;
	}

	const contextTotal = $derived(
		data.issue.context_summary.prompts +
			data.issue.context_summary.skills +
			data.issue.context_summary.repos +
			(data.issue.context_summary.envs ?? 0)
	);

	let editingDescription = $state(false);
	let descriptionTextarea = $state<HTMLTextAreaElement | null>(null);
	let descriptionDraft = $state('');
	let savingDescription = $state(false);
	async function saveDescription() {
		savingDescription = true;
		try {
			await api.updateIssue(data.issue.id, { description: descriptionDraft });
			await refresh();
			editingDescription = false;
		} catch (err) {
			showError(err);
		} finally {
			savingDescription = false;
		}
	}
</script>

<svelte:head
	><title>{data.issue.project_name}/#{data.issue.number} · {data.issue.title} · Tines</title
	></svelte:head
>

<!--
	A streamed panel that never arrived. The panels below the fold are sent as
	promises so the page can paint (and the View Transition commit) on the first
	D1 wave; a rejection here is a failed panel, not a failed page.
-->
{#snippet loadFailed(what: string)}
	<div class="text-muted-foreground flex items-center gap-2 py-2 text-sm">
		<IconAlertTriangle size={16} class="text-destructive" />
		<span>Couldn't load {what}.</span>
		<Button size="sm" variant="ghost" onclick={refresh}>Retry</Button>
	</div>
{/snippet}

<div class="mb-6">
	<a
		href={backList.href}
		class="text-muted-foreground hover:text-foreground mb-3 inline-flex max-w-full min-w-0 items-center gap-1 text-sm"
	>
		<IconChevronLeft size={16} class="shrink-0" />
		<span class="truncate">{backList.label}</span>
	</a>
	{#if transferNotice}
		<p class="text-sm" role="status" data-testid="transfer-notice">
			{transferNotice}
			<button
				class="text-muted-foreground hover:text-foreground ml-2 underline underline-offset-2"
				onclick={() => (transferNotice = null)}>Dismiss</button
			>
		</p>
	{/if}
	<div class="flex flex-wrap items-start justify-between gap-4">
		<div class="min-w-0">
			<p class="text-muted-foreground text-sm">
				<a href="/projects/{data.issue.project_id}" class="hover:underline"
					>{data.issue.project_name}</a
				>
				{#if canOfferFocus}
					<button
						class="hover:text-foreground ml-2 underline underline-offset-2"
						onclick={focusIssueProject}
						disabled={focusing}
						title="Focus {data.issue.project_name}"
					>
						{focusing ? 'Focusing…' : `Focus ${data.issue.project_name}`}
					</button>
				{/if}
				<button
					class="hover:text-foreground ml-2 underline underline-offset-2"
					onclick={() => (transferOpen = true)}
					disabled={archived}
					title={archived ? PROJECT_ARCHIVED_TOOLTIP : 'Move this issue to another project'}
					data-testid="move-to-project"
				>
					Move to project…
				</button>
				<span class="font-mono">#{data.issue.number}</span>
				{#if data.issue.scheduled_task_id}
					<a
						href="/projects/{data.issue.scheduled_task_project_id}?schedule={data.issue
							.scheduled_task_id}"
						class="bg-muted text-muted-foreground hover:text-foreground ml-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 align-middle text-xs"
						title="Created by schedule “{data.issue.scheduled_task_name}”"
					>
						<IconRepeat size={12} stroke={1.75} />
						{data.issue.scheduled_task_name}
					</a>
				{/if}
			</p>
			{#if data.issue.schedule_origin}
				<p class="text-muted-foreground mt-1 text-xs" data-testid="schedule-origin">
					Created from schedule “{data.issue.schedule_origin.schedule_name}” using
					{data.issue.schedule_origin.snapshot.cron} in
					{data.issue.schedule_origin.snapshot.timezone}.
					{#if !data.issue.scheduled_task_id}
						The schedule was deleted; this issue keeps its history.
					{/if}
					Personal permission on this issue is separate from future schedule permission.
				</p>
			{/if}
			{#if focusError}<p class="text-destructive mt-1 text-xs" role="alert">{focusError}</p>{/if}
			{#if editingTitle}
				<form onsubmit={saveTitle} class="mt-1 flex items-center gap-2">
					<Input bind:value={titleDraft} class="w-96 max-w-full text-lg font-semibold" autofocus />
					<Button type="submit" size="sm">Save</Button>
					<Button type="button" size="sm" variant="ghost" onclick={() => (editingTitle = false)}
						>Cancel</Button
					>
				</form>
			{:else}
				<!-- wrap-anywhere: a title is arbitrary user text, and one unbroken
				     token (a pasted URL is enough) otherwise sets the document width
				     and drags every card on the page wider than the viewport. -->
				<h1
					class="group mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight wrap-anywhere"
				>
					<!-- The transition name sits on a text-hugging span (not the h1,
					     whose width includes the edit affordance) so the morph from
					     the list row scales cleanly. -->
					<span
						class="vt-shared min-w-0"
						style:view-transition-name="issue-title-{data.issue.id}"
						style:view-transition-class="vt-fit"
					>
						{data.issue.title}
					</span>
					<button
						class="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
						onclick={() => {
							titleDraft = data.issue.title;
							editingTitle = true;
						}}
						aria-label="Edit title"
						disabled={archived}
						title={reason}
					>
						<IconPencil size={16} />
					</button>
				</h1>
			{/if}
			{#if data.issue.labels.length > 0}
				<!-- Read-only here; editing lives in the aside card, on the same
				     `issue.labels` truth. -->
				<div class="mt-2 flex flex-wrap gap-1.5">
					{#each data.issue.labels as label (label.id)}
						<LabelChip {label} size="sm" />
					{/each}
				</div>
			{/if}
		</div>
		<div class="flex flex-wrap items-center justify-end gap-2">
			{#if duplicateOf}
				<span
					class="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
					title="Duplicate of {duplicateOf.project_name}/#{duplicateOf.number} — the badge shows its state ({headerState.name})"
					transition:fade={{ duration: dur() }}
				>
					<IconCopy size={12} stroke={1.75} />
					dup
				</span>
			{/if}
			<span
				class="vt-shared"
				style:view-transition-name="issue-state-{data.issue.id}"
				style:view-transition-class="vt-fit"
			>
				<StateBadge state={headerState} class="text-sm" />
			</span>
			{#if data.issue.active_run}
				<!-- "Being worked right now", with the log tail one tap away — at
				     any width, without finding the run in the Agent activity card. -->
				<button
					type="button"
					class="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-400"
					title="{data.issue.active_run.runner_name} is on it ({data.issue.active_run
						.status}) — view its logs"
					onclick={() => (logsOpen = true)}
					transition:fade={{ duration: dur() }}
				>
					<span class="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500"></span>
					{data.issue.active_run.runner_name}
					<span class="font-normal opacity-80">· Logs</span>
				</button>
			{/if}
			{#if openBlockers.length > 0}
				<!-- Advisory, so no banner — a chip that jumps to the detail. -->
				<button
					type="button"
					class="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-700 dark:text-amber-400"
					title="Blocked by {openBlockers
						.map((b) => `${b.project_name}/${b.number} — ${b.title}`)
						.join('; ')}"
					onclick={scrollToRelations}
					transition:fade={{ duration: dur() }}
				>
					<IconBan size={14} stroke={1.75} />
					Blocked · {openBlockers.length}
				</button>
			{/if}
		</div>
	</div>
</div>

{#if duplicateOf}
	<div
		class="bg-muted/50 text-muted-foreground mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-4 py-2.5 text-sm"
		transition:slide={{ duration: dur() }}
	>
		<IconCopy size={16} stroke={1.75} class="shrink-0" />
		<p class="min-w-0 wrap-anywhere">
			Duplicate of
			<a
				href="/issues/{encodeURIComponent(duplicateOf.project_name)}/{duplicateOf.number}"
				class="text-foreground font-medium hover:underline"
			>
				{duplicateOf.project_name}/#{duplicateOf.number}
			</a>
			— {duplicateOf.title}. This issue's state follows it.
		</p>
		<Button
			size="sm"
			variant="ghost"
			class="ml-auto"
			disabled={removingDuplicate || archived}
			title={reason}
			onclick={removeDuplicate}
		>
			Not a duplicate?
		</Button>
	</div>
{/if}

{#if archived}
	<div
		class="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-800 dark:text-amber-300"
	>
		<IconArchive size={16} />
		<span>
			This project is archived — read-only.
			<a class="underline" href="/projects/{data.issue.project_id}">Unarchive</a> to make changes.
		</span>
	</div>
{/if}

{#if data.issue.needs_attention}
	<!-- parked banner: above the fold, cleared by Resume or any manual move -->
	<div
		class="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-800 dark:text-amber-300"
		transition:slide={{ duration: dur() }}
	>
		<span class="flex items-center gap-2">
			<IconAlertTriangle size={16} stroke={1.75} class="shrink-0" />
			Agents struck out {data.issue.attempt_count}
			time{data.issue.attempt_count === 1 ? '' : 's'} here — the last run ended without moving the issue.
			It won't be dispatched again until you act.
		</span>
		<Button size="sm" disabled={resuming || archived} title={reason} onclick={resume}>
			{resuming ? 'Resuming…' : 'Resume'}
		</Button>
	</div>
{/if}

{#if errorMessage}
	<div
		class="border-destructive/40 bg-destructive/10 text-destructive mb-4 rounded-md border px-4 py-2.5 text-sm"
		transition:slide={{ duration: dur() }}
	>
		{errorMessage}
	</div>
{/if}

{#snippet firstRunChecklist()}
	{#if checklistInputs}
		<FirstRunChecklist
			inputs={checklistInputs}
			disabledReason={reason}
			onroute={routeToSoleRunner}
			onenable={enableAutomation}
			onerror={showError}
		/>
	{/if}
{/snippet}

<ContextItemEditor
	bind:open={contextEditorOpen}
	item={editingContextItem}
	defaults={contextEditorDefaults}
	defaultKind={contextEditorKind}
	projects={data.projects}
	workflows={data.workflows}
	onsaved={refresh}
/>

<LaunchPromptDialog bind:open={promptDialogOpen} issueId={data.issue.id} />

<!-- `lg:grid-rows-[auto_1fr]`: the State card is its own grid item in row 1
     while main spans both rows, so with default auto rows grid distributes
     main's height across them and stretches the card's border to fill row 1
     (~1000px of empty box on a long issue). Row 1 sized to content, row 2
     absorbing the rest, keeps the card exactly as tall as it was inside the
     aside.

     Reading order (Tines/165): the description, then the newest comments —
     what you came to read — and only then the reference panels, which fold to
     one row each on a phone. Deciding never needs a scroll: the State card
     sits at the top of the desktop aside, and on a phone the transition bar
     is pinned to the bottom of the screen (below). -->
<div class="grid gap-8 max-sm:gap-0 lg:grid-cols-[minmax(0,1fr)_22rem] lg:grid-rows-[auto_1fr]">
	<!-- state & transitions — the desktop card. On a phone the bar and its
	     State sheet take over, so the card is not rendered at that width. -->
	<!-- On a duplicate the section stops pretending to be the source of
	     truth (muted), but the buttons still act on this issue's own,
	     dormant state — moving a duplicate is allowed. -->
	<section
		class="min-w-0 rounded-lg border p-4 transition-opacity duration-200 max-sm:hidden lg:col-start-2 lg:row-start-1 {duplicateOf
			? 'opacity-70'
			: ''}"
	>
		<h2 class="mb-3 text-sm font-semibold">State</h2>
		{@render statePanel()}
	</section>

	<div class="min-w-0 space-y-8 max-sm:space-y-0 lg:col-start-1 lg:row-span-2 lg:row-start-1">
		<!-- description -->
		<section class="rounded-lg border max-sm:mb-6">
			<header class="flex items-center justify-between border-b px-4 py-2.5">
				<h2 class="text-sm font-semibold">Description</h2>
				{#if !editingDescription}
					<Button
						size="sm"
						variant="ghost"
						disabled={archived}
						title={reason}
						onclick={() => {
							descriptionDraft = data.issue.description;
							editingDescription = true;
						}}
					>
						<IconPencil size={14} /> Edit
					</Button>
				{/if}
			</header>
			<div class="p-4">
				{#if editingDescription}
					<div transition:slide={{ duration: dur() }}>
						<Textarea
							bind:ref={descriptionTextarea}
							bind:value={descriptionDraft}
							rows={8}
							aria-label="Description"
							placeholder="Describe the work (Markdown)…"
						/>
						<div class="mt-2 flex gap-2">
							<Button size="sm" onclick={saveDescription} disabled={savingDescription}>
								{savingDescription ? 'Saving…' : 'Save'}
							</Button>
							<Button size="sm" variant="ghost" onclick={() => (editingDescription = false)}
								>Cancel</Button
							>
						</div>
					</div>
				{:else if data.issue.description}
					<!-- Held to a few lines on a phone: it is rarely what you came for
					     there, and the comments are what it pushes down. -->
					<Clamp maxHeight="9rem" phoneOnly>
						<Markdown source={data.issue.description} />
					</Clamp>
				{:else}
					<p class="text-muted-foreground text-sm italic">No description.</p>
				{/if}
			</div>
		</section>

		<!-- comments: the newest few in full, the rest behind one row. A folded
		     comment is not rendered at all, which is what keeps a long thread
		     light; a shown one is held to a screen or so with "Show more". -->
		<section class="max-sm:mb-6">
			<h2 class="mb-3 text-sm font-semibold">
				Comments <span class="text-muted-foreground font-normal">({comments.length})</span>
			</h2>
			<div class="space-y-3">
				{#if earlierCount > 0}
					<button
						type="button"
						class="text-muted-foreground hover:text-foreground hover:bg-accent/50 flex w-full items-center gap-3 rounded-lg border border-dashed px-4 py-2.5 text-sm"
						onclick={() => (showAllComments = true)}
					>
						<span class="border-muted-foreground/40 h-px flex-1 border-t border-dashed"></span>
						Show {earlierCount} earlier comment{earlierCount === 1 ? '' : 's'}
						<span class="border-muted-foreground/40 h-px flex-1 border-t border-dashed"></span>
					</button>
				{/if}
				{#each shownComments as comment (comment.id)}
					<article
						id={`comment-${comment.id}`}
						class="rounded-lg border {comment.pending ? 'opacity-60' : ''}"
						transition:slide={{ duration: dur() }}
					>
						<header
							class="text-muted-foreground flex items-center gap-2 border-b px-4 py-2 text-xs"
						>
							<span
								class="text-foreground min-w-0 flex-1 font-medium wrap-anywhere"
								data-testid="comment-actor"
							>
								<span class="max-sm:hidden" data-testid="comment-actor-full"
									>{actorLabel(comment.actor)}</span
								>
								<span class="sm:hidden" data-testid="comment-actor-compact"
									>{compactActorLabel(comment.actor)}</span
								>
							</span>
							<span class="shrink-0" title={new Date(comment.created_at).toLocaleString()}>
								{comment.pending ? 'sending…' : relativeTime(comment.created_at)}
							</span>
							{#if comment.updated_at}
								<span class="shrink-0 italic" title={new Date(comment.updated_at).toLocaleString()}>
									(edited{comment.editor ? ` by ${comment.editor.user_name}` : ''})
								</span>
							{/if}
							{#if !comment.pending && !archived}
								<div class="ml-auto flex shrink-0 items-center gap-1">
									<Button
										variant="ghost"
										size="icon"
										class="size-6"
										title="Edit comment"
										aria-label="Edit comment"
										disabled={busyCommentId === comment.id}
										onclick={() => startEditComment(comment)}
									>
										<IconPencil size={14} stroke={1.5} />
									</Button>
									<Button
										variant="ghost"
										size="icon"
										class="size-6"
										title="Delete comment"
										aria-label="Delete comment"
										disabled={busyCommentId === comment.id}
										onclick={() => deleteComment(comment)}
									>
										<IconTrash size={14} stroke={1.5} />
									</Button>
								</div>
							{/if}
						</header>
						<div class="p-4">
							{#if editingCommentId === comment.id}
								<Textarea bind:value={commentDraft} rows={6} />
								<div class="mt-2 flex justify-end gap-2">
									<Button
										variant="ghost"
										size="sm"
										disabled={busyCommentId === comment.id}
										onclick={() => (editingCommentId = null)}>Cancel</Button
									>
									<Button
										size="sm"
										disabled={!commentDraft.trim() || busyCommentId === comment.id}
										onclick={() => saveComment(comment)}>Save</Button
									>
								</div>
							{:else}
								<Clamp maxHeight="24rem">
									<Markdown source={comment.body} />
								</Clamp>
							{/if}
						</div>
					</article>
				{/each}
			</div>
			<form onsubmit={postComment} class="mt-4">
				<Textarea
					bind:value={draft}
					rows={3}
					placeholder="Leave a comment (Markdown)…"
					disabled={archived}
					title={reason}
				/>
				<div class="mt-2 flex justify-end">
					<Button
						type="submit"
						size="sm"
						disabled={!draft.trim() || posting || archived}
						title={reason}>Comment</Button
					>
				</div>
			</form>
		</section>

		<!-- artifacts: the issue's attached work products -->
		<PhoneFold title="Artifacts" summary={countLabel(data.artifacts.length)}>
			<ArtifactsPanel
				issueId={data.issue.id}
				artifacts={data.artifacts}
				allowedTransitions={data.issue.allowed_transitions}
				disabledReason={reason}
				onchanged={refresh}
				onerror={showError}
			/>
		</PhoneFold>

		<!-- context -->
		<PhoneFold title="Context" summary={contextSummaryLabel}>
			<section class="rounded-lg border">
				<header class="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
					<h2 class="text-sm font-semibold">
						Context
						{#if contextTotal > 0}
							<span class="text-muted-foreground font-normal">({contextSummaryLabel})</span>
						{/if}
					</h2>
					<div class="flex flex-wrap items-center gap-2">
						<a
							href="/context"
							class="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 rounded-sm text-xs outline-none focus-visible:ring-[3px]"
						>
							View all context
						</a>
						<Button size="sm" variant="outline" onclick={() => (promptDialogOpen = true)}>
							<IconRocket size={14} /> View launch prompt
						</Button>
						<Button
							size="sm"
							variant="ghost"
							disabled={archived}
							title={reason}
							onclick={openContextCreate}
						>
							<IconPlus size={14} /> Add
						</Button>
					</div>
				</header>
				<div class="space-y-4 p-4">
					<div>
						<h3 class="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">
							This issue's context
						</h3>
						{#if contextItemsPanel.current.status === 'pending'}
							<Skeleton class="h-16 w-full" />
						{:else if contextItemsPanel.current.status === 'loaded'}
							<ContextItemList
								items={contextItemsPanel.current.value}
								onselect={archived ? undefined : openContextEdit}
								emptyMessage="Nothing attached to this issue yet — add a note, skill, or repo."
							/>
						{:else}
							{@render loadFailed("this issue's context")}
						{/if}
					</div>
					<details class="group border-t pt-3">
						<summary
							class="text-muted-foreground hover:text-foreground cursor-pointer text-sm select-none"
						>
							Effective context
							<span class="text-xs">
								— everything that applies while in
								<span class="font-medium">{currentState.name}</span> (changes as the issue transitions)
							</span>
						</summary>
						<div class="mt-3">
							{#if effectiveContextPanel.current.status === 'pending'}
								<Skeleton class="h-24 w-full" />
							{:else if effectiveContextPanel.current.status === 'loaded'}
								<EffectiveContextView context={effectiveContextPanel.current.value} />
							{:else}
								{@render loadFailed('the effective context')}
							{/if}
						</div>
					</details>
				</div>
			</section>
		</PhoneFold>
	</div>

	<!-- min-w-0, like the main column: a grid item defaults to a min-content
	     floor, so one nowrap row in here (a truncated linked-issue title) would
	     otherwise widen the column past the viewport. -->
	<aside class="min-w-0 space-y-8 max-sm:space-y-0 lg:col-start-2 lg:row-start-2">
		<!-- the supervisor's view of this issue -->
		<PhoneFold title="Agent activity" summary={agentSummaryLabel} bind:open={agentFoldOpen}>
			{#if agentActivityPanel.current.status === 'pending'}
				<Skeleton class="h-40 w-full" />
			{:else if agentActivityPanel.current.status === 'loaded'}
				{@const [dispatch, runs, runners] = agentActivityPanel.current.value}
				<AgentActivityCard
					issue={data.issue}
					permission={data.permissionReceipt}
					roster={data.permissionRoster}
					{dispatch}
					{runs}
					{runners}
					disabledReason={reason}
					onerror={showError}
					checklist={checklistInputs ? firstRunChecklist : undefined}
				/>
				{#if usagePanel.current.status === 'pending'}
					<Skeleton class="mt-4 h-24 w-full" />
				{:else if usagePanel.current.status === 'loaded'}
					<IssueUsage initial={usagePanel.current.value} />
				{:else}
					<p class="text-destructive mt-3 text-sm">Lifetime usage unavailable.</p>
				{/if}
			{:else}
				{@render loadFailed('agent activity')}
			{/if}
		</PhoneFold>

		<PhoneFold title="Labels" summary={countLabel(data.issue.labels.length)}>
			<LabelsCard
				issueId={data.issue.id}
				labels={data.issue.labels}
				library={data.labelLibrary}
				disabledReason={reason}
				onerror={showError}
			/>
		</PhoneFold>

		<!-- dependencies & duplicates -->
		<PhoneFold title="Relations" summary={countLabel(relationCount)} bind:open={relationsOpen}>
			<RelationsCard
				issueId={data.issue.id}
				{links}
				bind:adds={linkAdds}
				bind:removals={linkRemovals}
				disabledReason={reason}
				onerror={showError}
			/>
		</PhoneFold>

		<!-- this issue's slice of the activity log -->
		<PhoneFold title="Activity" summary={countLabel(data.events.length)}>
			<section>
				<div class="mb-3 flex flex-wrap items-center justify-between gap-2">
					<h2 class="text-sm font-semibold">Activity</h2>
					<a
						href="/activity"
						class="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 rounded-sm text-xs outline-none focus-visible:ring-[3px]"
					>
						View all activity
					</a>
				</div>
				<EventList events={data.events} showIssueLinks={false} emptyMessage="No activity yet." />
			</section>
		</PhoneFold>
	</aside>
</div>

<!-- The transitions and the escape hatch, shared by the desktop State card
     and the phone's State sheet so the two never drift. -->
{#snippet statePanel()}
	{#if duplicateOf}
		<p class="text-muted-foreground mb-3 text-xs italic" transition:slide={{ duration: dur() }}>
			This issue is a duplicate — its displayed state follows
			<a
				href="/issues/{encodeURIComponent(duplicateOf.project_name)}/{duplicateOf.number}"
				class="hover:underline">{duplicateOf.project_name}/#{duplicateOf.number}</a
			>.
		</p>
	{/if}
	<TransitionList
		transitions={ordered}
		{unmetFor}
		disabled={transitioning || archived}
		disabledReason={reason}
		stateEnteredAt={data.issue.state_entered_at}
		onmove={requestMove}
	/>
	<p class="text-muted-foreground mt-3 min-w-0 text-xs wrap-anywhere">
		Workflow:
		<a href="/workflows/{data.issue.workflow.id}" class="hover:underline"
			>{data.issue.workflow.name}</a
		>
	</p>
	<!-- escape hatch: jump to any state, or move onto another workflow -->
	<details class="mt-4 border-t pt-3">
		<summary class="text-muted-foreground hover:text-foreground cursor-pointer text-xs select-none">
			Move directly…
		</summary>
		<div class="mt-3">
			<MoveDirectlyForm
				workflows={data.workflows}
				issueWorkflow={data.issue.workflow}
				{currentState}
				disabledReason={reason}
				onapply={applyOverride}
			/>
		</div>
	</details>
{/snippet}

<!-- phone: the decide-while-reading bar, and the State sheet it opens. The
     spacer keeps the last fold row clear of the bar. -->
<div class="h-14 sm:hidden" aria-hidden="true"></div>
<TransitionBar
	current={headerState}
	transitions={ordered}
	{unmetFor}
	{primaryId}
	disabled={transitioning || archived}
	disabledReason={reason}
	onmove={requestMove}
	onopen={() => (stateSheetOpen = true)}
/>
<IssueTransferModal
	bind:open={transferOpen}
	issueId={data.issue.id}
	currentProjectId={data.issue.project_id}
	projects={data.projects}
	oncompleted={transferCompleted}
/>

<Modal bind:open={stateSheetOpen} title="State">
	{@render statePanel()}
</Modal>

<!-- the active run's log tail, one tap from the header at any width -->
{#if data.issue.active_run}
	<Modal bind:open={logsOpen} title="Logs · {data.issue.active_run.runner_name}" size="xl">
		<RunLogViewer runId={data.issue.active_run.run_id} />
	</Modal>
{/if}

<!-- transition dialog: optional comment posted atomically with the move -->
{#if pendingTransition}
	{@const transition = pendingTransition}
	<Modal
		open={true}
		onclose={() => (pendingTransition = null)}
		title={`${transition.name} → ${transition.to_state.name}`}
	>
		<form
			class="space-y-3"
			onsubmit={(e) => {
				e.preventDefault();
				void move(transition, transitionComment.trim());
			}}
		>
			<p class="text-sm">
				Move this issue to <span class="font-medium">{transition.to_state.name}</span>
				({transition.to_state.category.replaceAll('_', ' ')})?
			</p>
			{#if data.permissionReceipt && transition.to_state.category === 'active'}
				<div class="rounded-md border p-3 text-sm">
					<label class="flex min-h-11 items-center gap-2 font-medium">
						<input type="checkbox" bind:checked={transitionAllowsAgents} /> Allow my agents after this
						move
					</label>
					<p class="text-muted-foreground mt-1 text-xs">
						Your agents may use your runner and account resources. This choice is yours alone.
					</p>
					{#if transitionAllowsAgents}<PersonalPermissionWarning />{/if}
				</div>
			{/if}
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="transition-comment">Comment (optional)</label>
				<Textarea
					id="transition-comment"
					bind:value={transitionComment}
					rows={3}
					placeholder="Feedback, context, or instructions for whoever picks this up…"
				/>
				<p class="text-muted-foreground text-xs">
					Posted with the transition — if this move hands the issue to an agent, its very next run's
					prompt already contains it.
				</p>
			</div>
			<div class="flex flex-wrap justify-end gap-2">
				<Button
					type="button"
					variant="ghost"
					disabled={transitioning}
					onclick={() => (pendingTransition = null)}
				>
					Cancel
				</Button>
				<PendingButton
					type="submit"
					pending={transitioning}
					pendingLabel="Moving…"
					title={transition.name}
				>
					{transition.name}
				</PendingButton>
			</div>
		</form>
	</Modal>
{/if}
