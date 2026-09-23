<script lang="ts">
	import type { Label, LabelWithUsage, Project, WorkflowResponse } from '@tines/shared';
	import { ApiError, ApiNetworkError } from '@tines/shared';
	import IconChevronRight from '@tabler/icons-svelte/icons/chevron-right';
	import IconRepeat from '@tabler/icons-svelte/icons/repeat';
	import IconTag from '@tabler/icons-svelte/icons/tag';
	import { tick } from 'svelte';
	import { slide } from 'svelte/transition';
	import { goto, invalidateAll } from '$app/navigation';
	import { api } from '$lib/api';
	import LabelPicker from '$lib/components/LabelPicker.svelte';
	import LabelChip from '$lib/components/LabelChip.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import IssueAttachmentPicker from '$lib/components/IssueAttachmentPicker.svelte';
	import PendingButton from '$lib/components/PendingButton.svelte';
	import PersonalPermissionWarning from '$lib/components/PersonalPermissionWarning.svelte';
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
		/** Preselects the picker: the project focus, else the last one used. */
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
	let uncertain = $state(false);
	let createdHref = $state<string | null>(null);
	let attachmentServerError = $state<{
		index: number;
		message: string;
		field: 'name' | 'file';
	} | null>(null);
	let attachmentValid = $state(true);
	let allowMyAgents = $state(true);
	let allowFutureAgents = $state(false);
	let attachments = $state<{ id: string; file: File; name: string; editing: boolean }[]>([]);
	let form = $state<HTMLFormElement | null>(null);

	const repeatValid = $derived(repeatSummary(repeat).ok);
	const hasRepeat = $derived(repeat.kind !== 'never');

	const selectedProject = $derived(project ?? projects.find((p) => p.id === projectId) ?? null);
	const defaultWorkflowId = $derived(
		selectedProject?.default_workflow_id ?? workflows.find((w) => w.is_system)?.id ?? ''
	);
	const pickedWorkflow = $derived(workflows.find((w) => w.id === workflowId));
	const pickedState = $derived(pickedWorkflow?.states.find((state) => state.id === stateId));
	const consentMode = $derived(selectedProject?.shared_at != null);
	const outgoingTransitions = $derived(
		pickedWorkflow?.transitions.filter((transition) => transition.from_state_id === stateId) ?? []
	);
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
			uncertain = false;
			createdHref = null;
			attachmentServerError = null;
			attachments = [];
			allowMyAgents = true;
			allowFutureAgents = false;
			// No `projects[0]` fallback: under "All projects" with no last project
			// the select starts empty and required, so nothing is filed by accident.
			projectId = project?.id ?? defaultProjectId ?? '';
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
		if (!attachmentValid) {
			attachments = attachments.map((attachment) => ({ ...attachment, editing: true }));
			await new Promise((resolve) => setTimeout(resolve));
			form?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
			return;
		}
		creating = true;
		let attachmentToFocus: { id: string; field: 'name' | 'file' } | null = null;
		errorMessage = null;
		uncertain = false;
		createdHref = null;
		attachmentServerError = null;
		try {
			const request = {
				title,
				description: description || undefined,
				workflow_id: workflowId || undefined,
				state: stateId || undefined,
				schedule: hasRepeat
					? {
							...repeatToScheduleInput(repeat),
							...(consentMode ? { allow_my_agents_on_future_instances: allowFutureAgents } : {})
						}
					: undefined,
				labels: labelIds.length > 0 ? labelIds : undefined,
				...(consentMode
					? {
							allow_my_agents: pickedState?.category !== 'done' ? allowMyAgents : false,
							expected_sharing_revision: selectedProject.sharing_revision,
							...((pickedState?.category !== 'done' && allowMyAgents) ||
							(hasRepeat && allowFutureAgents)
								? { disclosure_version: 1 }
								: {})
						}
					: {})
			};
			const snapshot = attachments.map((attachment) => ({
				name: attachment.name.trim(),
				filename: attachment.file.name,
				file: attachment.file
			}));
			const issue = snapshot.length
				? await api.createIssueWithFiles(selectedProject.id, request, snapshot)
				: await api.createIssue(selectedProject.id, request);
			createdHref = `/issues/${encodeURIComponent(issue.project_name)}/${issue.number}`;
			// "Last created-in": what New issue falls back to next time under
			// "All projects". Non-fatal — the issue itself already exists.
			if (!project && selectedProject.id !== defaultProjectId) {
				await api.updatePreferences({ last_project_id: selectedProject.id }).catch(() => {});
			}
			try {
				await invalidateAll();
				await goto(createdHref);
				open = false;
			} catch {
				errorMessage = 'The issue was created, but this page could not open it.';
			}
		} catch (err) {
			uncertain = err instanceof ApiNetworkError || !(err instanceof ApiError) || err.status >= 500;
			const attachmentIndex =
				err instanceof ApiError && typeof err.details?.attachment_index === 'number'
					? err.details.attachment_index
					: null;
			if (err instanceof ApiError && attachmentIndex !== null && attachments[attachmentIndex]) {
				const field =
					typeof err.details?.field === 'string' && err.details.field.endsWith('.name')
						? 'name'
						: 'file';
				if (field === 'name') attachments[attachmentIndex].editing = true;
				attachmentServerError = { index: attachmentIndex, message: err.message, field };
				attachmentToFocus = { id: attachments[attachmentIndex].id, field };
			}
			errorMessage = uncertain
				? 'We couldn’t confirm whether the issue was created. Check the project’s issues before submitting again.'
				: err instanceof ApiError
					? err.message
					: 'Something went wrong.';
		} finally {
			creating = false;
			if (attachmentToFocus) {
				await tick();
				form
					?.querySelector<HTMLElement>(
						attachmentToFocus.field === 'name'
							? `#attachment-name-${attachmentToFocus.id}`
							: `#attachment-row-${attachmentToFocus.id}`
					)
					?.focus();
			}
		}
	}
