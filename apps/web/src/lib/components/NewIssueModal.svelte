<script lang="ts">
	import type { Project, WorkflowResponse } from '@tines/shared';
	import { ApiError } from '@tines/shared';
	import { goto, invalidateAll } from '$app/navigation';
	import { api } from '$lib/api';
	import Modal from '$lib/components/Modal.svelte';
	import WorkflowGraph from '$lib/components/WorkflowGraph.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Select } from '$lib/components/ui/select/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';

	let {
		open = $bindable(false),
		projects,
		workflows,
		project = null,
		defaultProjectId = null
	}: {
		open?: boolean;
		projects: Project[];
		workflows: WorkflowResponse[];
		/** Fixed project (no picker), e.g. on the project page. */
		project?: Project | null;
		/** Preselects the picker, e.g. from an active project filter. */
		defaultProjectId?: string | null;
	} = $props();

	let projectId = $state('');
	let title = $state('');
	let description = $state('');
	let workflowId = $state('');
	let stateId = $state('');
	let creating = $state(false);
	let errorMessage = $state<string | null>(null);

	const selectedProject = $derived(project ?? projects.find((p) => p.id === projectId) ?? null);
	const defaultWorkflowId = $derived(
		selectedProject?.default_workflow_id ?? workflows.find((w) => w.is_system)?.id ?? ''
	);
	const pickedWorkflow = $derived(workflows.find((w) => w.id === workflowId));

	// Reset the form whenever the dialog is closed (also seeds the first open).
	$effect(() => {
		if (!open) {
			title = '';
			description = '';
			errorMessage = null;
			projectId = project?.id ?? defaultProjectId ?? projects[0]?.id ?? '';
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
				state: stateId || undefined
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
		<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="issue-workflow">Workflow</label>
				<Select id="issue-workflow" bind:value={workflowId}>
					{#each workflows as workflow (workflow.id)}
						<option value={workflow.id}>
							{workflow.name}{workflow.is_system ? ' (standard)' : ''}{workflow.id === defaultWorkflowId ? ' — default' : ''}
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
		{#if errorMessage}
			<p class="text-destructive text-sm">{errorMessage}</p>
		{/if}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
			<Button type="submit" disabled={creating || !title.trim() || !selectedProject}>
				{creating ? 'Creating…' : 'Create issue'}
			</Button>
		</div>
	</form>
</Modal>
