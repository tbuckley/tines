/**
 * Wire types for the packs API (docs/packs.md). The pack format itself lives
 * in `./packs/`.
 */
import type { ContextItem, PackMissingInput, RunScope, StateCategory } from './types.js';
import type { PackInputDecl, PackIssue, PackModel, PackRecurrence } from './packs/types.js';

export type PackKind = 'authored' | 'installed';

export interface PackSource {
	kind: 'file' | 'project';
	/** `project` sources: where the pack was installed from (null once that pack is gone). */
	pack_id: string | null;
	project_id: string | null;
	project_name: string | null;
}

export interface PackSummary {
	id: string;
	/** `pack.yaml` id. */
	pack_key: string;
	name: string;
	description: string;
	kind: PackKind;
	/** Installed: the installed version. Authored: the last exported version, or null. */
	version: number | null;
	digest: string | null;
	position: number;
	project_id: string | null;
	source: PackSource | null;
	derived_from: { id: string; version: number | null } | null;
	/** Values this project lacks (and secrets the viewer lacks). Empty = set up. */
	needs_setup: PackMissingInput[];
	/** Installed from another project whose pack has changed since. */
	newer_version_available: boolean;
	/** Authored: content differs from the last export (or it was never exported). */
	changed_since_export: boolean;
	workflow_count: number;
	item_count: number;
	schedule_count: number;
	revision: number;
	created_at: number;
	updated_at: number;
}

/** A project's value for one input, as read back. Secrets never appear here. */
export type PackInputValue =
	| { type: 'text'; text: string }
	| { type: 'repo'; repo_url: string; repo_branch: string | null }
	| {
			type: 'workflow';
			workflow_id: string | null;
			state_id: string | null;
			/** Display: the bound workflow, or null when it was removed. */
			workflow_name: string | null;
			state_name: string | null;
	  };

export interface PackInputView {
	name: string;
	decl: PackInputDecl;
	/** Null = no value set (a default may still apply). */
	value: PackInputValue | null;
	/** Secret inputs: whether the viewer has supplied their own value. */
	my_secret_set?: boolean;
	/** True when nothing (value or default) satisfies a required input. */
	missing: boolean;
}

export interface PackWorkflowView {
	id: string;
	key: string;
	name: string;
	issue_count: number;
	states: {
		id: string;
		key: string;
		name: string;
		category: StateCategory;
		run_scope: RunScope;
	}[];
}

export interface PackScheduleView {
	key: string;
	name: string;
	workflow_key: string;
	start_key: string | null;
	recurrence: PackRecurrence;
	/** Plain-language recurrence, e.g. "Every Monday at 09:00". */
	recurrence_text: string;
	only_when_previous_closed: boolean;
	title: string;
	description: string;
	/** Project schedules created from this suggestion. */
	created_schedules: { id: string; name: string }[];
}

export interface PackDetail extends PackSummary {
	readme: string | null;
	changelog: string | null;
	inputs: PackInputView[];
	workflows: PackWorkflowView[];
	items: ContextItem[];
	schedules: PackScheduleView[];
	/** Project additions (the project's own items) on this pack's states. */
	project_addition_count: number;
}

/** One item in the project that a pack's item would override, or that would override it. */
export interface PackReplacement {
	kind: 'skill' | 'env' | 'repo';
	name: string;
	item_id: string;
	scope_label: string;
	direction: 'pack_overrides' | 'overrides_pack';
}

/** What a pack adds, in the terms the install and replace screens review. */
export interface PackAdds {
	workflows: { key: string; name: string; states: { key: string; name: string }[] }[];
	/** Every `project/` item: applies to every issue in the project. */
	project_items: { kind: string; name: string }[];
	env: { name: string; reach: string; value: string | null; input: string | null }[];
	fixed_repos: { name: string; url: string; branch: string | null }[];
	/** States whose run scope reaches past their issue. */
	wide_states: { workflow: string; state: string; run_scope: 'project' | 'organization' }[];
	schedules: { key: string; name: string }[];
}

export interface PackFileChange {
	path: string;
	change: 'added' | 'changed' | 'removed';
	/** UTF-8 text before/after, for the diff (absent for binary or very large files). */
	before?: string;
	after?: string;
}

/** A removed state that holds something, and where it should go. */
export interface PackStateMappingRow {
	state_id: string;
	workflow_key: string;
	state_key: string;
	workflow_name: string;
	state_name: string;
	issues: number;
	additions: number;
	schedules: number;
	/** Pre-filled destination (`migrations.yaml`), as a target `ref`. */
	suggested: string | null;
}

/** A state a removed state may be mapped to. `ref` is `<workflow>/<state>` for the pack, or a state id. */
export interface PackMappingTarget {
	ref: string;
	label: string;
}

export interface PackReview {
	action: 'install' | 'replace';
	digest: string;
	errors: PackIssue[];
	warnings: PackIssue[];
	/** Null when there are errors. */
	model: PackModel | null;
	adds: PackAdds | null;
	replacements: PackReplacement[];
	/** Each input with this project's current value (replace) and whether it needs one. */
	inputs: PackInputView[];
	/** True when a state reaches past its issue: only a browser session may confirm. */
	requires_browser: boolean;
	/** install: the pack id is already installed here (use replace). */
	already_installed?: { pack_id: string; name: string } | null;
	// Replace only.
	current?: { version: number | null; digest: string | null; kind: PackKind };
	/** CHANGELOG sections newer than the installed version (or the whole file). */
	changelog?: string | null;
	files?: PackFileChange[];
	/** Changes to what the pack adds, relative to the current version. */
	adds_changed?: PackAdds | null;
	state_mapping?: PackStateMappingRow[];
	mapping_targets?: PackMappingTarget[];
	/** Needs `confirm_version: true`: a lower version, or the same version with a different digest. */
	version_warning?: 'lower_version' | 'same_version_different_digest' | null;
	/** Authored: edits since the last export that the replace discards. */
	discards_authored_edits?: boolean;
}