</script>

<Modal
	bind:open
	title={project ? `New issue in ${project.name}` : 'New issue'}
	dismissible={!creating}
>
	<form bind:this={form} onsubmit={create}>
		<fieldset disabled={creating} class="min-w-0 space-y-4">
			{#if !project}
				<div class="space-y-1.5">
					<label class="text-sm font-medium" for="issue-project">Project</label>
					<Select id="issue-project" bind:value={projectId} required>
						<option value="" disabled>Choose a project…</option>
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
			<IssueAttachmentPicker
				bind:attachments
				disabled={creating}
				transitions={outgoingTransitions}
				serverError={attachmentServerError}
				oninteract={(index) => {
					if (attachmentServerError?.index === index) attachmentServerError = null;
				}}
				onvalidchange={(valid) => (attachmentValid = valid)}
			/>
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
			{#if consentMode && pickedState?.category !== 'done'}
				<div class="rounded-md border p-3 text-sm">
					<label class="flex min-h-11 items-center gap-2 font-medium">
						<input type="checkbox" bind:checked={allowMyAgents} /> Allow my agents on this issue
					</label>
					<p class="text-muted-foreground mt-1 text-xs">
						If enabled, your agents may use your runner and account resources for this issue. You
						can turn it off later. Other people's permission is separate.
					</p>
					{#if allowMyAgents}<PersonalPermissionWarning />{/if}
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
						{#if consentMode && hasRepeat}
							<div class="mt-3 rounded-md border p-3 text-sm">
								<label class="flex min-h-11 items-center gap-2 font-medium">
									<input type="checkbox" bind:checked={allowFutureAgents} />
									Allow my agents on future issues from this schedule
								</label>
								<p class="text-muted-foreground mt-1 text-xs">
									Off by default. This is separate from permission on the first issue. If on, future
									issues inherit your permission until you turn it off or meaningfully change the
									schedule. Your agents may use your resources as work evolves.
								</p>
								{#if allowFutureAgents}<PersonalPermissionWarning future />{/if}
							</div>
						{/if}
					</div>
				{/if}
			</div>
			{#if hasRepeat && attachments.length > 0}
				<p class="text-muted-foreground text-sm">
					Attachments are added to this issue only. Future repeats won’t include them.
				</p>
			{/if}
			{#if errorMessage}
				<div class="text-destructive space-y-1 text-sm" role="alert">
					<p>{errorMessage}</p>
					{#if uncertain && selectedProject}
						<a
							class="underline"
							href="/projects/{selectedProject.id}"
							target="_blank"
							rel="noreferrer">Check project issues</a
						>
					{/if}
					{#if createdHref}<a class="underline" href={createdHref}>Open created issue</a>{/if}
				</div>
			{/if}
			<div class="flex flex-wrap justify-end gap-2">
				<Button type="button" variant="ghost" disabled={creating} onclick={() => (open = false)}>
					Cancel
				</Button>
				<PendingButton
					type="submit"
					pending={creating}
					pendingLabel={attachments.length > 0 ? 'Creating and attaching…' : 'Creating…'}
					disabled={!title.trim() ||
						!selectedProject ||
						(hasRepeat && !repeatValid) ||
						!attachmentValid}
				>
					{hasRepeat ? 'Create issue + schedule' : 'Create issue'}
				</PendingButton>
			</div>
		</fieldset>
	</form>
</Modal>
