<script lang="ts">
	import type { Label, LabelWithUsage, Project, WorkflowResponse } from '@tines/shared';
	import { ApiError } from '@tines/shared';
	import IconChevronRight from '@tabler/icons-svelte/icons/chevron-right';
	import IconRepeat from '@tabler/icons-svelte/icons/repeat';
	import IconTag from '@tabler/icons-svelte/icons/tag';
	import { slide } from 'svelte/transition';
	import { goto, invalidateAll } from '$app/navigation';
	import { api } from '$lib/api';
	import LabelPicker from '$lib/components/LabelPicker.svelte';
	import LabelChip from '$lib/components/LabelChip.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import PendingButton from '$lib/components/PendingButton.svelte';
	import RepeatFields from '$lib/components/RepeatFields.svelte';
	import WorkflowGraph from '$lib/components/WorkflowGraph.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Select } from '$lib/components/ui/select/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { prefersReducedMotion } from '$lib/format';
	import { defaultRepeatState, repeatSummary, repeatToScheduleInput } from '$lib/schedule-form';

	let {
		open = $bindable(false),
		projects,
		workflows,
		labels = [],
		project = null,
		defaultProjectId = null,
		repeatOpen = $bindable(false)
	}: {
		open?: boolean;
		projects: Project[];
		workflows: WorkflowResponse[];
		/** The user's label vocabulary, for the picker. */
		labels?: LabelWithUsage[];
		/** Fixed project (no picker), e.g. on the project page. */
		project?: Project | null;
		/** Preselects the picker, e.g. from an active project filter. */
		defaultProjectId?: string | null;
		/** Starts with the Repeat section expanded (the schedules "add" affordance). */
		repeatOpen?: boolean;
	} = $props();

	const dur = () => (prefersReducedMotion() ? 0 : 150);

	let projectId = $state('');
	let title = $state('');
	let description = $state('');
	let workflowId = $state('');
	let stateId = $state('');
	let repeat = $state(defaultRepeatState());
	let labelIds = $state<string[]>([]);
	/** Labels minted from the picker before this issue exists. */
	let minted = $state<Label[]>([]);
	let creating = $state(false);
	let errorMessage = $state<string | null>(null);

	const repeatValid = $derived(repeatSummary(repeat).ok);
	const hasRepeat = $derived(repeat.kind !== 'never');

	const selectedProject = $derived(project ?? projects.find((p) => p.id === projectId) ?? null);
	const defaultWorkflowId = $derived(
		selectedProject?.default_workflow_id ?? workflows.find((w) => w.is_system)?.id ?? ''
	);
	const pickedWorkflow = $derived(workflows.find((w) => w.id === workflowId));
	const pickerLabels = $derived([
		...labels,
		...minted.filter((m) => !labels.some((l) => l.id === m.id))
	]);

	// Reset the form whenever the dialog is closed (also seeds the first open).
	$effect(() => {
		if (!open) {
			title = '';
			description = '';
			errorMessage = null;
			projectId = project?.id ?? defaultProjectId ?? projects[0]?.id ?? '';
			repeat = defaultRepeatState();
			labelIds = [];
			minted = [];
			repeatOpen = false;
		}
	});
	// The workflow follows the picked project's default…
	$effect(() => {
		workflowId = defaultWorkflowId;
	});
	// …and the starting state follows the picked workflow's initial state.
	$effect(() => {
		stateId = pickedWorkflow?.initial_state_id ?? '';
	});

	async function create(e: SubmitEvent) {
		e.preventDefault();
		if (creating || !selectedProject) return;
		creating = true;
		errorMessage = null;
		try {
			const issue = await api.createIssue(selectedProject.id, {
				title,
				description: description || undefined,
				workflow_id: workflowId || undefined,
				state: stateId || undefined,
				schedule: repeatToScheduleInput(repeat) ?? undefined,
				labels: labelIds.length > 0 ? labelIds : undefined
			});
			open = false;
			await invalidateAll();
			await goto(`/issues/${encodeURIComponent(issue.project_name)}/${issue.number}`);
		} catch (err) {
			errorMessage = err instanceof ApiError ? err.message : 'Something went wrong — try again.';
		} finally {
			creating = false;
		}
	}
</script>

