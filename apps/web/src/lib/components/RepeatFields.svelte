<script lang="ts">
	import { WEEKDAY_NAMES } from '@tines/shared';
	import { repeatSummary, timezoneOptions, type RepeatFormState } from '$lib/schedule-form';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Select } from '$lib/components/ui/select/index.js';
	import TemplatePlaceholders from '$lib/components/TemplatePlaceholders.svelte';

	let {
		state,
		showNever = true,
		idPrefix = 'repeat'
	}: {
		/** Mutated in place; hold it in $state at the call site. */
		state: RepeatFormState;
		/** The edit modal hides "Never" — a schedule always has a recurrence. */
		showNever?: boolean;
		idPrefix?: string;
	} = $props();

	const summary = $derived(repeatSummary(state));
	const zones = $derived(timezoneOptions(state.timezone));
</script>

<div class="space-y-3">
	<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
		<div class="space-y-1.5">
			<label class="text-sm font-medium" for="{idPrefix}-kind">Repeat</label>
			<Select id="{idPrefix}-kind" bind:value={state.kind}>
				{#if showNever}
					<option value="never">Never</option>
				{/if}
				<option value="hourly">Hourly</option>
				<option value="daily">Daily</option>
				<option value="weekly">Weekly</option>
				<option value="monthly">Monthly</option>
				<option value="cron">Custom cron</option>
			</Select>
		</div>
		{#if state.kind === 'hourly'}
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="{idPrefix}-every-hours">Every</label>
				<Select id="{idPrefix}-every-hours" bind:value={state.everyHours}>
					{#each Array.from({ length: 23 }, (_, i) => i + 1) as n (n)}
						<option value={n}>{n === 1 ? '1 hour' : `${n} hours`}</option>
					{/each}
				</Select>
			</div>
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="{idPrefix}-minute">At minute</label>
				<Select id="{idPrefix}-minute" bind:value={state.minute}>
					{#each Array.from({ length: 60 }, (_, i) => i) as m (m)}
						<option value={m}>:{String(m).padStart(2, '0')}</option>
					{/each}
				</Select>
			</div>
		{:else if state.kind === 'weekly'}
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="{idPrefix}-weekday">On</label>
				<Select id="{idPrefix}-weekday" bind:value={state.weekday}>
					{#each WEEKDAY_NAMES as name, i (i)}
						<option value={i}>{name}</option>
					{/each}
				</Select>
			</div>
		{:else if state.kind === 'monthly'}
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="{idPrefix}-day">On day</label>
				<Select id="{idPrefix}-day" bind:value={state.dayOfMonth}>
					{#each Array.from({ length: 31 }, (_, i) => i + 1) as day (day)}
						<option value={day}>{day}</option>
					{/each}
				</Select>
			</div>
		{:else if state.kind === 'cron'}
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="{idPrefix}-cron">Cron expression</label>
				<Input
					id="{idPrefix}-cron"
					bind:value={state.cron}
					placeholder="0 9 * * 1"
					class="font-mono"
					spellcheck={false}
				/>
			</div>
		{/if}
		{#if state.kind === 'daily' || state.kind === 'weekly' || state.kind === 'monthly'}
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="{idPrefix}-time">At</label>
				<Input id="{idPrefix}-time" type="time" bind:value={state.time} />
			</div>
		{/if}
		{#if state.kind !== 'never'}
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="{idPrefix}-tz">Timezone</label>
				<Select id="{idPrefix}-tz" bind:value={state.timezone}>
					{#each zones as zone (zone)}
						<option value={zone}>{zone}</option>
					{/each}
				</Select>
			</div>
		{/if}
	</div>
	{#if state.kind !== 'never'}
		<label class="flex items-center gap-2 text-sm">
			<input type="checkbox" bind:checked={state.requireAllClosed} />
			Only create when previous instances are closed
		</label>
		<p class="text-sm {summary.ok ? 'text-muted-foreground' : 'text-destructive'}">
			{summary.text}
		</p>
		<TemplatePlaceholders class="border-t pt-3" />
	{/if}
</div>