/** One file of a pack on the wire. */
export interface PackWireFile {
	path: string;
	/** Base64 of the bytes. */
	content_b64: string;
}

/** Body of install/replace prepare and confirm: a zipped pack or its files. */
export type PackUpload =
	{ archive_b64: string; files?: never } | { files: PackWireFile[]; archive_b64?: never };

export interface PackInputValueInput {
	text?: string;
	repo_url?: string;
	repo_branch?: string | null;
	workflow_id?: string;
	state_id?: string | null;
}

export interface InstallPackRequest {
	/** The reviewed digest; the install is refused if the upload differs. */
	expected_digest: string;
	/** Install as an editable authored pack instead of read-only. */
	authored?: boolean;
	values?: Record<string, PackInputValueInput | null>;
	/** The installer's own values for secret inputs. */
	my_secrets?: Record<string, string>;
	/** Suggested schedules to create, enabled, by key. */
	schedules?: { key: string; timezone: string }[];
}

export interface ReplacePackRequest {
	expected_digest: string;
	/** Required for a lower version, or the same version with a different digest. */
	confirm_version?: boolean;
	/** Removed state id → target `ref` (see PackMappingTarget). */
	state_mapping?: Record<string, string>;
	values?: Record<string, PackInputValueInput | null>;
	my_secrets?: Record<string, string>;
}

export interface PackReceipt {
	id: string;
	action: 'install' | 'replace';
	pack: PackSummary;
	digest: string;
	version: number | null;
	created_at: number;
	/** Schedules created from suggestions. */
	schedules_created: { id: string; name: string }[];
	/** Replace: issues moved by the state mapping. */
	issues_moved?: number;
}

export interface PackExport {
	pack_key: string;
	version: number;
	digest: string;
	/** Suggested file name, e.g. `engineering-v4.tinespack`. */
	filename: string;
	files: PackWireFile[];
	/** True when this export took a new version. */
	new_version: boolean;
}

export interface CreatePackRequest {
	name: string;
	description?: string;
}

export interface UpdatePackRequest {
	expected_revision?: number;
	name?: string;
	description?: string;
	readme?: string | null;
	changelog?: string | null;
	/** Authored packs: the full set of input declarations, in order. */
	inputs?: Record<string, PackInputDecl>;
}

export interface AddPackWorkflowRequest {
	/** Copy a workflow used in this project into the pack. */
	copy_from: string;
	/** Optional key; defaults to one derived from the name. */
	key?: string;
}

export interface MovePackIssuesRequest {
	/** The workflow the issues and schedules come from. */
	from_workflow_id: string;
	/** Source state id → pack state id. Every source state holding issues or schedules needs one. */
	state_mapping: Record<string, string>;
}

export interface CreatePackItemRequest {
	reach: 'project' | 'pack' | 'workflow' | 'state';
	/** Workflow reach: a workflow of this pack. */
	workflow_id?: string;
	/** State reach: a state of this pack's workflows. */
	state_id?: string;
	kind: 'prompt' | 'skill' | 'env' | 'repo';
	name: string;
	description?: string;
	/** prompt */
	body?: string;
	/** prompt: stitch order within its folder (default 100). */
	order?: number;
	/** skill */
	files?: { path: string; content: string }[];
	/** env: a template value, or `input` for a text/secret input. */
	value?: string;
	/** env/repo: bind to this input. */
	input?: string;
	/** repo */
	repo_url?: string;
	repo_branch?: string | null;
	repo_dir?: string | null;
}

/**
 * `PATCH …/packs/:packId/items/:itemId` — where an authored pack's env or repo
 * item takes its value from: an input (`input`), or a fixed value (`input: null`
 * plus `value`, or `repo_url`/`repo_branch`). Other fields of a pack item are
 * edited through the ordinary context API.
 */
export interface UpdatePackItemBindingRequest {
	input: string | null;
	/** env, unbound: the value (a template; `{{ inputs.x }}` placeholders allowed). */
	value?: string;
	/** repo, unbound. */
	repo_url?: string;
	repo_branch?: string | null;
	expected_version?: number;
}

export interface SuggestPackScheduleRequest {
	/** An existing schedule on one of the pack's workflows. */
	schedule_id: string;
	/** The suggestion's key (file stem); defaults to one from the schedule's name. */
	key?: string;
}

export interface SetUpPackScheduleRequest {
	timezone: string;
}

export interface PackRemovePreview {
	blocked_by: { issues: { id: string; ref: string }[]; schedules: { id: string; name: string }[] };
	/** Project additions on the pack's states, deleted with it. */
	additions: { id: string; kind: string; name: string; scope_label: string }[];
	/** Workflow inputs in other packs that become unbound. */
	unbound_inputs: { pack_id: string; pack_name: string; input: string }[];
}

/** A pack in another project the viewer can read, offered as an install source. */
export interface PackSourceCandidate {
	pack_id: string;
	pack_key: string;
	name: string;
	description: string;
	kind: PackKind;
	version: number | null;
	project_id: string;
	project_name: string;
}
