import type { SchedulePreset } from '../schedule.js';
import type { ArtifactRequirement, Label, LabelColor, ModelTier, StateCategory } from '../types.js';

export const LIBRARY_V3_VERSION = 3 as const;
export const LIBRARY_V3_MAX_DEPTH = 64;
export const LIBRARY_V3_MAX_RECORDS = 1_000;

export type LocalId = string;

export interface BundledStateRef {
	kind: 'bundled_state';
	state_id: LocalId;
}

export interface SystemStateRef {
	kind: 'system_state';
	workflow: 'Standard';
	state_name: string;
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

export type ContextPayload = {
	id: LocalId;
	name: string;
	description: string;
} & (
	| { kind: 'prompt'; body: string }
	| { kind: 'skill'; files: PackageFile[] }
	| { kind: 'repo'; repo_url: string; repo_branch: string | null; repo_dir: string | null }
);

export type PackageContext = ContextPayload & { state_id: LocalId };
export type LibraryV3Context = ContextPayload & {
	scope: { project_id?: LocalId; state?: BundledStateRef | SystemStateRef; label_id?: LocalId };
	journal: boolean;
};
export interface LibraryV3Workflow extends Omit<PackageWorkflow, 'states'> {
	states: Array<
		Omit<PackageState, 'inherits_from'> & { inherits_from: BundledStateRef | SystemStateRef | null }
	>;
}
export type TextUseField =
	'description' | 'body' | 'content' | 'title_template' | 'description_template';

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
	target: { record_id: LocalId; field: TextUseField };
	input_id: LocalId;
	token: string;
}

export interface PackageSchedule {
	id: LocalId;
	workflow: { kind: 'bundled_workflow'; workflow_id: LocalId };
	project: ProjectRef;
	name: string;
	title_template: string;
	description_template: string;
	recurrence: { kind: 'preset'; preset: SchedulePreset } | { kind: 'cron'; cron: string };
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
	default_workflow:
		| { kind: 'bundled_workflow'; workflow_id: LocalId }
		| { kind: 'system_workflow'; name: 'Standard' }
		| null;
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
	workflows: LibraryV3Workflow[];
	context: LibraryV3Context[];
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

/** Source IDs are request-only selectors; none are serialized into the portable document. */
export interface ExportWorkflowPackageOptions {
	source_project_id?: string;
	schedule_ids?: string[];
	tiers?: Array<{ state_id: string; tier: ModelTier; project_scoped?: boolean }>;
	authoring?: { inputs: PackageInput[]; text_uses: TextUse[] };
}

export interface ValidateLibraryRequest {
	document_json: string;
}
export interface ValidateLibraryResponse {
	valid: boolean;
	digest: string | null;
	document?: PortableLibraryV3Document;
	diagnostics: LibraryDiagnostic[];
	limits: { max_document_bytes: number; max_records: number; max_depth: number };
}

/** Destination choices are document-local-ID keyed; existing objects are picked by ID. */
export type PackageInputChoice =
	| { value: string }
	| { mode: 'reuse'; id: string }
	| { mode: 'create'; name: string; color: LabelColor };
export interface WorkflowPackageChoices {
	workflow_names?: Record<LocalId, string>;
	schedule_names?: Record<LocalId, string>;
	inputs?: Record<LocalId, PackageInputChoice>;
	schedule_ids?: LocalId[];
	routing?: Record<LocalId, ModelTier>;
}
export interface ResolvedPackageInput {
	input_id: LocalId;
	type: PackageInput['type'];
	mode: 'value' | 'reuse' | 'create' | 'unused';
	/** Destination display value, substituted only at declared uses. */
	value: string;
	id: string | null;
	color: LabelColor | null;
}
export interface PackageObjectAllocation {
	id: string;
	event_id: string | null;
}
export interface PackageAllocation {
	/** Workflow/state/transition/context/file/schedule/routing local IDs. */
	records: Record<LocalId, PackageObjectAllocation>;
	/** New labels are allocated separately from document record identities. */
	labels: Record<LocalId, PackageObjectAllocation>;
}

export interface PackageRoutingResolution {
	local_id: string;
	id: string;
	project_id: string | null;
	state_id: string;
	tier: ModelTier;
	runner_rule_id: string;
	winning_rule_id: string;
	targets: {
		runner_id: string;
		name: string;
		type: string;
		status: string;
		model: string | null;
		config: string;
		supported: boolean;
	}[];
	warnings: string[];
}
export interface WorkflowPackageReview {
	choices: WorkflowPackageChoices;
	names: Record<string, string>;
	inputs: ResolvedPackageInput[];
	labels: Label[];
	workflows: WorkflowPackageDocument['workflows'];
	context: WorkflowPackageDocument['context'];
	schedules: {
		local_id: string;
		project_id: string;
		definition: WorkflowPackageDocument['schedules'][number];
	}[];
	routing: PackageRoutingResolution[];
	patches: import('./render.js').RenderedPackageField[];
	skipped: { kind: 'schedule' | 'routing'; local_id: string }[];
}

export interface PrepareWorkflowPackageRequest {
	document_json: string;
	choices?: WorkflowPackageChoices;
}
export interface PrepareWorkflowPackageResponse {
	operations: PackageOperation[];
	document: WorkflowPackageDocument;
	resolved: WorkflowPackageReview;
	allocation: PackageAllocation;
	plan_id: string;
	plan_digest: string;
	document_digest: string;
	issued_at: number;
	expires_at: number;
	actor_key: string;
	compiler_version: number;
	plan_token: string;
	budget: WorkflowPackageBudget;
	source?: import('../publications.js').HostedPublicationBinding;
}

export interface WorkflowPackageBudget {
	statements: number;
	max_parameters: number;
	max_sql_bytes: number;
	max_value_bytes: number;
}

export interface PackageOperation {
	action: 'create' | 'reuse' | 'skip';
	kind: string;
	local_id: string;
	id: string | null;
	name: string;
	href: string | null;
	relationship?: 'main' | 'dependency';
}

export interface WorkflowPackageInstallRequest {
	document_json: string;
	plan_token: string;
	confirmation: { plan_digest: string };
}

export interface WorkflowPackageReceipt {
	id: string;
	document_digest: string;
	plan_digest: string;
	committed_at: number;
	objects: Array<{
		kind: string;
		local_id: string;
		id: string;
		name: string;
		href: string;
		relationship?: 'main' | 'dependency';
	}>;
	reused_inputs: Array<{ input_id: string; type: string; id: string; name: string }>;
	source?: import('../publications.js').HostedPublicationBinding;
}
