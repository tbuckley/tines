<script lang="ts">
	import type { Schedule, UpdateScheduleRequest } from '@tines/shared';
	import { ApiError, describeRecurrence } from '@tines/shared';
	import IconPencil from '@tabler/icons-svelte/icons/pencil';
	import IconPlayerPlay from '@tabler/icons-svelte/icons/player-play';
	import IconTrash from '@tabler/icons-svelte/icons/trash';
	import { fade, slide } from 'svelte/transition';
	import { invalidateAll } from '$app/navigation';
	import { api } from '$lib/api';
	import Modal from '$lib/components/Modal.svelte';
	import RepeatFields from '$lib/components/RepeatFields.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { prefersReducedMotion, relativeTime, untilTime } from '$lib/format';
	import { defaultRepeatState, repeatFromSchedule, repeatSummary, repeatToScheduleInput } from '$lib/schedule-form';

	let {
		schedules,
		highlightId = null,
		onerror
	}: {
		schedules: Schedule[];
		/** Row to highlight (?schedule= deep links from issue badges). */
		highlightId?: string | null;
		onerror: (e: unknown) => void;
	} = $props();

	const dur = () => (prefersReducedMotion() ? 0 : 180);

	// One in-flight mutation at a time keeps the optimistic states simple.
	let busyId = $state<string | null>(null);

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

	const runNow = (s: Schedule) => mutate(s.id, () => api.runSchedule(s.id));

	function remove(s: Schedule) {
		if (
			!confirm(
				`Delete schedule "${s.name}"? Issues it already created are kept; only the schedule goes away.`
			)
		) {
			return;
		}
		void mutate(s.id, () => api.deleteSchedule(s.id));
	}

	// --- edit modal -------------------------------------------------------------

	let editing = $state<Schedule | null>(null);
	let editOpen = $state(false);
	let editName = $state('');
	let editTitle = $state('');
	let editDescription = $state('');
	let editRepeat = $state(defaultRepeatState());
	let saving = $state(false);
	let editError = $state<string | null>(null);

	function openEdit(s: Schedule) {
		editing = s;
		editName = s.name;
		editTitle = s.title_template;
		editDescription = s.description_template;
		editRepeat = repeatFromSchedule(s);
		editError = null;
		editOpen = true;
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
		<li
			class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 transition-[opacity,background-color] duration-200 {s.enabled
				? ''
				: 'opacity-60'} {highlightId === s.id ? 'bg-accent/60' : ''}"
			in:fade={{ duration: dur() }}
		>
			<div class="min-w-0 flex-1">
				<p class="truncate text-sm font-medium">{s.name}</p>
				<p class="text-muted-foreground text-xs">
					{describeRecurrence(s.preset, s.cron)}, {s.timezone}
					{#if s.require_all_closed}
						· only when closed
					{/if}
				</p>
			</div>
			<div class="text-muted-foreground hidden shrink-0 text-right text-xs sm:block">
				{#if s.enabled}
					<p title={new Date(s.next_run_at).toLocaleString()}>next {untilTime(s.next_run_at)}</p>
				{:else}
					<p>paused</p>
				{/if}
				<p>
					{#if s.last_run_at}
						last {relativeTime(s.last_run_at)} ·
					{/if}
					{s.open_instances} open
				</p>
			</div>
			<div class="flex shrink-0 items-center gap-1">
				<!-- Pause/resume: a toggle that morphs between states. -->
				<button
					type="button"
					role="switch"
					aria-checked={s.enabled}
					aria-label={s.enabled ? `Pause schedule ${s.name}` : `Resume schedule ${s.name}`}
					disabled={busyId !== null}
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
					title="Run now"
					disabled={busyId !== null}
					onclick={() => runNow(s)}
				>
					<IconPlayerPlay size={15} />
				</Button>
				<Button
					size="sm"
					variant="ghost"
					aria-label="Edit schedule {s.name}"
					title="Edit"
					disabled={busyId !== null}
					onclick={() => openEdit(s)}
				>
					<IconPencil size={15} />
				</Button>
				<Button
					size="sm"
					variant="ghost"
					aria-label="Delete schedule {s.name}"
					title="Delete (existing issues are kept)"
					disabled={busyId !== null}
					onclick={() => remove(s)}
				>
					<IconTrash size={15} />
				</Button>
			</div>
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
			<Input id="schedule-title" bind:value={editTitle} placeholder="Weekly report {'{{date}}'}" required />
		</div>
		<div class="space-y-1.5">
			<label class="text-sm font-medium" for="schedule-description">Description template (Markdown)</label>
			<Textarea id="schedule-description" bind:value={editDescription} rows={4} />
			<p class="text-muted-foreground text-xs">
				Placeholders: {'{{date}}'}, {'{{time}}'}, {'{{datetime}}'}, {'{{schedule_name}}'}, {'{{count}}'}
			</p>
		</div>
		<RepeatFields state={editRepeat} showNever={false} idPrefix="schedule-repeat" />
		{#if editError}
			<p class="text-destructive text-sm" transition:slide={{ duration: dur() }}>{editError}</p>
		{/if}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="ghost" onclick={() => (editOpen = false)}>Cancel</Button>
			<Button type="submit" disabled={saving || !editName.trim() || !editTitle.trim() || !editValid}>
				{saving ? 'Saving…' : 'Save'}
			</Button>
		</div>
	</form>
</Modal>
