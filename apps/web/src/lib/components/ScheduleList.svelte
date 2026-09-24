<script lang="ts">
	import type { Schedule, UpdateScheduleRequest, WorkflowResponse } from '@tines/shared';
	import { ApiError, describeRecurrence } from '@tines/shared';
	import IconAlertCircle from '@tabler/icons-svelte/icons/alert-circle';
	import IconCheck from '@tabler/icons-svelte/icons/check';
	import IconClock from '@tabler/icons-svelte/icons/clock';
	import IconPencil from '@tabler/icons-svelte/icons/pencil';
	import IconPlayerPlay from '@tabler/icons-svelte/icons/player-play';
	import IconTrash from '@tabler/icons-svelte/icons/trash';
	import { onMount } from 'svelte';
	import { fade, slide } from 'svelte/transition';
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import { confirmDialog } from '$lib/components/dialogs.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import PendingButton from '$lib/components/PendingButton.svelte';
	import RepeatFields from '$lib/components/RepeatFields.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Select } from '$lib/components/ui/select/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { nextRunLabel, prefersReducedMotion, relativeTime } from '$lib/format';
	import {
		defaultRepeatState,
		repeatFromSchedule,
		repeatSummary,
		repeatToScheduleInput
	} from '$lib/schedule-form';

	let {
		schedules,
		workflows,
		highlightId = null,
		disabledReason = null,
		onerror
	}: {
		schedules: Schedule[];
		workflows: WorkflowResponse[];
		/** Row to highlight (?schedule= deep links from issue badges). */
		highlightId?: string | null;
		/** When set, every mutating control is disabled and carries this as its tooltip. */
		disabledReason?: string | null;
		onerror: (e: unknown) => void;
	} = $props();

	const readOnly = $derived(disabledReason != null);

	const dur = () => (prefersReducedMotion() ? 0 : 180);

	// The list can sit well below the fold (the project page leads with issues),
	// so a ?schedule= deep link brings its highlighted row into view. onMount, not
	// $effect: arriving once, not again on every invalidateAll() after a mutation.
	onMount(() => {
		if (!highlightId) return;
		document.getElementById(`schedule-${highlightId}`)?.scrollIntoView({
			block: 'center',
			behavior: prefersReducedMotion() ? 'auto' : 'smooth'
		});
	});

	// One in-flight mutation at a time keeps the optimistic states simple.
	let busyId = $state<string | null>(null);
	type RunResult =
		| { kind: 'success'; projectName: string; number: number; refreshError?: string }
		| { kind: 'error'; message: string };
	let runResults = $state<Record<string, RunResult | undefined>>({});
	let futureSaved = $state<string | null>(null);
	let futureError = $state<Record<string, string | undefined>>({});
	const refreshError =
		'Issue created, but the list could not refresh. Reload the page to update it.';
	const runRecoveryKey = 'tines:schedule-run-recovery';
	type RunRecovery = {
		scheduleId: string;
		projectName: string;
		number: number;
		pathname: string;
		createdAt: number;
	};

	function stageRunRecovery(recovery: RunRecovery) {
		try {
			sessionStorage.setItem(runRecoveryKey, JSON.stringify(recovery));
		} catch {
			// The in-memory receipt still works when storage is unavailable. Storage
			// only bridges SvelteKit's native-reload fallback after a failed refresh.
		}
	}

	function clearRunRecovery() {
		try {
			sessionStorage.removeItem(runRecoveryKey);
		} catch {
			// See stageRunRecovery: storage can be unavailable without blocking Run now.
		}
	}

	onMount(() => {
		let recovery: RunRecovery | undefined;
		try {
			recovery = JSON.parse(sessionStorage.getItem(runRecoveryKey) ?? '') as RunRecovery;
		} catch {
			// Missing, unavailable, or malformed recovery state is simply discarded.
		}
		clearRunRecovery();
		if (
			!recovery ||
			recovery.pathname !== location.pathname ||
			Date.now() - recovery.createdAt > 30_000 ||
			!schedules.some((schedule) => schedule.id === recovery.scheduleId)
		)
			return;
		runResults[recovery.scheduleId] = {
			kind: 'success',
			projectName: recovery.projectName,
			number: recovery.number,
			refreshError
		};
	});

	async function mutate(id: string, fn: () => Promise<unknown>) {
		if (busyId) return;
		busyId = id;
		try {
			await fn();
			await invalidateAll();
		} catch (e) {
			onerror(e);
		} finally {
			busyId = null;
		}
	}

	const toggleEnabled = (s: Schedule) =>
		mutate(s.id, () => api.updateSchedule(s.id, { enabled: !s.enabled }));

	async function setFuturePermission(s: Schedule) {
		const choice = s.my_future_permission;
		if (!choice || busyId) return;
		busyId = s.id;
		futureSaved = null;
		futureError[s.id] = undefined;
		try {
			await api.setScheduleConsent(s.id, {
				// Only the owner sees this list, and the owner's unset is on.
				value: choice.value === 'off' ? 'on' : 'off',
				expected_revision: choice.revision,
				permission_epoch: choice.epoch
			});
			futureSaved = s.id;
			await invalidateAll();
		} catch (error) {
			futureError[s.id] = error instanceof ApiError ? error.message : 'Could not save permission.';
			if (error instanceof ApiError && error.status === 409) await invalidateAll();
		} finally {
			busyId = null;
		}
	}

	async function runNow(s: Schedule) {
		if (busyId || readOnly) return;
		busyId = s.id;
		runResults[s.id] = undefined;
		try {
			let issue;
			try {
				issue = await api.runSchedule(s.id);
			} catch (e) {
				runResults[s.id] = {
					kind: 'error',
					message: e instanceof ApiError ? e.message : 'Something went wrong — try again.'
				};
				return;
			}

			runResults[s.id] = {
				kind: 'success',
				projectName: issue.project_name,
				number: issue.number
			};
			stageRunRecovery({
				scheduleId: s.id,
				projectName: issue.project_name,
				number: issue.number,
				pathname: location.pathname,
				createdAt: Date.now()
			});
			try {
				await invalidateAll();
				// SvelteKit resolves invalidation after replacing this page with its
				// error boundary, so a catch alone cannot distinguish a failed refresh.
				// Reload the unchanged URL; onMount consumes the staged receipt and
				// explains that creation succeeded even though this refresh did not.
				if (page.status >= 400) {
					location.reload();
					return;
				}
				clearRunRecovery();
			} catch {
				clearRunRecovery();
				runResults[s.id] = {
					kind: 'success',
					projectName: issue.project_name,
					number: issue.number,
					refreshError
				};
			}
		} finally {
			busyId = null;
		}
	}

	async function remove(s: Schedule) {
		const ok = await confirmDialog({
			title: `Delete schedule "${s.name}"?`,
			body: 'Issues it already created are kept; only the schedule goes away.',
			confirmLabel: 'Delete schedule',
			destructive: true
		});
		if (!ok) return;
		void mutate(s.id, () => api.deleteSchedule(s.id));
	}

	// --- edit modal -------------------------------------------------------------

	let editing = $state<Schedule | null>(null);
	let editOpen = $state(false);
	let editName = $state('');
	let editTitle = $state('');
	let editDescription = $state('');
	let editWorkflowId = $state('');
	let editStateId = $state('');
	let editRepeat = $state(defaultRepeatState());
	let saving = $state(false);
	let editError = $state<string | null>(null);

	const editWorkflow = $derived(workflows.find((w) => w.id === editWorkflowId));

	function openEdit(s: Schedule) {
		editing = s;
		editName = s.name;
		editTitle = s.title_template;
		editDescription = s.description_template;
		editWorkflowId = s.workflow_id;
		// null state = follow the workflow's initial state.
		editStateId =
			s.state_id ?? workflows.find((w) => w.id === s.workflow_id)?.initial_state_id ?? '';
		editRepeat = repeatFromSchedule(s);
		editError = null;
		editOpen = true;
	}

	// Switching workflows lands on the new workflow's initial state (the old
	// state belongs to the old workflow).
	function onEditWorkflowChange() {
		editStateId = editWorkflow?.initial_state_id ?? '';
	}

	const editValid = $derived(repeatSummary(editRepeat).ok);

	async function saveEdit(e: SubmitEvent) {
		e.preventDefault();
		if (!editing || saving) return;
		saving = true;
		editError = null;
		try {
			const recurrence = repeatToScheduleInput(editRepeat)!;
			const body: UpdateScheduleRequest = {
				name: editName,
				title_template: editTitle,
				description_template: editDescription,
				workflow_id: editWorkflowId,
				// The server stores the initial state as null ("follow the workflow").
				state: editStateId || null,
				timezone: recurrence.timezone,
				require_all_closed: recurrence.require_all_closed,
				...(recurrence.preset ? { preset: recurrence.preset } : { cron: recurrence.cron })
			};
			await api.updateSchedule(editing.id, body);
			editOpen = false;
			await invalidateAll();
		} catch (err) {
			editError = err instanceof ApiError ? err.message : 'Something went wrong — try again.';
		} finally {
			saving = false;
		}
	}
