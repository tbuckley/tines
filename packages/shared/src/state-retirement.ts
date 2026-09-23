/** Read-only Release A inventory and preservation-plan contracts. */

import type { ContextKind, ContextFile } from './types.js';

export type StateRetirementDiagnosticCode =
	| 'state_inheritance_cycle'
	| 'dangling_state_parent'
	| 'foreign_state_parent'
	| 'retirement_no_pointers'
	| 'retirement_inventory_invalid'
	| 'retirement_unsupported_kind'
	| 'retirement_inherited_env'
	| 'retirement_unrepresentable_order'
	| 'retirement_collision'
	| 'retirement_enumeration_bound'
	| 'retirement_repo_conflict'
	| 'retirement_position_overflow';

export interface StateRetirementDiagnostic {
	code: StateRetirementDiagnosticCode;
	state_id?: string;
	parent_state_id?: string;
	item_id?: string;
	message: string;
	/** A compact, non-secret witness of the counterexample. */
	details?: Record<string, unknown>;
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
	/** Exact, deterministically ordered database witness. */
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
	active_runs: Array<{ id: string; state_id_at_start: string; status: string }>;
}

export interface StateRetirementScope {
	project_id: string | null;
	workflow_state_id: string | null;
	label_id: string | null;
	issue_id: string | null;
}

export interface StateRetirementTargetClass {
	id: string;
	state_id: string;
	project: { kind: 'explicit'; id: string } | { kind: 'unmatched' };
	label_ids: string[];
	issue: { kind: 'explicit'; id: string } | { kind: 'none' };
}

export interface StateRetirementRawFile extends ContextFile {
	id: string;
	context_item_id: string;
	created_at: number;
	updated_at: number;
}

/** A witness row with secrets deliberately absent. */
export interface StateRetirementRawItem {
	id: string;
	kind: string;
	name: string;
	description: string;
	scope: StateRetirementScope;
	body: string | null;
	repo_url: string | null;
	repo_branch: string | null;
	repo_dir: string | null;
	config: string | null;
	position: number;
	version: number;
	created_at: number;
	updated_at: number;
	files: StateRetirementRawFile[];
	/** Public env metadata only; never a value or ciphertext. */
	env_hint?: string | null;
	env_secret?: boolean;
}

export interface StateRetirementSourceOrder {
	item_id: string;
	kind: string;
	name: string;
	position: number;
	state_depth: number;
	scope: StateRetirementScope;
	body_sha256?: string;
}

export interface StateRetirementAllocation {
	source_item_id: string;
	copy_item_id: string;
	copy_file_ids: string[];
	name: string;
	scope: StateRetirementScope;
	position: number;
	version: 1;
	source_version: number;
}

export interface StateRetirementCopyOperation {
	kind: 'copy_context_item';
	allocation: StateRetirementAllocation;
	payload: {
		item: Omit<StateRetirementRawItem, 'id' | 'files' | 'version' | 'updated_at'>;
		files: Array<{ id: string; path: string; content: string }>;
	};
}

export interface StateRetirementPointerOperation {
	kind: 'clear_pointer';
	child_state_id: string;
	original_parent_state_id: string;
	state_witness: Record<string, unknown>;
}

export type StateRetirementOperation =
	StateRetirementCopyOperation | StateRetirementPointerOperation;

export interface StateRetirementEffectiveItem {
	item_id: string;
	kind: ContextKind | string;
	name: string;
	scope: StateRetirementScope;
	body?: string;
	files?: ContextFile[];
	repo?: { url: string; branch: string | null; dir: string };
	env?: { secret: boolean; hint: string | null };
	position: number;
	version: number;
	inherited_from: string | null;
	is_journal: boolean;
}

export interface StateRetirementEffectiveBundle {
	prompts: StateRetirementEffectiveItem[];
	skills: StateRetirementEffectiveItem[];
	repos: StateRetirementEffectiveItem[];
	envs: StateRetirementEffectiveItem[];
	overridden: Array<{ item_id: string; overridden_by: string; kind: string; name: string }>;
	repo_conflicts: Array<{ dir: string; item_ids: string[] }>;
	journal: { state_id: string | null; item_id: string | null; version: number | null };
}

export interface StateRetirementLaunchDifference {
	before_text: string;
	after_text: string;
	body_changes: Array<{ source_item_id: string; copy_item_id: string | null; same_bytes: boolean }>;
	heading_changes: Array<{ before: string | null; after: string | null }>;
	allowed: boolean;
}

export interface StateRetirementTargetComparison {
	target: StateRetirementTargetClass;
	before: StateRetirementEffectiveBundle;
	after: StateRetirementEffectiveBundle;
	launch: StateRetirementLaunchDifference;
	raw_prompt_order: StateRetirementSourceOrder[];
	candidate_item_ids: string[];
}

export interface StateRetirementRollbackData {
	original_pointers: Array<{
		child_state_id: string;
		parent_state_id: string;
		state_witness: Record<string, unknown>;
	}>;
	source_to_copy: Record<string, string[]>;
	source_item_ids: string[];
	source_file_ids: string[];
}

export interface StateRetirementPlanV1 {
	version: 1;
	applyable: boolean;
	inventory: {
		owner_id: string;
		captured_at: number;
		inventory_digest: string;
		topology_digest: string;
	};
	held_states: string[];
	active_run_ids: string[];
	targets: StateRetirementTargetClass[];
	diagnostics: StateRetirementDiagnostic[];
	comparisons: StateRetirementTargetComparison[];
	allocations: StateRetirementAllocation[];
	source_to_copy: Record<string, string[]>;
	proposed_operations: StateRetirementOperation[];
	rollback: StateRetirementRollbackData;
}

export interface PrepareStateRetirementRequest {
	hold_id: string;
	inventory_json?: string;
}

export interface StateRetirementPlanResponse {
	version: 1;
	plan_id: string;
	plan_digest: string;
	inventory_digest: string;
	issued_at: number;
	expires_at: number;
	compiler_version: number;
	actor_key: string;
	budget: {
		statements: number;
		max_parameters: number;
		max_sql_bytes: number;
		max_value_bytes: number;
	};
	plan: StateRetirementPlanV1;
	/** Exact post-drain inventory to use for apply/recovery. */
	inventory_json: string;
	plan_token?: string;
}

export interface ApplyStateRetirementRequest {
	plan_token: string;
	inventory_json: string;
	confirmation: { plan_digest: string };
}

export interface StateRetirementReceiptV1 {
	version: 1;
	id: string;
	plan_id: string;
	hold_id: string;
	owner_id: string;
	actor_key: string;
	inventory_digest: string;
	plan_digest: string;
	request_digest: string;
	execution_nonce: string;
	committed_at: number;
	cleared_pointers: Array<{
		child_state_id: string;
		parent_state_id: string;
	}>;
	copies: Array<{
		source_item_id: string;
		copy_item_id: string;
		copy_file_ids: string[];
		name: string;
		scope: StateRetirementScope;
	}>;
	/** The immutable source snapshot used for rollback and operator review. */
	source_inventory_digest: string;
}

export interface StateRetirementPlannerOptions {
	max_targets?: number;
	max_labels?: number;
	max_copies?: number;
}
