<script lang="ts">
	import {
		LABEL_COLORS,
		MODEL_TIERS,
		type Label,
		type WorkflowPackageChoices,
		type WorkflowPackageDocument,
		type WorkflowResponse
	} from '@tines/shared';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Select } from '$lib/components/ui/select/index.js';

	let {
		document,
		choices,
		projects,
		workflows,
		labels,
		disabled = false,
		onchange
	}: {
		document: WorkflowPackageDocument;
		choices: WorkflowPackageChoices;
		projects: Array<{ id: string; name: string }>;
		workflows: WorkflowResponse[];
		labels: Label[];
		disabled?: boolean;
		onchange: (choices: WorkflowPackageChoices) => void;
	} = $props();

	const inputChoice = (id: string) => choices.inputs?.[id];
	function updateInput(id: string, value: NonNullable<WorkflowPackageChoices['inputs']>[string]) {
		onchange({ ...choices, inputs: { ...choices.inputs, [id]: value } });
	}
	function chooseObject(id: string, value: string) {
		if (value.startsWith('create:')) {
			updateInput(id, { mode: 'create', name: value.slice(7), color: LABEL_COLORS[0] });
		} else if (value) updateInput(id, { mode: 'reuse', id: value });
		else {
			const inputs = { ...choices.inputs };
			delete inputs[id];
			onchange({ ...choices, inputs });
		}
	}
	function objectValue(id: string) {
		const value = inputChoice(id);
		if (!value || !('mode' in value)) return '';
		return value.mode === 'reuse' ? value.id : `create:${value.name}`;
	}
	function isCreateChoice(id: string) {
		const value = inputChoice(id);
		return value && 'mode' in value && value.mode === 'create';
	}
	function toggleSchedule(id: string, checked: boolean) {
		const selected = new Set(choices.schedule_ids ?? []);
		checked ? selected.add(id) : selected.delete(id);
		onchange({ ...choices, schedule_ids: [...selected] });
	}
</script>

