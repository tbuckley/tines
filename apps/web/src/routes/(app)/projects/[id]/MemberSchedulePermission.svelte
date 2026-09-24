<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { api } from '$lib/api';
	import type { SharedScheduleSummary } from '@tines/shared';
	import PersonalPermissionWarning from '$lib/components/PersonalPermissionWarning.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Select } from '$lib/components/ui/select/index.js';
	let { schedule }: { schedule: SharedScheduleSummary } = $props();
	let choice = $state<'on' | 'off'>('off');
	let choiceDirty = $state(false);
	$effect(() => {
		if (!choiceDirty) choice = schedule.my_future_permission.value === 'on' ? 'on' : 'off';
	});
	let saving = $state(false);
	let error = $state('');
	let notice = $state('');
	async function save() {
		if (saving) return;
		saving = true;
		error = '';
		notice = '';
		try {
			await api.setScheduleConsent(schedule.id, {
				value: choice,
				expected_revision: schedule.my_future_permission.revision,
				permission_epoch: schedule.my_future_permission.epoch,
				...(choice === 'on' ? { disclosure_version: 1 } : {})
			});
			notice = 'Future permission saved. Member execution is not available in this release.';
			choiceDirty = false;
			await invalidateAll();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Save failed';
		} finally {
			saving = false;
		}
	}
</script>

<div class="mt-3">
	<p class="text-sm">Your future permission: {schedule.my_future_permission.value}</p>
	<ul class="mt-2 space-y-1 text-sm" aria-label="Future permission roster">
		{#each schedule.roster as person (person.user.id)}
			<li class="flex flex-wrap justify-between gap-1 border-b py-1 last:border-b-0">
				{person.user.name}{person.user.id === schedule.viewer_id ? ' (You)' : ''} · {person.role} · {person.value}
			</li>
		{/each}
	</ul>
	<label class="mt-2 block text-sm" for={`future-${schedule.id}`}
		>My agents on future instances</label
	>
	<Select
		id={`future-${schedule.id}`}
		class="mt-2 min-h-11"
		bind:value={choice}
		onchange={() => (choiceDirty = true)}
		disabled={saving}
	>
		<option value="off">Off</option><option value="on">On</option>
	</Select>
	{#if choice === 'on'}<PersonalPermissionWarning future role="member" />{/if}
	<Button class="mt-3 w-full" onclick={save} disabled={saving}>Save future permission</Button>
	{#if error}<p role="alert" class="text-destructive mt-2">
			{error} Refresh and choose again if this permission changed.
		</p>{/if}
	{#if notice}<p role="status" class="mt-2">{notice}</p>{/if}
</div>
