/** Read-only Release A inventory for retiring state-context inheritance. */
export interface StateRetirementDiagnostic {
	code: 'state_inheritance_cycle' | 'dangling_state_parent' | 'foreign_state_parent';
	state_id: string;
	parent_state_id: string;
	message: string;
}

export interface StateRetirementInventoryV1 {
	version: 1;
	owner_id: string;
	captured_at: number;
	inventory_digest: string;
	topology_digest: string;
	diagnostics: StateRetirementDiagnostic[];
	pointers: Array<{
		child_state_id: string;
		parent_state_id: string;
		chain: string[];
	}>;
	/**
	 * Exact, deterministically ordered database witness. It intentionally keeps
	 * losing context candidates and empty sets so a reviewed cutover can be
	 * invalidated by any relevant insertion, deletion, re-scope, or byte edit.
	 */
	witness: StateRetirementWitnessV1;
}

export interface StateRetirementWitnessV1 {
	workflows: Record<string, unknown>[];
	states: Record<string, unknown>[];
	transitions: Record<string, unknown>[];
	projects: Record<string, unknown>[];
	labels: Record<string, unknown>[];
	issues: Record<string, unknown>[];
	issue_labels: Record<string, unknown>[];
	context_items: Record<string, unknown>[];
	context_files: Record<string, unknown>[];
	active_runs: Record<string, unknown>[];
}

export interface AcquireStateRetirementHoldRequest {
	inventory_json: string;
	confirmation: { inventory_digest: string };
}

export interface StateRetirementHold {
	id: string;
	inventory_digest: string;
	topology_digest: string;
	created_at: number;
	held_states: Array<{
		state_id: string;
		workflow_name: string;
		state_name: string;
		state_category: string;
	}>;
	active_runs: Array<{
		id: string;
		state_id_at_start: string;
		status: string;
	}>;
}