<Modal bind:open title={project ? `New issue in ${project.name}` : 'New issue'}>
	<form onsubmit={create} class="space-y-4">
		{#if !project}
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="issue-project">Project</label>
				<Select id="issue-project" bind:value={projectId} required>
					{#each projects as p (p.id)}
						<option value={p.id}>{p.name}</option>
					{/each}
				</Select>
			</div>
		{/if}
		<div class="space-y-1.5">
			<label class="text-sm font-medium" for="issue-title">Title</label>
			<Input id="issue-title" bind:value={title} placeholder="What needs doing?" required />
		</div>
		<div class="space-y-1.5">
			<label class="text-sm font-medium" for="issue-description">Description (Markdown)</label>
			<Textarea id="issue-description" bind:value={description} rows={4} />
		</div>
		<div class="space-y-1.5">
			<span class="text-sm font-medium">Labels</span>
			<div class="flex flex-wrap items-center gap-1.5">
				{#each pickerLabels.filter((l) => labelIds.includes(l.id)) as label (label.id)}
					<LabelChip
						{label}
						size="sm"
						onremove={() => (labelIds = labelIds.filter((id) => id !== label.id))}
					/>
				{/each}
				<LabelPicker
					labels={pickerLabels}
					selected={labelIds}
					onchange={(ids) => (labelIds = ids)}
					allowCreate
					oncreated={(l) => (minted = [...minted, l])}
				>
					{#snippet trigger({ props })}
						<Button {...props} type="button" size="sm" variant="outline" class="h-7 px-2 text-xs">
							<IconTag size={14} /> Add label
						</Button>
					{/snippet}
				</LabelPicker>
			</div>
		</div>
		<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="issue-workflow">Workflow</label>
				<Select id="issue-workflow" bind:value={workflowId}>
					{#each workflows as workflow (workflow.id)}
						<option value={workflow.id}>
							{workflow.name}{workflow.is_system ? ' (standard)' : ''}{workflow.id ===
							defaultWorkflowId
								? ' — default'
								: ''}
						</option>
					{/each}
				</Select>
			</div>
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="issue-state">Starting state</label>
				<Select id="issue-state" bind:value={stateId}>
					{#each pickedWorkflow?.states ?? [] as state (state.id)}
						<option value={state.id}>
							{state.name}{state.id === pickedWorkflow?.initial_state_id ? ' — default' : ''}
						</option>
					{/each}
				</Select>
			</div>
		</div>
		{#if pickedWorkflow}
			<div class="bg-muted/40 rounded-md border p-2">
				<WorkflowGraph workflow={pickedWorkflow} currentStateId={stateId || null} compact />
			</div>
		{/if}
		<div class="rounded-md border">
			<button
				type="button"
				class="hover:bg-accent/50 flex w-full items-center gap-2 px-3 py-2 text-sm font-medium transition-colors"
				aria-expanded={repeatOpen}
				onclick={() => (repeatOpen = !repeatOpen)}
			>
				<IconChevronRight
					size={16}
					class="text-muted-foreground transition-transform {repeatOpen ? 'rotate-90' : ''}"
				/>
				<IconRepeat size={16} class="text-muted-foreground" />
				Repeat
				{#if hasRepeat && !repeatOpen}
					<span class="text-muted-foreground ml-auto truncate text-xs font-normal">
						{repeatSummary(repeat).text}
					</span>
				{/if}
			</button>
			{#if repeatOpen}
				<div class="border-t px-3 py-3" transition:slide={{ duration: dur() }}>
					<RepeatFields state={repeat} idPrefix="issue-repeat" />
				</div>
			{/if}
		</div>
		{#if errorMessage}
			<p class="text-destructive text-sm">{errorMessage}</p>
		{/if}
		<div class="flex flex-wrap justify-end gap-2">
			<Button type="button" variant="ghost" disabled={creating} onclick={() => (open = false)}>
				Cancel
			</Button>
			<PendingButton
				type="submit"
				pending={creating}
				pendingLabel="Creating…"
				disabled={!title.trim() || !selectedProject || (hasRepeat && !repeatValid)}
			>
				{hasRepeat ? 'Create issue + schedule' : 'Create issue'}
			</PendingButton>
		</div>
	</form>
</Modal>