<section class="space-y-5" aria-labelledby="destination-values-title">
	<div>
		<h2 id="destination-values-title" class="text-lg font-semibold">Destination values</h2>
		<p class="text-muted-foreground mt-1 text-sm">
			Resolve declared values and choose optional automation. Schedules start unchecked.
		</p>
	</div>

	{#if document.inputs.length}
		<div class="space-y-3">
			{#each document.inputs as input (input.id)}
				<div
					class="grid min-w-0 gap-2 rounded-lg border p-3 sm:grid-cols-[minmax(12rem,1fr)_minmax(14rem,1.4fr)]"
					id="input-{input.id}"
				>
					<div>
						<label class="text-sm font-medium" for="value-{input.id}">{input.label}</label>
						<p class="text-muted-foreground text-xs">
							{input.description || input.key} · {input.type}{input.required
								? ' · required'
								: ' · optional'}
						</p>
						{#if input.required_states?.length}<p class="text-muted-foreground mt-1 text-xs">
								Required states: {input.required_states.join(', ')}
							</p>{/if}
					</div>
					{#if input.type === 'text'}
						<Input
							id="value-{input.id}"
							value={'value' in (inputChoice(input.id) ?? {})
								? (inputChoice(input.id) as { value: string }).value
								: (input.default ?? '')}
							placeholder={input.default ?? ''}
							{disabled}
							oninput={(e) => updateInput(input.id, { value: e.currentTarget.value })}
						/>
					{:else if input.type === 'project'}
						<Select
							id="value-{input.id}"
							value={objectValue(input.id)}
							{disabled}
							onchange={(e) => chooseObject(input.id, e.currentTarget.value)}
						>
							<option value="">Choose a destination project</option>
							{#each projects as item}<option value={item.id}>{item.name}</option>{/each}
						</Select>
					{:else if input.type === 'workflow'}
						<Select
							id="value-{input.id}"
							value={objectValue(input.id)}
							{disabled}
							onchange={(e) => chooseObject(input.id, e.currentTarget.value)}
						>
							<option value="">Choose a destination workflow</option>
							{#each workflows as item}<option value={item.id}>{item.name}</option>{/each}
						</Select>
					{:else}
						<div class="flex min-w-0 gap-2">
							<Select
								id="value-{input.id}"
								value={objectValue(input.id)}
								{disabled}
								onchange={(e) => chooseObject(input.id, e.currentTarget.value)}
							>
								<option value="">Choose or create a label</option>
								{#each labels as item}<option value={item.id}>{item.name}</option>{/each}
								{#if input.default}<option value="create:{input.default}"
										>Create “{input.default}”</option
									>{/if}
							</Select>
							{#if isCreateChoice(input.id)}
								<Select
									aria-label="Color for {input.label}"
									value={(inputChoice(input.id) as { color: string }).color}
									{disabled}
									onchange={(e) =>
										updateInput(input.id, {
											...(inputChoice(input.id) as {
												mode: 'create';
												name: string;
												color: (typeof LABEL_COLORS)[number];
											}),
											color: e.currentTarget.value as (typeof LABEL_COLORS)[number]
										})}
								>
									{#each LABEL_COLORS as color}<option value={color}>{color}</option>{/each}
								</Select>
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{:else}
		<p class="text-muted-foreground text-sm">This package declares no destination inputs.</p>
	{/if}

	{#if document.workflows.length}
		<fieldset class="space-y-2 rounded-lg border p-3" {disabled}>
			<legend class="px-1 text-sm font-medium">Independent workflow copies</legend>
			{#each document.workflows as workflow (workflow.id)}
				<label class="grid gap-1 sm:grid-cols-[12rem_1fr] sm:items-center" for="name-{workflow.id}">
					<span class="text-sm"
						>{workflow.id === document.main_workflow_id ? 'Main' : 'Dependency'} · {workflow.name}</span
					>
					<Input
						id="name-{workflow.id}"
						value={choices.workflow_names?.[workflow.id] ?? workflow.name}
						oninput={(e) =>
							onchange({
								...choices,
								workflow_names: { ...choices.workflow_names, [workflow.id]: e.currentTarget.value }
							})}
					/>
				</label>
			{/each}
		</fieldset>
	{/if}

	{#if document.schedules.length}
		<fieldset class="space-y-2 rounded-lg border p-3" {disabled}>
			<legend class="px-1 text-sm font-medium">Optional paused schedules</legend>
			{#each document.schedules as schedule (schedule.id)}
				<div
					class="grid gap-2 sm:grid-cols-[minmax(12rem,1fr)_minmax(14rem,1fr)] sm:items-center"
					id="schedule-choice-{schedule.id}"
				>
					<label class="flex min-h-10 items-center gap-2 text-sm"
						><input
							type="checkbox"
							checked={(choices.schedule_ids ?? []).includes(schedule.id)}
							onchange={(e) => toggleSchedule(schedule.id, e.currentTarget.checked)}
						/>
						{schedule.name}</label
					>
					{#if (choices.schedule_ids ?? []).includes(schedule.id)}<Input
							aria-label="Destination name for {schedule.name}"
							value={choices.schedule_names?.[schedule.id] ?? schedule.name}
							oninput={(e) =>
								onchange({
									...choices,
									schedule_names: {
										...choices.schedule_names,
										[schedule.id]: e.currentTarget.value
									}
								})}
						/>{/if}
				</div>
			{/each}
		</fieldset>
	{/if}

	{#if document.routing.length}
		<fieldset class="space-y-2 rounded-lg border p-3" {disabled}>
			<legend class="px-1 text-sm font-medium">Optional destination tier preferences</legend>
			{#each document.routing as route (route.id)}
				<label
					class="grid gap-1 sm:grid-cols-[minmax(12rem,1fr)_minmax(14rem,1fr)] sm:items-center"
					for="routing-{route.id}"
				>
					<span class="text-sm">{route.tier} · {route.scope.state_id}</span>
					<Select
						id="routing-{route.id}"
						value={choices.routing?.[route.id] ?? ''}
						onchange={(e) => {
							const routing = { ...choices.routing };
							if (e.currentTarget.value)
								routing[route.id] = e.currentTarget.value as (typeof MODEL_TIERS)[number];
							else delete routing[route.id];
							onchange({ ...choices, routing });
						}}
					>
						<option value="">Do not install</option>
						{#each MODEL_TIERS as tier}<option value={tier}>{tier}</option>{/each}
					</Select>
				</label>
			{/each}
		</fieldset>
	{/if}
</section>
