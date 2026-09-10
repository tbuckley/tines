import type { ArtifactRequirement, LabelColor, ModelTier, StateCategory } from '../types.js';

export const LIBRARY_V3_VERSION = 3 as const;
export const LIBRARY_V3_MAX_DEPTH = 64;
export const LIBRARY_V3_MAX_RECORDS = 1_000;

export type LocalId = string;

export interface BundledStateRef {
	kind: 'bundled_state';
	state_id: LocalId;
}

export type WorkflowRef =
	| { kind: 'bundled_workflow'; workflow_id: LocalId }
	| { kind: 'input_workflow'; input_id: LocalId };

export interface ProjectRef {
	kind: 'input_project';
	input_id: LocalId;
}

export interface PackageState {
	id: LocalId;
	name: string;
	category: StateCategory;
	inherits_from: BundledStateRef | null;
}

export interface PackageTransition {
	id: LocalId;
	name: string;
	from_state_id: LocalId;
	to_state_id: LocalId;
	requires: ArtifactRequirement[];
}

export interface PackageWorkflow {
	id: LocalId;
	name: string;
	description: string;
	initial_state_id: LocalId;
	states: PackageState[];
	transitions: PackageTransition[];
}

export interface PackageFile {
	id: LocalId;
	path: string;
	content: string;
}

export type PackageContext = {
	id: LocalId;
	state_id: LocalId;
	name: string;
	description: string;
} & (
	| { kind: 'prompt'; body: string }
	| { kind: 'skill'; files: PackageFile[] }
	| { kind: 'repo'; repo_url: string; repo_branch: string | null; repo_dir: string | null }
);

export interface PackageInput {
	id: LocalId;
	key: string;
	type: 'text' | 'workflow' | 'label' | 'project';
	label: string;
	description: string;
	required: boolean;
	default: string | null;
	required_states?: string[];
}

export interface TextUse {
	id: LocalId;
	target: { record_id: LocalId; field: string };
	input_id: LocalId;
	token: string;
}

export interface PackageSchedule {
	id: LocalId;
	workflow: WorkflowRef;
	project: ProjectRef;
	name: string;
	title_template: string;
	description_template: string;
	recurrence: string;
	timezone: string;
	require_all_closed: boolean;
	start_state: BundledStateRef | null;
}

export interface PackageTierPreference {
	id: LocalId;
	scope: { state_id: LocalId; project?: ProjectRef };
	tier: ModelTier;
}

export interface WorkflowPackageDocument {
	format: 'tines.library';
	version: typeof LIBRARY_V3_VERSION;
	profile: 'workflow';
	exported_at: number;
	digest: string;
	main_workflow_id: LocalId;
	workflows: PackageWorkflow[];
	context: PackageContext[];
	inputs: PackageInput[];
	text_uses: TextUse[];
	schedules: PackageSchedule[];
	routing: PackageTierPreference[];
}

export interface LibraryV3Project {
	id: LocalId;
	name: string;
	description: string;
	default_workflow: WorkflowRef | { kind: 'system_workflow'; name: 'Standard' } | null;
}

export interface LibraryV3Label {
	id: LocalId;
	name: string;
	color: LabelColor;
}

export interface LibraryV3Document {
	format: 'tines.library';
	version: typeof LIBRARY_V3_VERSION;
	profile: 'library';
	exported_at: number;
	digest: string;
	projects: LibraryV3Project[];
	labels: LibraryV3Label[];
	workflows: PackageWorkflow[];
	context: PackageContext[];
}

export type PortableLibraryV3Document = WorkflowPackageDocument | LibraryV3Document;

export interface LibraryDiagnostic {
	path: string;
	code: string;
	message: string;
}

export class LibraryValidationError extends Error {
	constructor(public readonly diagnostics: LibraryDiagnostic[]) {
		super(diagnostics[0]?.message ?? 'Invalid library document');
		this.name = 'LibraryValidationError';
	}
}