</script>

<ul class="divide-y rounded-lg border">
	{#each schedules as s (s.id)}
		{@const runResult = runResults[s.id]}
		<li
			id="schedule-{s.id}"
			class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 transition-colors duration-200 {highlightId ===
			s.id
				? 'bg-accent/60'
				: ''}"
			in:fade={{ duration: dur() }}
		>
			<div
				class="min-w-0 basis-full transition-opacity duration-200 sm:flex-1 sm:basis-auto {s.enabled
					? ''
					: 'opacity-60'}"
			>
				<p class="text-sm font-medium [overflow-wrap:anywhere]">{s.name}</p>
				<p class="text-muted-foreground text-xs [overflow-wrap:anywhere]">
					{describeRecurrence(s.preset, s.cron)}, {s.timezone}
					{#if s.require_all_closed}
						· only when closed
					{/if}
					· {s.workflow_name}{s.state_name ? ` / ${s.state_name}` : ''}
				</p>
			</div>
			{#if s.my_future_permission}
				<div class="basis-full rounded-md border px-3 py-2 text-sm">
					<label class="flex min-h-11 items-center gap-2 font-medium">
						<input
							type="checkbox"
							role="switch"
							aria-label="Allow my agents on future issues from {s.name}"
							checked={s.my_future_permission.value !== 'off'}
							disabled={busyId !== null}
							onchange={() => setFuturePermission(s)}
						/>
						My agents on future issues
					</label>
					<p class="text-muted-foreground text-xs">
						On by default for you as the owner. Turn it off to keep your agents away from the issues
						this schedule creates from now on; existing issues keep their own choices. Members'
						agents always need their own permission.
					</p>
					{#if futureSaved === s.id}<p role="status">Future permission saved.</p>{/if}
					{#if futureError[s.id]}<p class="text-destructive" role="alert">
							{futureError[s.id]}
						</p>{/if}
				</div>
			{/if}
			<div
				class="text-muted-foreground flex min-w-0 basis-full flex-wrap items-center gap-x-3 gap-y-1 text-xs sm:block sm:shrink-0 sm:basis-auto sm:text-right"
			>
				{#if s.project_archived_at !== null}
					<!-- The sweep skips an archived project's schedules without clearing
					     `enabled`, so the honest label is neither "next …" nor "paused". -->
					<p>paused · project archived</p>
				{:else if s.enabled}
					<p title={new Date(s.next_run_at).toLocaleString()}>{nextRunLabel(s.next_run_at)}</p>
				{:else}
					<p>paused</p>
				{/if}
				<p>
					{#if s.last_run_at}
						last {relativeTime(s.last_run_at)} ·
					{/if}
					{s.open_instances} open
				</p>
				{#if s.require_all_closed && s.open_instances > 0}
					<p class="flex items-center gap-1 text-amber-700 sm:justify-end dark:text-amber-400">
						<IconClock size={14} aria-hidden="true" />
						Waiting for {s.open_instances} open {s.open_instances === 1 ? 'issue' : 'issues'}
					</p>
				{/if}
			</div>
			<div class="flex basis-full items-center gap-1 sm:shrink-0 sm:basis-auto">
				<!-- Pause/resume: a toggle that morphs between states. -->
				<button
					type="button"
					role="switch"
					aria-checked={s.enabled}
					aria-label={s.enabled ? `Pause schedule ${s.name}` : `Resume schedule ${s.name}`}
					disabled={busyId !== null || readOnly}
					title={disabledReason}
					class="relative h-5 w-9 rounded-full transition-colors duration-200 {s.enabled
						? 'bg-primary'
						: 'bg-muted-foreground/30'}"
					onclick={() => toggleEnabled(s)}
				>
					<span
						class="bg-background absolute top-0.5 left-0.5 size-4 rounded-full shadow transition-transform duration-200 {s.enabled
							? 'translate-x-4'
							: ''}"
					></span>
				</button>
				<Button
					size="sm"
					variant="ghost"
					aria-label="Run schedule {s.name} now"
					title={disabledReason ?? 'Run now'}
					disabled={busyId !== null || readOnly}
					onclick={() => runNow(s)}
				>
					<IconPlayerPlay size={15} />
				</Button>
				<Button
					size="sm"
					variant="ghost"
					aria-label="Edit schedule {s.name}"
					title={disabledReason ?? 'Edit'}
					disabled={busyId !== null || readOnly}
					onclick={() => openEdit(s)}
				>
					<IconPencil size={15} />
				</Button>
				<Button
					size="sm"
					variant="ghost"
					aria-label="Delete schedule {s.name}"
					title={disabledReason ?? 'Delete (existing issues are kept)'}
					disabled={busyId !== null || readOnly}
					onclick={() => remove(s)}
				>
					<IconTrash size={15} />
				</Button>
			</div>
			<div
				class="min-w-0 basis-full text-sm [overflow-wrap:anywhere]"
				role="status"
				aria-live="polite"
				aria-atomic="true"
			>
				{#if runResult?.kind === 'success'}
					<div class="space-y-1" in:fade={{ duration: dur() }}>
						<p class="flex items-start gap-1 text-emerald-600 dark:text-emerald-400">
							<IconCheck class="mt-0.5 shrink-0" size={16} aria-hidden="true" />
							<a
								class="focus-visible:ring-ring rounded-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
								href="/issues/{encodeURIComponent(runResult.projectName)}/{runResult.number}"
							>
								Created {runResult.projectName}/#{runResult.number}
							</a>
						</p>
					</div>
				{/if}
			</div>
			{#if runResult?.kind === 'error'}
				<p
					class="text-destructive flex min-w-0 basis-full items-start gap-1 text-sm [overflow-wrap:anywhere]"
					role="alert"
					in:fade={{ duration: dur() }}
				>
					<IconAlertCircle class="mt-0.5 shrink-0" size={16} aria-hidden="true" />
					{runResult.message}
				</p>
			{:else if runResult?.kind === 'success' && runResult.refreshError}
				<p
					class="text-destructive flex min-w-0 basis-full items-start gap-1 text-sm [overflow-wrap:anywhere]"
					role="alert"
					in:fade={{ duration: dur() }}
				>
					<IconAlertCircle class="mt-0.5 shrink-0" size={16} aria-hidden="true" />
					{runResult.refreshError}
				</p>
			{/if}
		</li>
	{/each}
</ul>

<Modal bind:open={editOpen} title="Edit schedule">
	<form onsubmit={saveEdit} class="space-y-4">
		<div class="space-y-1.5">
			<label class="text-sm font-medium" for="schedule-name">Name</label>
			<Input id="schedule-name" bind:value={editName} required />
		</div>
		<div class="space-y-1.5">
			<label class="text-sm font-medium" for="schedule-title">Title template</label>
			<Input
				id="schedule-title"
				bind:value={editTitle}
				placeholder="Weekly report {'{{date}}'}"
				required
			/>
		</div>
		<div class="space-y-1.5">
			<label class="text-sm font-medium" for="schedule-description"
				>Description template (Markdown)</label
			>
			<Textarea id="schedule-description" bind:value={editDescription} rows={4} />
		</div>
		<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="schedule-workflow">Workflow</label>
				<Select id="schedule-workflow" bind:value={editWorkflowId} onchange={onEditWorkflowChange}>
					{#each workflows as workflow (workflow.id)}
						<option value={workflow.id}
							>{workflow.name}{workflow.is_system ? ' (standard)' : ''}</option
						>
					{/each}
				</Select>
			</div>
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="schedule-state">Starting state</label>
				<Select id="schedule-state" bind:value={editStateId}>
					{#each editWorkflow?.states ?? [] as state (state.id)}
						<option value={state.id}>
							{state.name}{state.id === editWorkflow?.initial_state_id ? ' — default' : ''}
						</option>
					{/each}
				</Select>
			</div>
		</div>
		<RepeatFields state={editRepeat} showNever={false} idPrefix="schedule-repeat" />
		{#if editError}
			<p class="text-destructive text-sm" transition:slide={{ duration: dur() }}>{editError}</p>
		{/if}
		<div class="flex flex-wrap justify-end gap-2">
			<Button type="button" variant="ghost" disabled={saving} onclick={() => (editOpen = false)}>
				Cancel
			</Button>
			<PendingButton
				type="submit"
				pending={saving}
				pendingLabel="Saving…"
				disabled={!editName.trim() || !editTitle.trim() || !editValid}
			>
				Save
			</PendingButton>
		</div>
	</form>
</Modal>
