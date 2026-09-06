<script lang="ts">
	import type { WorkflowResponse, WorkflowState } from '@tines/shared';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Select } from '$lib/components/ui/select/index.js';

	/**
	 * The escape hatch under the transitions: jump to any state, or move onto
	 * another workflow, bypassing the workflow's own transitions.
	 *
	 * The form's values are the user's explicit picks overlaid on derived
	 * defaults — never effect-reset from the issue, which would wipe a
	 * half-filled form whenever the background poll resyncs. A pick that no
	 * longer resolves (its workflow/state vanished in a resync) falls back to
	 * the default rather than pointing the form at nothing.
	 */
	let {
		workflows,
		issueWorkflow,
		currentState,
		disabledReason = null,
		onapply
	}: {
		workflows: WorkflowResponse[];
		issueWorkflow: Pick<WorkflowResponse, 'id' | 'states' | 'initial_state_id'>;
		currentState: WorkflowState;
		/** When set, every control renders disabled with this as its tooltip. */
		disabledReason?: string | null;
		/** Applies the move; rejects on failure (the caller reports it). */
		onapply: (patch: { workflow_id?: string; state: string }) => Promise<void>;
	} = $props();

	const readOnly = $derived(disabledReason != null);

	const uid = $props.id();

	let workflowPick = $state<string | null>(null);
	let statePick = $state<string | null>(null);
	const workflowId = $derived(
		workflowPick && workflows.some((w) => w.id === workflowPick) ? workflowPick : issueWorkflow.id
	);
	const workflow = $derived(workflows.find((w) => w.id === workflowId) ?? issueWorkflow);
	// Staying on the current workflow starts from the current state; a new
	// workflow starts from its initial state.
	const stateId = $derived(
		statePick && workflow.states.some((s) => s.id === statePick)
			? statePick
			: workflowId === issueWorkflow.id
				? currentState.id
				: workflow.initial_state_id
	);
	const dirty = $derived(workflowId !== issueWorkflow.id || stateId !== currentState.id);

	let applying = $state(false);
	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (applying || !dirty) return;
		applying = true;
		try {
			await onapply({
				...(workflowId !== issueWorkflow.id ? { workflow_id: workflowId } : {}),
				state: stateId
			});
			// Applied and reloaded — the defaults now describe the new position,
			// so the picks have served their purpose.
			workflowPick = null;
			statePick = null;
		} catch {
			// Reported by the caller; the picks stay so the user can retry.
		} finally {
			applying = false;
		}
	}
</script>

<form onsubmit={submit} class="space-y-3">
	<div class="space-y-1">
		<label class="text-muted-foreground text-xs font-medium" for="{uid}-workflow">Workflow</label>
		<Select
			id="{uid}-workflow"
			bind:value={
				() => workflowId,
				(v) => {
					workflowPick = v;
					statePick = null; // a new workflow restarts the state default
				}
			}
			class="h-8 text-xs"
			disabled={readOnly}
			title={disabledReason}
		>
			{#each workflows as w (w.id)}
				<option value={w.id}>{w.name}{w.is_system ? ' (standard)' : ''}</option>
			{/each}
		</Select>
	</div>
	<div class="space-y-1">
		<label class="text-muted-foreground text-xs font-medium" for="{uid}-state">State</label>
		<Select
			id="{uid}-state"
			bind:value={() => stateId, (v) => (statePick = v)}
			class="h-8 text-xs"
			disabled={readOnly}
			title={disabledReason}
		>
			{#each workflow.states as state (state.id)}
				<option value={state.id}>
					{state.name}{workflowId === issueWorkflow.id && state.id === currentState.id
						? ' — current'
						: ''}
				</option>
			{/each}
		</Select>
	</div>
	<div class="flex items-center gap-2">
		<Button
			type="submit"
			size="sm"
			variant="outline"
			disabled={!dirty || applying || readOnly}
			title={disabledReason}
		>
			{applying ? 'Moving…' : 'Move'}
		</Button>
		<p class="text-muted-foreground text-xs">Bypasses the workflow's transitions.</p>
	</div>
</form>
