/** Wire types for the Tines phase-one API (`/api/v1/*`). All snake_case. */

import type { SchedulePreset } from './schedule.js';
import type { EffortApplicationStatus, EffortCapabilities, EffortSource } from './effort.js';

export type StateCategory = 'backlog' | 'active' | 'awaiting_human' | 'done';

export const STATE_CATEGORIES: readonly StateCategory[] = [
	'backlog',
	'active',
	'awaiting_human',
	'done'
];

/**
 * A run-key actor's structural provenance, resolved through the run to the
 * runner and issue. Its API-key name may carry a mint-time runner/stage
 * snapshot used for display.
 */
export interface ActorRun {
	run_id: string;
	runner_name: string;
	/** Immutable names captured when the run key was minted; null on legacy keys. */
	stage?: { workflow_name: string; state_name: string } | null;
	/** The issue the run is working; null if it has been deleted. */
	issue_ref: { project_name: string; number: number } | null;
}

/** Who performed an action: always a user, optionally via a named API key. */
export interface Actor {
	user_id: string;
	user_name: string;
	/** NULL when the user acted directly (browser session). */
	api_key_id: string | null;
	api_key_name: string | null;
	/** Set structurally for a run key; never inferred from the key name. */
	run?: ActorRun | null;
}

/**
 * How a run is named wherever one is referred to: "run on demo/12", or
 * "run <id>" when the issue it worked has been deleted. Shared by
 * `actorLabel` and the API keys page, so both spell a run the same way.
 */
export function runRefLabel(run: ActorRun): string {
	return run.issue_ref
		? `run on ${run.issue_ref.project_name}/${run.issue_ref.number}`
		: `run ${run.run_id}`;
}

/**
 * Canonical actor rendering everywhere actions are attributed: "alice",
 * "alice via laptop-key", or — for a descriptively named run key — "alice
 * via laptop-m4 · Engineering/Design · run on demo/12". Legacy and blank run
 * key names fall back to the live runner name.
 */
export function actorLabel(actor: Actor): string {
	if (actor.run) {
		const legacyName = `run ${actor.run.run_id}`;
		const hasDescriptiveName =
			Boolean(actor.api_key_name?.trim()) && actor.api_key_name !== legacyName;
		const via = hasDescriptiveName ? actor.api_key_name! : actor.run.runner_name;
		return `${actor.user_name} via ${via} · ${runRefLabel(actor.run)}`;
	}
	return actor.api_key_name ? `${actor.user_name} via ${actor.api_key_name}` : actor.user_name;
}

/**
 * Compact actor rendering for narrow, issue-local surfaces. Structured
 * mint-time stage metadata lets this omit only the runner without parsing the
 * ambiguous human-readable API-key name. Legacy keys have no stage snapshot.
 */
export function compactActorLabel(actor: Actor): string {
	if (!actor.run) return actorLabel(actor);
	const stage = actor.run.stage
		? ` · ${actor.run.stage.workflow_name}/${actor.run.stage.state_name}`
		: '';
	return `${actor.user_name}${stage} · ${runRefLabel(actor.run)}`;
}

// ---------------------------------------------------------------------------
// Projects

/** Project names are measured as JavaScript string length (UTF-16 code units). */
export const PROJECT_NAME_MAX = 200;

export interface Project {
	id: string;
	name: string;
	description: string;
	default_workflow_id: string | null;
	created_at: number;
	updated_at: number;
	/** Issues currently in the project (all states). */
	issue_count: number;
	/** Set (ms) while the project is archived; null = live. */
	archived_at: number | null;
}

export interface CreateProjectRequest {
	name: string;
	description?: string;
	default_workflow_id?: string | null;
	/**
	 * When present, also creates a project-scoped prompt item named
	 * "conventions" with this Markdown body, in the same transaction.
	 * Present (even `''`) beats a starter's `conventions_template`; absent
	 * falls back to it.
	 */
	initial_prompt?: string;
	/**
	 * Apply a built-in starter atomically with the project (Tines/248):
	 * its workflows, context and first issue land in the same batch, or
	 * nothing does. Absent is equivalent to `{ id: 'blank' }`.
	 */
	starter?: { id: string; inputs?: Record<string, string> };
}

/** The built-in starters. `blank` is today's behaviour, named. */
export const STARTER_IDS = ['blank', 'code', 'plan'] as const;
export type StarterId = (typeof STARTER_IDS)[number];

/** The typed inputs a starter can declare. */
export const STARTER_INPUT_KEYS = ['repo_url', 'repo_branch', 'brief'] as const;
export type StarterInputKey = (typeof STARTER_INPUT_KEYS)[number];

export interface StarterInputSpec {
	key: StarterInputKey;
	/** Form label, e.g. "Repository URL". */
	label: string;
	required: boolean;
	/** Form hint. */
	description?: string;
	/** Max length after trimming (default 10_000). */
	max?: number;
}

/** What a starter creates, as `GET /api/v1/projects/starters` advertises it. */
export interface StarterSummary {
	id: StarterId;
	name: string;
	/** One sentence for the chooser card. */
	description: string;
	inputs: StarterInputSpec[];
	/** Prefills the conventions textarea; null for blank. Templated with `{{ key }}`. */
	conventions_template: string | null;
	creates: {
		workflows: { name: string; default: boolean; states: string[] }[];
		/** Names may still contain `{{ … }}` placeholders. */
		context: { kind: ContextKind; name: string }[];
		first_issue: { title: string; workflow: string; state: string } | null;
	};
}

export interface ListStartersResponse {
	items: StarterSummary[];
}

/** What a starter actually created, reported on the 201. */
export interface StarterApplied {
	id: StarterId;
	/** `reused: true` means an identical-fingerprint workflow already existed. */
	workflows: { id: string; name: string; reused: boolean }[];
	context: { id: string; kind: ContextKind; name: string }[];
	first_issue: { id: string; number: number; ref: string; state_name: string } | null;
}

/** A created project, plus the starter summary when one applied. */
export type CreateProjectResponse = Project & { starter?: StarterApplied };

export interface UpdateProjectRequest {
	name?: string;
	description?: string;
	default_workflow_id?: string | null;
}

/** How `archived` narrows a list; absent means `'false'`. */
export type ArchivedFilter = 'true' | 'false' | 'all';

export interface ProjectListFilters {
	/** `'false'` (default) hides archived projects, `'true'` shows only them. */
	archived?: ArchivedFilter;
}

/** A run that was still active when its project was archived. */
export interface DrainingRun {
	run_id: string;
	runner_name: string;
	issue_id: string;
	issue_number: number;
}

export interface ArchiveProjectResponse {
	/** The project with `archived_at` set. */
	project: Project;
	/** Enabled schedules that will not fire while the project is archived. */
	schedules_paused: number;
	/** Runs allowed to finish on their own issue; nothing new dispatches. */
	draining_runs: DrainingRun[];
	/** Issues frozen by the archive. */
	issues_read_only: number;
}

export interface UnarchiveProjectResponse {
	project: Project;
	/** Enabled schedules whose `next_run_at` was advanced to the next future occurrence. */
	schedules_resumed: number;
}

// ---------------------------------------------------------------------------
// Workflows

export interface WorkflowState {
	id: string;
	name: string;
	category: StateCategory;
	position: number;
	/** Historical nullable pointer; Release B runtime always returns null. */
	inherits_from: string | null;
}

export interface WorkflowTransition {
	id: string;
	/** The action this transition represents, e.g. "approve", "send back". */
	name: string;
	from_state_id: string;
	to_state_id: string;
	/** Artifact requirements gating this transition (absent = none). */
	requires?: ArtifactRequirement[];
}

export interface Workflow {
	id: string;
	name: string;
	description: string;
	/** True for the built-in standard workflow (read-only, owned by no user). */
	is_system: boolean;
	initial_state_id: string;
	states: WorkflowState[];
	transitions: WorkflowTransition[];
	/** Issues currently bound to this workflow. */
	issue_count: number;
	created_at: number;
	updated_at: number;
}

/**
 * A state in a create/update request. `id` present = the existing state with
 * that id (rename/recategorize); absent = a new state.
 */
export interface WorkflowStateInput {
	id?: string;
	name: string;
	category: StateCategory;
	/**
	 * New states only (422 on existing states): also creates a state-scoped
	 * prompt item named "instructions" with this Markdown body, in the same
	 * transaction. Existing stage instructions are edited through the
	 * context surfaces, not re-sent through workflow updates.
	 */
	prompt?: string;
	/** Retained for historical package compatibility; non-null values are rejected. */
	inherits_from?: string | null;
}

/**
 * A transition in a create/update request. `name` is the action it
 * represents (required, unique per source state). `from`/`to` reference
 * states in the same request by existing state id or by state name (names
 * are unique within a workflow, so either is unambiguous).
 */
export interface WorkflowTransitionInput {
	name: string;
	from: string;
	to: string;
	/** Artifact requirements gating this transition (absent/empty = none). */
	requires?: ArtifactRequirement[];
}

export interface CreateWorkflowRequest {
	name: string;
	description?: string;
	/** State id or name; must be categorized `backlog` or `active`. */
	initial_state: string;
	states: WorkflowStateInput[];
	transitions: WorkflowTransitionInput[];
}

/**
 * Updates replace what they include: when `states` is present, existing
 * states not listed (by id) are deleted, subject to the editing rules; when
 * `transitions` is present, the transition set is replaced wholesale.
 */
export interface UpdateWorkflowRequest {
	name?: string;
	description?: string;
	initial_state?: string;
	states?: WorkflowStateInput[];
	transitions?: WorkflowTransitionInput[];
	/**
	 * Removing states with attached context items is rejected by default;
	 * with this flag the removal proceeds and those items are deleted
	 * (all-or-nothing, one `context.deleted` event each).
	 */
	force_delete_context?: boolean;
	/** Retained as a compatibility input; affirmative values are rejected in Release B. */
	force_clear_inheritance?: boolean;
}

/** A state whose inheritance pointer a forced operation cleared. */
export interface ClearedInheritance {
	state_id: string;
	state_name: string;
	workflow_id: string;
	workflow_name: string;
	/** The base it pointed at, as `<workflow> / <state>`. */
	was: string;
}

export interface WorkflowResponse extends Workflow {
	/** Non-fatal advisories, e.g. a non-done state left with no way out. */
	warnings?: string[];
	/** Context items swept by a forced state removal in this update. */
	deleted_context?: DeletedContextItem[];
	/** Historical compatibility field; Release B never clears pointers. */
	cleared_inheritance?: ClearedInheritance[];
}

/** Body accepted by project/workflow DELETE; see force_delete_context above. */
export interface DeleteAnchorRequest {
	force_delete_context?: boolean;
	/** Workflow DELETE only (projects have no states): see UpdateWorkflowRequest. */
	force_clear_inheritance?: boolean;
}

/** DELETE response when a forced delete swept context items (else 204). */
export interface DeleteAnchorResponse {
	deleted_context: DeletedContextItem[];
	/** Historical compatibility field; Release B never clears pointers. */
	cleared_inheritance?: ClearedInheritance[];
}

// ---------------------------------------------------------------------------
// Issues

/** A denormalized reference to an issue, for display without another fetch. */
export interface IssueRef {
	project_name: string;
	number: number;
	title: string;
}

/**
 * Palette keys for label colors. Stored as keys, never hex: the UI maps each
 * onto a `--label-*` custom property that is defined per theme, so a chip
 * stays legible in both light and dark mode.
 */
export const LABEL_COLORS = [
	'slate',
	'red',
	'orange',
	'amber',
	'green',
	'teal',
	'blue',
	'violet',
	'pink'
] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];

/**
 * Deterministic default color for a new label, so the same name gets the
 * same chip whether it was created from the CLI, the API, or the UI.
 * djb2 over the lowercased name.
 */
export function defaultLabelColor(name: string): LabelColor {
	let hash = 5381;
	const key = name.toLowerCase();
	for (let i = 0; i < key.length; i++) hash = ((hash << 5) + hash + key.charCodeAt(i)) >>> 0;
	return LABEL_COLORS[hash % LABEL_COLORS.length];
}

/** Longest label name the API accepts, so the UI can cap its input to match. */
export const LABEL_NAME_MAX = 50;

/**
 * The order the server reads labels in (`ORDER BY name COLLATE NOCASE`):
 * SQLite's NOCASE folds ASCII A-Z only, everything else compares by code
 * unit. Any client-side sort of labels must use this, so an optimistic
 * render does not reorder itself once the server's list arrives.
 */
export function compareLabelNames(a: string, b: string): number {
	const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
	const x = fold(a);
	const y = fold(b);
	return x < y ? -1 : x > y ? 1 : 0;
}

export interface Label {
	id: string;
	name: string;
	color: LabelColor;
	description: string;
	created_at: number;
	updated_at: number;
}

/** A label in the library listing, with how many issues carry it. */
export interface LabelWithUsage extends Label {
	issue_count: number;
	/** Context items scoped to this label. */
	context_item_count: number;
	/** Routing rules scoped to this label. */
	routing_rule_count: number;
}

/** The denormalized form that rides along on every issue read. */
export type IssueLabel = Pick<Label, 'id' | 'name' | 'color'>;

export interface CreateLabelRequest {
	name: string;
	/** Defaults to `defaultLabelColor(name)`. */
	color?: LabelColor;
	description?: string;
}

export interface UpdateLabelRequest {
	name?: string;
	color?: LabelColor;
	description?: string;
}

export interface DeleteLabelRequest {
	/**
	 * Delete the context items and routing rules scoped to this label along
	 * with it. Without it, a label that scopes anything is refused (422
	 * `label_in_use`) — deleting scope silently is how a rule gets broadened.
	 */
	force?: boolean;
}

export interface DeleteLabelResponse {
	deleted: true;
	/** How many issues carried the label when it was deleted. */
	issue_count: number;
	/** Context items deleted with the label (`force` only). */
	context_items_deleted: { id: string; kind: ContextKind; name: string; scope_label: string }[];
	/** Routing rules deleted with the label (`force` only). */
	routing_rules_deleted: { id: string; scope_label: string }[];
}

export interface AddIssueLabelsRequest {
	/** Label names or ids. */
	labels: string[];
}

export interface AddIssueLabelsResponse {
	/** The issue's full label set after the add. */
	labels: IssueLabel[];
	/** Those newly attached (already-attached names are a no-op). */
	added: IssueLabel[];
	/** Those that did not exist and were created by this call. */
	created: IssueLabel[];
}

export interface Issue {
	id: string;
	project_id: string;
	project_name: string;
	/** Set (ms) while the issue's project is archived; null = live. */
	project_archived_at: number | null;
	number: number;
	title: string;
	description: string;
	workflow_id: string;
	/** The issue's own state (dormant while the issue is a duplicate). */
	state: WorkflowState;
	/**
	 * The state everything displays and filters on: the issue's own state,
	 * unless it is a duplicate — then the duplicate chain terminus's state.
	 */
	effective_state: WorkflowState;
	/** The direct canonical issue when this one is marked a duplicate. */
	duplicate_of: IssueRef | null;
	/** Blockers whose effective state is not yet done. Empty = unblocked. */
	open_blockers: IssueRef[];
	/** Labels attached to the issue, ordered by name (case-insensitive). */
	labels: IssueLabel[];
	/** Set when the issue was created by a scheduled task (null once the schedule is deleted). */
	scheduled_task_id: string | null;
	scheduled_task_name: string | null;
	/** The schedule keeps its original project when an instance moves. */
	scheduled_task_project_id: string | null;
	scheduled_task_project_name: string | null;
	/** Pin: replaces routing-rule matching entirely for this issue. */
	pinned_runner_id: string | null;
	pinned_runner_name: string | null;
	/** Tier for the pinned runner; null = the runner's default tier. */
	pinned_tier: ModelTier | null;
	/** Strikes toward the attempt limit; reset when a run advances the issue. */
	attempt_count: number;
	/** Parked after striking out; cleared by resume or a manual transition. */
	needs_attention: boolean;
	/**
	 * The transition that brought the issue into its current state. Derived for
	 * awaiting-human issues only (the handoff rows); null on every other row and
	 * after a direct workflow change, which re-stamps `state_entered_at` without
	 * emitting a transition.
	 */
	arrived_via: ArrivedVia | null;
	/**
	 * What the round that just ended produced, for awaiting-human list rows.
	 * Null on other rows; absent from reads that do not assemble it.
	 */
	round_summary?: RoundSummary | null;
	/** The run currently holding this issue's exclusive claim, if any. */
	active_run: { run_id: string; runner_name: string; status: RunStatus } | null;
	/**
	 * When the issue last entered its current state — the timestamp artifact
	 * freshness is measured against.
	 */
	state_entered_at: number;
	created_at: number;
	updated_at: number;
	/** Timestamp of the most recent event touching this issue. */
	last_activity_at: number;
}

/**
 * What the issue *list* endpoints return. Identical to `Issue` except that
 * `description` is absent under `brief=1` — description bodies dominate a list
 * payload (76% of a 50-issue page), and the callers that scan lists (agents,
 * the CLI table) only read ref/title/state.
 */
export type IssueListItem = Omit<Issue, 'description'> & { description?: string };

// ---------------------------------------------------------------------------
// Issue links (dependencies & duplicates)

export type IssueLinkKind = 'blocks' | 'duplicate_of';

/** A directed link between two issues. `blocks`: source blocks target; `duplicate_of`: source duplicates target. */
export interface IssueLink {
	id: string;
	kind: IssueLinkKind;
	source_issue_id: string;
	target_issue_id: string;
	created_at: number;
}

/** One end of a link, pre-joined for display. */
export interface LinkedIssue {
	link_id: string;
	issue_id: string;
	project_name: string;
	number: number;
	title: string;
	effective_state: WorkflowState;
}

export interface IssueLinks {
	/** Issues blocking this one. */
	blocked_by: LinkedIssue[];
	/** Issues this one blocks. */
	blocks: LinkedIssue[];
	/** The direct canonical issue (not the chain terminus) when this is a duplicate. */
	duplicate_of: LinkedIssue | null;
	/** Issues marked as duplicates of this one. */
	duplicated_by: LinkedIssue[];
}

/**
 * `blocks`: this issue blocks `issue_id`. `blocked_by`: `issue_id` blocks
 * this issue (sugar — stored as a `blocks` edge in the other direction).
 * `duplicate_of`: this issue is a duplicate of `issue_id`.
 */
export interface AddIssueLinkRequest {
	kind: IssueLinkKind | 'blocked_by';
	issue_id: string;
}

/** A legal move out of an issue's current state. */
export interface AllowedTransition {
	transition_id: string;
	/** The action name, e.g. "approve". */
	name: string;
	to_state: WorkflowState;
	/**
	 * The transition's artifact requirements with live status (present only
	 * when the transition declares any) — pre-flight visibility for the UI
	 * and the launch prompt.
	 */
	requires?: ArtifactRequirementCheck[];
}

export interface IssueDetail extends Issue {
	workflow: Workflow;
	comments: Comment[];
	/** The named transitions legally available from the current state. */
	allowed_transitions: AllowedTransition[];
	links: IssueLinks;
	/** Per-kind counts of the currently effective context, post-dedupe. */
	context_summary: ContextSummary;
	/**
	 * The issue's artifacts, only when the caller asked for them (the issue page
	 * does, so it does not fetch the same list twice). Absent from API reads.
	 */
	artifacts?: Artifact[];
	/**
	 * The runs on this issue since the human last acted, grouped by the state
	 * each started in. Only when the caller opted in; null when no run falls
	 * inside the round (a human moved the issue here directly).
	 */
	round?: Round | null;
	/**
	 * The human's steer since the previous run ended. Only when the caller opted
	 * in; null when nothing human happened after it, or there is no previous run.
	 */
	since_last_run?: SinceLastRun | null;
	/** Prompt-only metadata, emitted when launch comment selection is requested. */
	launch_comments?: { latest_completed_run_comment_id: string | null };
}

// ---------------------------------------------------------------------------
// The handoff: what came back from a round, and what the human said since

/** A transition as it appears inside the round / since-last-run derivations. */
export interface RoundTransition {
	/** Null on a forced move (`issues edit -s`): render "moved directly". */
	action: string | null;
	from_state: { id: string; name: string };
	to_state: { id: string; name: string };
	actor: Actor;
	at: number;
}

/** The transition into an issue's current state, as list rows carry it. */
export interface ArrivedVia {
	action: string | null;
	from_state_name: string | null;
	/** True when a run took it, false when a human did. */
	by_run: boolean;
	at: number;
}

/** One artifact a run touched, with the version numbers either side. */
export interface RoundArtifactChange {
	name: string;
	artifact_type: ArtifactType;
	/** Version before this run touched it; null when the run created it. */
	from_version: number | null;
	/** The last version this run attached (a reaffirmation counts). */
	to_version: number;
	/** pr artifacts: https://github.com/{owner}/{repo}/pull/{n}. */
	pr_url: string | null;
	/** folder artifacts: workspace-relative paths of `to_version`'s snapshot. */
	files: string[] | null;
}

/** One run inside a round. */
export interface RoundRun {
	run_id: string;
	runner_name: string;
	status: RunStatus;
	outcome: RunEndOutcome | null;
	started_at: number | null;
	ended_at: number | null;
	usage: AgentRunUsage | null;
	/** The transition this run took, or null (stalled / still running). */
	transition: RoundTransition | null;
	/** The run's last comment on this issue — its summary — in full. */
	summary_comment: { id: string; body: string; created_at: number } | null;
	/** Ids of the run's earlier comments, oldest first (resolve against `comments`). */
	earlier_comment_ids: string[];
	/** Artifact versions whose actor is this run, in name order. */
	artifacts: RoundArtifactChange[];
	/**
	 * For an earlier attempt at a stage: the transition that brought the issue
	 * back into this run's start state afterwards ("sent back by Automated
	 * Review"). Null on the stage's latest run.
	 */
	returned_via: RoundTransition | null;
}

/** Every run in the round that started in one state, latest first. */
export interface RoundStage {
	state: { id: string; name: string | null; position: number | null };
	/** Latest run first; `runs.slice(1)` are the earlier attempts to fold. */
	runs: RoundRun[];
}

export interface Round {
	/** The human action the round starts after; null = the issue's creation. */
	boundary: RoundTransition | null;
	boundary_at: number;
	/** In workflow position order; states no longer in the workflow sort last. */
	stages: RoundStage[];
	run_count: number;
}

export interface SinceLastRun {
	previous_run: { run_id: string; ended_at: number | null; state_at_start_name: string | null };
	/** The human-taken transition after the previous run, or null (comment only). */
	transition: RoundTransition | null;
	/** Human comments after the previous run, oldest first, at most ten (the newest ten). */
	comments: Comment[];
	/** Total human comments in the window, so a cap can be reported. */
	comment_count: number;
	/** Artifacts whose current version was fresh before the transition and is stale now. */
	stale_artifacts: string[];
}

/** Compact "what this round produced", for awaiting-human list rows. */
export interface RoundSummary {
	pr_url: string | null;
	/** Artifacts a run in this round attached or re-versioned. */
	artifacts: { name: string; artifact_type: ArtifactType; version: number }[];
}

export interface CreateIssueRequest {
	title: string;
	description?: string;
	/** Defaults to the project's default workflow, else the standard workflow. */
	workflow_id?: string;
	/**
	 * Starting state, by id or name within the chosen workflow. Defaults to
	 * the workflow's initial state.
	 */
	state?: string;
	/**
	 * Optional recurrence: creates the first issue immediately (title and
	 * description double as the templates, placeholders rendered) plus a
	 * scheduled task that takes over from there.
	 */
	schedule?: CreateScheduleInput;
	/** Label names or ids to attach on creation; unknown names are created. */
	labels?: string[];
	/** Existing issue ids that block the new issue. */
	blocked_by?: string[];
	/** Existing issue ids that the new issue blocks. */
	blocks?: string[];
	/** Existing canonical issue id that the new issue duplicates. */
	duplicate_of?: string;
}

/** One file entry in the multipart issue-create metadata manifest. */
export interface CreateIssueAttachmentManifestEntry {
	part: string;
	name: string;
	filename: string;
}

export interface CreateIssueMultipartMetadata {
	issue: CreateIssueRequest;
	attachments: CreateIssueAttachmentManifestEntry[];
}

/** The recurrence part of a create-issue request. */
export interface CreateScheduleInput {
	/** Unique within the project; defaults to the title template. */
	name?: string;
	/** Exactly one of preset or cron. */
	preset?: SchedulePreset;
	cron?: string;
	/** IANA timezone; defaults to UTC (clients send the creator's). */
	timezone?: string;
	/** Only create a new instance when all previous instances are closed. */
	require_all_closed?: boolean;
}

/** Create-issue response; `schedule` present when a recurrence was set. */
export interface CreateIssueResponse extends IssueDetail {
	schedule?: Schedule;
}

// ---------------------------------------------------------------------------
// Scheduled tasks

export interface Schedule {
	id: string;
	project_id: string;
	project_name: string;
	/** Set (ms) while the schedule's project is archived; null = live. */
	project_archived_at: number | null;
	/** Unique within the project; schedules are addressed as `<project>/<name>`. */
	name: string;
	title_template: string;
	description_template: string;
	workflow_id: string;
	workflow_name: string;
	/**
	 * Start state for created instances; null = the workflow's initial state
	 * (the schedule follows the workflow if its initial state changes).
	 */
	state_id: string | null;
	state_name: string | null;
	/** The compiled cron expression evaluation reads (always populated). */
	cron: string;
	/** The preset the cron was compiled from; null = raw cron. */
	preset: SchedulePreset | null;
	timezone: string;
	require_all_closed: boolean;
	enabled: boolean;
	next_run_at: number;
	last_run_at: number | null;
	/** Issues created by this schedule, including the initial one. */
	run_count: number;
	/** Linked issues currently in a non-done state (drives the gate). */
	open_instances: number;
	created_at: number;
	updated_at: number;
}

/**
 * Recurrence edits replace what they include: sending `preset` recompiles
 * the cron from it; sending `cron` switches the schedule to raw-cron form.
 */
export interface UpdateScheduleRequest {
	name?: string;
	title_template?: string;
	description_template?: string;
	/** Move future instances onto another workflow. Unless `state` picks one, they start in its initial state. */
	workflow_id?: string;
	/**
	 * Start state for future instances, by id or name within the schedule's
	 * (possibly just-changed) workflow. Explicit null — or the workflow's
	 * initial state — resets to "follow the workflow's initial state".
	 */
	state?: string | null;
	preset?: SchedulePreset;
	cron?: string;
	timezone?: string;
	require_all_closed?: boolean;
	/** Pause with `{ enabled: false }`; resuming recomputes the next occurrence. */
	enabled?: boolean;
}

export interface ScheduleFilters {
	/** Project id or name. */
	project?: string;
	enabled?: boolean;
	/** Without a project filter, archived projects' schedules are hidden by default. */
	archived?: ArchivedFilter;
}

export interface UpdateIssueRequest {
	title?: string;
	description?: string;
	/**
	 * Force-set the state, by id or name — bypasses the workflow's
	 * transitions (records a forced move). Resolved within `workflow_id`'s
	 * workflow when that is also being changed, else the current one.
	 */
	state?: string;
	/**
	 * Move the issue onto another workflow. Unless `state` picks one, the
	 * issue lands on the new workflow's initial state.
	 */
	workflow_id?: string;
	/**
	 * Pin the issue to one runner (replaces routing-rule matching entirely;
	 * eligibility still applies). Explicit null unpins.
	 */
	pinned_runner_id?: string | null;
	/** Tier for the pin; null = the pinned runner's default tier. */
	pinned_tier?: ModelTier | null;
}

/** Names the transition to take: exactly one of the two fields. */
export interface TransitionIssueRequest {
	/** Action name, matched case-insensitively among the allowed transitions. */
	action?: string;
	transition_id?: string;
}

export interface IssueFilters {
	project?: string;
	state?: string;
	category?: StateCategory;
	workflow?: string;
	/** Schedule id: only issues created by that scheduled task. */
	schedule?: string;
	/** Exclude issues whose state is categorized `done`. */
	hide_done?: boolean;
	/** Exclude duplicate issues. Defaults to true; false includes duplicates. */
	hide_duplicates?: boolean;
	/** Only issues that are not done, not duplicates, and have all blockers effectively done. */
	ready?: boolean;
	/** Literal title/description substring search, case-insensitive for ASCII. */
	q?: string;
	/** Label names or ids; repeated labels narrow (AND). */
	label?: string[];
	/** Omit `description` from every list item (saves tokens when scanning). */
	brief?: boolean;
	/** Without a project filter, archived projects' issues are hidden by default. */
	archived?: ArchivedFilter;
}

// ---------------------------------------------------------------------------
// Context items

export type ContextKind = 'prompt' | 'skill' | 'repo' | 'artifact' | 'env';

export const CONTEXT_KINDS: readonly ContextKind[] = ['prompt', 'skill', 'repo', 'artifact', 'env'];
export const CONTEXT_NAME_MAX_LENGTH = 100;
export const CONTEXT_DESCRIPTION_MAX_LENGTH = 1000;

/** Byte caps (UTF-8), enforced at the API layer with structured 422s. */
export const PROMPT_MAX_BYTES = 32 * 1024;
export const SKILL_MAX_FILES = 20;
export const SKILL_MAX_TOTAL_BYTES = 100 * 1024;
/** Env items: the item name is the variable name; the value is byte-capped. */
export const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
export const ENV_VALUE_MAX_BYTES = 16 * 1024;
export const ENV_HINT_MAX_CHARS = 200;
/** Names the runner owns; an env item can never shadow them. */
export const ENV_RESERVED_PREFIX = 'TINES_';
export const ENV_RESERVED_NAMES: readonly string[] = ['PATH'];

/** Skill names double as workspace directory names. */
export const SKILL_NAME_PATTERN = /^[a-z0-9-]+$/;

/** The conventional item names created by the built-in flows. */
export const AGENT_GUIDELINES_NAME = 'agent-guidelines';
export const JOURNAL_NAME = 'journal';
export const PROJECT_PROMPT_NAME = 'conventions';
export const STATE_PROMPT_NAME = 'instructions';

/**
 * The canonical starter text for the global `agent-guidelines` item. Seeded
 * once (signup, `tines context init`, or the Context-tab affordance) and
 * never overwritten — after seeding the text is entirely the user's.
 */
export const AGENT_GUIDELINES_BODY = `You are an agent working on a Tines issue over its HTTP API / CLI. Beyond doing the work, leave the workspace smarter than you found it. Four places to write, chosen by who should inherit what you learned:

- **Issue comments** — all prose about this issue: progress, findings, dead ends, questions, and instructions for whoever picks it up next. Pass the body on stdin with a quoted heredoc, so backticks, \$VARS, quotes and apostrophes reach the thread untouched by the shell (\`tines issues comment-edit <ref> <comment-id>\` and \`comment-delete\` repair your own mis-posts, but a clean first post is cheaper):

  \`\`\`
  tines issues comment <project>/<number> - <<'EOF'
  <markdown>
  EOF
  \`\`\`

  A \`tines\` too old for that form posts a literal \`-\` instead of your body, without failing. If \`tines issues comment --help\` does not mention \`@file\`, use \`tines issues comment <project>/<number> "<markdown>"\` and mind the shell quoting.

- **Issue context (artifacts)** — things this issue needs *attached*, not said: a skill, a repo/branch pin, or an override of a broader item (reuse its name): \`tines context create --kind <k> --name <n> --issue <project>/<number> …\`. Never notes — notes are comments.
- **Your journal** — shared notes for anyone doing this stage of work in this project. Append a dated bullet whenever you learn something they would want: commands that actually work, gotchas, where things live (see "Journal" at the end of this prompt for the exact commands). If an entry is wrong or stale, rewrite the journal to fix it — do not append a correction on top. Keep it short; prune when you touch it.
- **Context change requests** — never edit shared context (project-, state-, or global-scoped items) directly. Propose instead: file an issue in the project you are working in, titled \`Context change: <scope label>\`, naming the item (kind, name, scope) with the full proposed text in the description. A human reviews and applies it.

When in doubt: comment. If the lesson outlives this issue, journal it. Only file a context change when a shared rule is wrong or missing.`;

/** Description on the seeded agent-guidelines item. */
export const AGENT_GUIDELINES_DESCRIPTION =
	'How agents should use comments, artifacts, the journal, and context change requests';

/**
 * An item's scope: the intersection (AND) of its set dimensions, with the
 * referents denormalized for display and `label` in the canonical format
 * ("project Tines · state Review", issues as `<project>/<number>`). No
 * dimensions set = global (label "global"), matching every issue.
 */
export interface ContextScope {
	project_id: string | null;
	project_name: string | null;
	workflow_state_id: string | null;
	workflow_state_name: string | null;
	/** The state's workflow, for qualified display ("Standard / Review"). */
	workflow_id: string | null;
	workflow_name: string | null;
	issue_id: string | null;
	issue_ref: { project_name: string; number: number } | null;
	/**
	 * The scope's issue label, if any. Set-valued on the target side: the
	 * scope matches an issue that *carries* this label among its labels.
	 */
	label_id: string | null;
	label_name: string | null;
	label_color: LabelColor | null;
	/** The canonical display string — a scope label, not an issue label. */
	label: string;
}

export interface ContextFile {
	/** Workspace-relative path (forward slashes, no `..`, no leading `/`, no `=`). */
	path: string;
	content: string;
}

export interface ContextItem {
	id: string;
	kind: ContextKind;
	name: string;
	description: string;
	scope: ContextScope;
	/** Prompt payload: the Markdown body. */
	body?: string;
	/** Skill payload: present on detail reads; lists carry `file_count` only. */
	files?: ContextFile[];
	file_count?: number;
	/** Repo payload. `repo_dir` is as stored; null = derived from the URL. */
	repo_url?: string;
	repo_branch?: string | null;
	repo_dir?: string | null;
	/** Artifact payload summary (full detail lives on the artifact endpoints). */
	artifact_type?: ArtifactType;
	/**
	 * Env payload (all present iff `kind === 'env'`). `value` is emitted only
	 * for non-secret items; a secret is write-only and shows `value_set`
	 * plus its user-supplied `hint`.
	 */
	value?: string;
	secret?: boolean;
	value_set?: boolean;
	hint?: string | null;
	/** Ordering within the same exact scope tuple. */
	position: number;
	/** Monotonic write counter for optimistic concurrency (not history). */
	version: number;
	created_at: number;
	updated_at: number;
}

export interface CreateContextItemRequest {
	kind: ContextKind;
	name: string;
	description?: string;
	/** Scope: no dimensions set = global (applies to every issue). */
	project_id?: string | null;
	workflow_state_id?: string | null;
	issue_id?: string | null;
	label_id?: string | null;
	/** prompt */
	body?: string;
	/** skill */
	files?: ContextFile[];
	/** repo */
	repo_url?: string;
	repo_branch?: string | null;
	repo_dir?: string | null;
	/** env: the variable's value; `secret` (default false) encrypts it at rest. */
	value?: string;
	secret?: boolean;
	hint?: string | null;
}

/**
 * Merge-patch: omitted fields are unchanged; explicit null unsets a nullable
 * field (scope dimensions subject to the ≥1-dimension rule). `kind` is
 * immutable. Skill `files` replace the file set wholesale.
 */
export interface UpdateContextItemRequest {
	name?: string;
	description?: string;
	project_id?: string | null;
	workflow_state_id?: string | null;
	issue_id?: string | null;
	label_id?: string | null;
	position?: number;
	body?: string;
	files?: ContextFile[];
	repo_url?: string;
	repo_branch?: string | null;
	repo_dir?: string | null;
	/**
	 * env: `value` replaces (write-only for secrets); `secret: true` encrypts
	 * in place; `secret: false` on a secret item is a 422 (delete and recreate).
	 */
	value?: string;
	secret?: boolean;
	hint?: string | null;
	/**
	 * Compare-and-swap: reject with a 409 (carrying the current item) when
	 * the item's version no longer matches. Omit for last-write-wins.
	 */
	expected_version?: number;
}

/** `POST /api/v1/context/:id/append` — prompt items only. */
export interface AppendContextRequest {
	/** Appended to the body, separated by exactly one blank line. */
	text: string;
	expected_version?: number;
}

/**
 * List filters use "scope includes" semantics: `project=X` matches every
 * item whose scope includes project X; dimension filters AND together.
 * `exact=true` restricts to items whose scope sets only the given dimensions.
 */
export interface ContextListFilters {
	kind?: ContextKind;
	/** Project id or name. */
	project?: string;
	/** Workflow state id. */
	state?: string;
	/** Issue id. */
	issue?: string;
	/** Label id or name. */
	label?: string;
	/** Literal name/description substring search, case-insensitive for ASCII. */
	q?: string;
	exact?: boolean;
	/** Without a project filter, items scoped to archived projects are hidden by default. */
	archived?: ArchivedFilter;
}

/** Historical provenance shape; Release B effective context always sets this to null. */
export interface InheritedFrom {
	state_id: string;
	state_name: string;
	workflow_id: string;
	workflow_name: string;
}

/** One stitched-prompt part, in layer order. */
export interface EffectivePromptPart {
	item_id: string;
	name: string;
	scope: ContextScope;
	body: string;
	version: number;
	/** True for the journal item (renders under `## Journal (<scope>)`). */
	is_journal: boolean;
	/** Historical compatibility field; null for exact-state matching. */
	inherited_from: InheritedFrom | null;
}

export interface EffectiveSkill {
	item_id: string;
	name: string;
	/** Existing context-item description used as the skill's discovery cue. */
	description: string;
	scope: ContextScope;
	/** Empty when the bundle was assembled without file contents. */
	files: ContextFile[];
	file_count: number;
	version: number;
	/** Historical compatibility field; null for exact-state matching. */
	inherited_from: InheritedFrom | null;
}

export interface EffectiveRepo {
	item_id: string;
	name: string;
	scope: ContextScope;
	url: string;
	branch?: string | null;
	/** Always resolved (falls back to the URL's basename minus `.git`). */
	dir: string;
	version: number;
	/** Set when the repo matched through an ancestor of the issue's state. */
	inherited_from: InheritedFrom | null;
}

/** One effective environment variable. Secret values never travel here. */
export interface EffectiveEnv {
	item_id: string;
	name: string;
	secret: boolean;
	hint: string | null;
	/** Present for non-secret items only. */
	value?: string;
	scope: ContextScope;
	version: number;
	/** Set when the item matched through an ancestor of the issue's state. */
	inherited_from: InheritedFrom | null;
}

/** A name-collision loser: a more specific item of the same kind+name won. */
export interface OverriddenContextItem {
	item_id: string;
	kind: ContextKind;
	name: string;
	scope: ContextScope;
	overridden_by: string;
	/** Repositories only: the losing candidate's checkout details. */
	repo?: { url: string; branch?: string | null; dir: string };
	/** Set when the loser matched through an ancestor of the issue's state. */
	inherited_from: InheritedFrom | null;
}

// ---------------------------------------------------------------------------
// Issue project transfer (Tines/392)

/** One address an issue has answered to: its project and number at that time. */
export interface IssueTransferRef {
	project_id: string;
	project_name: string;
	number: number;
	/** The copyable `Project/N` form. */
	ref: string;
}

export interface IssueTransferProject {
	id: string;
	name: string;
	archived: boolean;
}

/** Why a transfer cannot be committed right now, and what to do about it. */
export interface IssueTransferBlocker {
	code: 'run_key_forbidden' | 'project_archived' | 'issue_busy' | 'transfer_preview_unavailable';
	message: string;
	/** Set for `issue_busy`: the run holding the issue. */
	run_id?: string;
	run_status?: string;
	/** A command or action that clears this blocker, when one exists. */
	remedy?: string;
}

/**
 * How one context item's participation changes across the move. `rescoped`
 * covers the project∧issue rows the commit carries with the issue; `retained`
 * an issue-only or shared row that matches on both sides unchanged.
 */
export type IssueTransferContextChangeKind =
	'added' | 'removed' | 'retained' | 'rescoped' | 'replaced';

export interface IssueTransferContextChange {
	item_id: string;
	name: string;
	kind: ContextKind;
	change: IssueTransferContextChangeKind;
	scope_before: ContextScope | null;
	scope_after: ContextScope | null;
	/** Whether the item wins its name (rather than being overridden) each side. */
	effective_before: boolean;
	effective_after: boolean;
	/** Repositories only: the checkout this item contributes, before and after. */
	repo_before?: { url: string; branch?: string | null; dir: string } | null;
	repo_after?: { url: string; branch?: string | null; dir: string } | null;
}

/** The record the move carries with the issue, unchanged. */
export interface IssueTransferPreserved {
	title: string;
	workflow_id: string;
	state_id: string;
	state_entered_at: number;
	created_at: number;
	labels: { id: string; name: string }[];
	pinned_runner_id: string | null;
	pinned_tier: ModelTier | null;
	attempt_count: number;
	parked: boolean;
	/** Snapshot counts at preview time; ordinary collaboration continues. */
	comment_count: number;
	artifact_count: number;
	artifact_version_count: number;
	run_count: number;
	link_count: number;
}

/** The moved instance's schedule, which stays with its original project. */
export interface IssueTransferSchedule {
	id: string;
	name: string;
	project_id: string;
	project_name: string;
	notice: string;
}

export interface IssueTransferPreview {
	issue_id: string;
	source: IssueTransferProject;
	destination: IssueTransferProject;
	old_ref: IssueTransferRef;
	/** Always null: a preview allocates and reserves no destination number. */
	new_ref: null;
	/** Rendered where a preview would otherwise imply a reserved number. */
	number_notice: string;
	preserved: IssueTransferPreserved;
	context: {
		before: EffectiveContext;
		after: EffectiveContext;
		changes: IssueTransferContextChange[];
	};
	/**
	 * Destination routing as the next launch would resolve it. Capacity,
	 * heartbeat and spending inside each explainer are advisory: they may change
	 * at any moment and never stale the preview.
	 */
	routing: { before: DispatchExplainer | null; after: DispatchExplainer | null };
	schedule: IssueTransferSchedule | null;
	noop: boolean;
	can_commit: boolean;
	blockers: IssueTransferBlocker[];
	/** Null whenever the transfer is blocked. Binds this exact review. */
	preview_token: string | null;
	previewed_at: number;
}

export interface IssueTransferRequest {
	project_id: string;
	preview_token: string;
}

export interface IssueTransferResult {
	status: 'transferred' | 'noop';
	issue_id: string;
	source: IssueTransferProject;
	destination: IssueTransferProject;
	/** The actual addresses: no guessed destination number appears anywhere. */
	old_ref: IssueTransferRef;
	new_ref: IssueTransferRef;
	/** The single audited move event; null for a same-project no-op. */
	event_id: string | null;
	/** Canonical browser path for the issue at its current address. */
	issue_path: string;
	/** The signed review that this commit validated. */
	preserved: IssueTransferPreserved;
	context_changes: IssueTransferContextChange[];
	routing: IssueTransferPreview['routing'];
	schedule: IssueTransferSchedule | null;
}

export interface RepoDirConflict {
	kind: 'repo_dir';
	dir: string;
	item_ids: string[];
}

/** Exact project ∧ current-state journal selected by the issue/run anchor. */
export interface EffectiveJournalTarget {
	/** The exact state whose `project ∧ state` journal is writable. */
	state_id: string;
	/** Historical compatibility field; always null in Release B. */
	inherited_from: InheritedFrom | null;
	/** The journal item at that scope, or null if none exists yet. */
	item_id: string | null;
	version: number | null;
}

/** `GET /api/v1/issues/:id/context` — the assembled bundle for an issue. */
export interface EffectiveContext {
	prompt: {
		/** The stitched prompt, `## Context: <scope>` headings included. */
		text: string;
		parts: EffectivePromptPart[];
		/** Which exact-state journal this issue's runs write. */
		journal: EffectiveJournalTarget;
	};
	skills: EffectiveSkill[];
	repos: EffectiveRepo[];
	/** Effective environment variables (names, hints, non-secret values). */
	env: EffectiveEnv[];
	overridden: OverriddenContextItem[];
	conflicts: RepoDirConflict[];
}

/** Per-kind counts of the currently effective context, post-dedupe. */
export interface ContextSummary {
	prompts: number;
	skills: number;
	repos: number;
	/** Artifacts attached to the issue (issue-scoped by construction). */
	artifacts: number;
	/** Distinct effective env variable names. */
	envs: number;
}

/** `GET /api/v1/issues/:id/prompt` — stitched context plus the issue block. */
export interface LaunchPromptResponse {
	text: string;
}

/**
 * `GET /api/v1/issues/:id/journal` — which journal this caller's `tines
 * journal` commands target. Run keys are anchored to the state their run was
 * launched in, so a lesson lands in the stage that learned it even if the
 * issue has already moved on.
 */
export interface IssueJournalResponse {
	/** The resolved project ∧ state scope (canonical "project X · state Y" label). */
	scope: ContextScope;
	/**
	 * Why this scope was chosen:
	 *  - 'run'     — the caller is the run key of a run on this issue; the scope is that run's launch state.
	 *  - 'current' — the issue's current state (session/PAT callers, another issue's run key, or a run
	 *                whose launch state no longer exists — see `note`).
	 */
	anchor: 'run' | 'current';
	/** Human-readable reason when the anchor is 'current' *despite* a run key (null otherwise). */
	note: string | null;
	/** The journal item at that scope, or null if none exists yet. */
	item: ContextItem | null;
}

/** A context item swept by a forced delete, as reported in the response. */
export interface DeletedContextItem {
	id: string;
	kind: ContextKind;
	name: string;
	scope_label: string;
}

/**
 * Default checkout directory for a repo context item: the URL's basename
 * with any trailing `.git` stripped. Handles scp-style remotes too. The
 * result must satisfy the workspace path rules an explicit repo_dir is held
 * to (no "."/".." segments, no "\" or "="), so a URL that derives an unsafe
 * basename falls back to "repo" instead of escaping the workspace.
 */
export function repoDirFromUrl(url: string): string {
	const stripped = url.replace(/[?#].*$/, '').replace(/\/+$/, '');
	const lastSlash = Math.max(stripped.lastIndexOf('/'), stripped.lastIndexOf(':'));
	const base = stripped.slice(lastSlash + 1).replace(/\.git$/, '');
	if (!base || base === '.' || base === '..' || base.includes('\\') || base.includes('='))
		return 'repo';
	return base;
}

// ---------------------------------------------------------------------------
// Issue artifacts (specs/artifacts/SPEC.md): named, typed, versioned
// attachments on issues — context items of kind `artifact`, surfaced through
// their own endpoints and deliberately excluded from the effective context.

export type ArtifactType = 'file' | 'text' | 'link' | 'pr' | 'folder';

export const ARTIFACT_TYPES: readonly ArtifactType[] = ['file', 'text', 'link', 'pr', 'folder'];

/** Per-file upload cap. */
export const ARTIFACT_FILE_MAX_BYTES = 25 * 1024 * 1024;
/** Limits for files attached as part of issue creation. */
export const ISSUE_CREATE_MAX_FILES = 10;
export const ISSUE_CREATE_FILES_MAX_BYTES = 50 * 1024 * 1024;
export const ISSUE_CREATE_METADATA_MAX_BYTES = 256 * 1024;
export const ISSUE_CREATE_MULTIPART_MAX_BYTES = 51 * 1024 * 1024;
/** Per-text-document cap (UTF-8). */
export const ARTIFACT_TEXT_MAX_BYTES = 256 * 1024;
/** Versions per artifact. */
export const ARTIFACT_MAX_VERSIONS = 50;
/** Files per folder version (one immutable snapshot). */
export const ARTIFACT_FOLDER_MAX_FILES = 200;
/** Total bytes per folder version — keeps the buffered multipart parse
 * inside Worker memory; streaming/presigned uploads are the raise trigger. */
export const ARTIFACT_FOLDER_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Artifact names are the requirement-matching key and appear in CLI
 * commands, so they follow the skill-name rule (slug-like, ≤ 100 chars).
 */
export const ARTIFACT_NAME_PATTERN = /^[a-z0-9-]+$/;

/** One file of a folder version's snapshot (metadata only, no contents). */
export interface ArtifactVersionFile {
	/** Workspace-relative path (subfolders via forward slashes). */
	path: string;
	content_type: string;
	size_bytes: number;
}

/** One immutable attached version. Contents are fetched via `…/content`. */
export interface ArtifactVersion {
	version: number;
	/** file/text: display name. */
	filename: string | null;
	/** file/text: declared MIME type. */
	content_type: string | null;
	/** file: uploaded byte count; folder: the snapshot's total bytes. */
	size_bytes: number | null;
	/** folder: number of files in the snapshot. */
	file_count: number | null;
	/** folder: the snapshot's file list — present on detail reads. */
	files?: ArtifactVersionFile[];
	/** link: the URL. */
	url: string | null;
	/** link: optional display title. */
	title: string | null;
	/** pr: canonical https://github.com/{owner}/{repo}. */
	pr_repo_url: string | null;
	/** pr: the pull request number. */
	pr_number: number | null;
	/** The version this one reaffirms, when it is a reaffirmation. */
	reaffirmed_from: number | null;
	actor: Actor;
	created_at: number;
}

/** An artifact as listed on its issue, with its current version summary. */
export interface Artifact {
	/** The underlying context item id. */
	id: string;
	name: string;
	artifact_type: ArtifactType;
	description: string;
	issue_id: string;
	version_count: number;
	current_version: ArtifactVersion;
	/** current_version.created_at ≥ the issue's state_entered_at. */
	fresh: boolean;
	created_at: number;
	updated_at: number;
}

/** Detail read: the artifact plus its full version list (metadata only). */
export interface ArtifactDetail extends Artifact {
	versions: ArtifactVersion[];
}

/**
 * `POST /api/v1/issues/:id/artifacts/:name/site-link` — a short-lived signed
 * URL that renders an HTML artifact (see specs/artifacts/SPEC.md "Sites").
 */
export interface ArtifactSiteLink {
	/** Absolute `/s/<token>/` URL: the iframe src and the "open full page" href. */
	url: string;
	/** The version the link is pinned to. */
	version: number;
	/** Epoch ms after which the link 403s. */
	expires_at: number;
	/**
	 * `sandbox-origin`: served from a cross-site host, so storage APIs work.
	 * `same-origin`: served from the app origin under CSP `sandbox` (opaque
	 * origin — `localStorage` throws). Local dev, e2e and previews are the latter.
	 */
	mode: 'sandbox-origin' | 'same-origin';
}

export interface ArtifactListResponse {
	items: Artifact[];
}

/**
 * `PUT /api/v1/issues/:id/artifacts/:name` — JSON upsert for text/link/pr:
 * creates the artifact (body declares `type`) or appends a version to it.
 * A body with no payload fields is a metadata-only update (no new version).
 * File uploads go through the raw-body `…/:name/file` endpoint instead.
 */
export interface UpsertArtifactRequest {
	/** Required when creating; must match the existing type otherwise. */
	type?: ArtifactType;
	description?: string;
	/** text: the inline document (Markdown by default). */
	content?: string;
	/** text: display filename (defaults to `<name>.md`). */
	filename?: string;
	/** text: declared MIME (defaults to text/markdown). */
	content_type?: string;
	/** link: the URL (http/https only). */
	url?: string;
	/** link: optional display title. */
	title?: string;
	/** pr: a full PR URL (`https://github.com/{o}/{r}/pull/123`) — or set the split fields. */
	pr_url?: string;
	/** pr: canonical repository URL (paired with pr_number). */
	pr_repo_url?: string;
	pr_number?: number;
}

/** A declared requirement on a workflow transition. */
export interface ArtifactRequirement {
	/** The slot name a matching artifact must carry (slug). */
	artifact: string;
	/** When set, must equal the artifact's type. */
	type?: ArtifactType;
	/**
	 * When set, prefix-matches the current version's declared content type
	 * ("image/" matches any image). Only meaningful with type file or text.
	 */
	content_type?: string;
	/** Human/agent-facing: shown in editors, the launch prompt, and errors. */
	description?: string;
}

export type ArtifactRequirementStatus = 'satisfied' | 'missing' | 'type_mismatch' | 'stale';

/** A requirement with its live status against a specific issue. */
export interface ArtifactRequirementCheck extends ArtifactRequirement {
	status: ArtifactRequirementStatus;
	/** The matching artifact's current version, when one exists. */
	current_version: { version: number; created_at: number } | null;
	/** The matching artifact's (immutable) type, when one exists. */
	current_type: ArtifactType | null;
	/**
	 * The runnable command that clears this requirement (`requirementFix`) —
	 * present on every entry, satisfied or not, so the launch prompt, the
	 * issue read and the 422 all quote the same string. Always exactly one
	 * command: copy-pastable whole.
	 */
	fix: string;
	/**
	 * A second command that also clears it, when one exists — today only a
	 * `stale` requirement's `reaffirm`, whose alternative to re-attaching is
	 * "the current content still stands". Additive: every consumer that reads
	 * `fix` alone stays correct (Tines/274).
	 */
	fix_alternative?: string;
}

/** A pull-request reference parsed from user input. */
export interface PrRef {
	/** Canonical https://github.com/{owner}/{repo}. */
	repo_url: string;
	number: number;
}

/**
 * Canonicalizes a GitHub repository URL to `https://github.com/{owner}/{repo}`
 * — no `.git` suffix, no trailing slash. Accepts the shapes `git clone`
 * tolerates (https with `.git`, `git@github.com:owner/repo.git`,
 * `ssh://git@github.com/owner/repo`). Null = not a GitHub repository URL.
 */
export function canonicalGitHubRepoUrl(url: string): string | null {
	const match = url
		.trim()
		.match(
			/^(?:(?:https?|ssh):\/\/(?:[^@/]+@)?|git@)?(?:www\.)?github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/
		);
	if (!match) return null;
	return `https://github.com/${match[1]}/${match[2]}`;
}

/**
 * Parses a PR reference: `owner/repo#123` or a full GitHub PR URL
 * (`https://github.com/owner/repo/pull/123`). Null when neither shape fits.
 */
export function parsePrSpec(spec: string): PrRef | null {
	const short = spec.trim().match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/);
	if (short) {
		const repoUrl = canonicalGitHubRepoUrl(`https://github.com/${short[1]}`);
		return repoUrl ? { repo_url: repoUrl, number: Number.parseInt(short[2], 10) } : null;
	}
	const url = spec.trim().match(/^(.*?)\/pull\/(\d+)(?:[/?#].*)?$/);
	if (!url) return null;
	const repoUrl = canonicalGitHubRepoUrl(url[1]);
	return repoUrl ? { repo_url: repoUrl, number: Number.parseInt(url[2], 10) } : null;
}

// ---------------------------------------------------------------------------
// Supervisor: runners, routing rules, settings

export type RunnerType = 'claude_managed' | 'gemini_managed' | 'local';

export const RUNNER_TYPES: readonly RunnerType[] = ['claude_managed', 'gemini_managed', 'local'];

export type RunnerStatus = 'active' | 'paused';

export type RunnerConcurrencyMode = 'legacy' | 'local' | 'remote';
export type RunnerConcurrencyUnavailableReason =
	| 'legacy'
	| 'opted_out'
	| 'awaiting_policy'
	| 'unsupported_protocol'
	| 'invalid_protocol'
	| 'offline';

export interface RunnerConcurrencyControl {
	status: 'applied' | 'pending' | 'unavailable';
	reason: RunnerConcurrencyUnavailableReason | null;
	requested_cap: number | null;
	ceiling: number | null;
	revision: number;
	applied_cap: number | null;
	applied_revision: number | null;
	applied_at: number | null;
}

/**
 * The routing vocabulary for how hard to think. A closed set: adding a tier
 * is a code change, so routing rules can rely on it staying small.
 */
export type ModelTier = 'smartest' | 'balanced' | 'cheapest';

export const MODEL_TIERS: readonly ModelTier[] = ['smartest', 'balanced', 'cheapest'];

export type RunStatus =
	'assigned' | 'launching' | 'running' | 'completed' | 'failed' | 'timed_out' | 'canceled';

export const RUN_STATUSES: readonly RunStatus[] = [
	'assigned',
	'launching',
	'running',
	'completed',
	'failed',
	'timed_out',
	'canceled'
];

/**
 * How the supervisor judged a run's end, orthogonal to its status: an
 * `advanced` run moved its issue (attempt count resets), a `stalled` one did
 * not (a strike), and an `interrupted` one never got the chance because the
 * pipe died — runner offline, daemon restarted or shut down — so the issue is
 * charged nothing and the pressure lands on the runner instead.
 *
 * Deliberately not a `RunStatus`: `agent_run.status` carries a SQL CHECK
 * constraint, and an interruption is still, honestly, a failed run.
 */
export type RunEndOutcome = 'advanced' | 'stalled' | 'interrupted';

export const RUN_END_OUTCOMES: readonly RunEndOutcome[] = ['advanced', 'stalled', 'interrupted'];

/** Statuses that hold the issue's exclusive claim (and count toward caps). */
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['assigned', 'launching', 'running'];

/**
 * Runner names are CLI addresses (routing rules and `--name` carry them), so
 * they are constrained to a shell- and URL-safe shape. Shared so the Add
 * runner dialog validates against the exact regex the server enforces.
 */
export const RUNNER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Local-runner liveness: online = last poll within this window. */
export const RUNNER_ONLINE_WINDOW_MS = 2 * 60 * 1000;

export const DEFAULT_RESUME_WINDOW_HOURS = 48;
export const DEFAULT_RESUME_MAX_TURNS = 25;
export const DEFAULT_RESUME_MAX_TOKENS = 100_000;
export const DEFAULT_RESUME_MAX_COST_USD = 2;

/** A local runner unseen this long has its running runs failed by the sweep. */
export const RUNNER_OFFLINE_FAIL_MS = 5 * 60 * 1000;

/**
 * An `assigned` run unacknowledged, or a `launching` run with no recorded
 * provider session, for this long fails at launch (never a strike).
 */
export const LAUNCH_STALL_MS = 5 * 60 * 1000;

/** Run-key expiry slack beyond `max_run_minutes`. */
export const RUN_KEY_SLACK_MS = 10 * 60 * 1000;

/**
 * Run log tail cap: the D1 `agent_run.log` column keeps at most this many
 * bytes, truncated from the head. Bytes evicted from the tail are not lost —
 * they spill to the run-log bucket (see apps/web/src/lib/server/run-log.ts)
 * and the full log is served by `GET /api/v1/runs/:id/log`.
 */
export const RUN_LOG_MAX_BYTES = 256 * 1024;

/**
 * How long a run's spilled full-log objects survive past the run's end.
 * The sweep deletes them after this; the D1 tail is kept forever, so run
 * history reads exactly as it did before full logs existed.
 */
export const RUN_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Cap on the raw harness stream a daemon may upload per run. The daemon
 * keeps the trailing bytes with a truncation marker; the server rejects
 * anything larger.
 */
export const RUN_LOG_RAW_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Managed runners are created with this per-run cost cap (editable,
 * removable) so the budget-overshoot bound is real out of the box.
 */
export const DEFAULT_MANAGED_RUN_COST_USD = 5;

/**
 * A per-tier model override: an exact model id plus optional settings.
 * Unlisted tiers fall back to the built-ins (and silently improve as those
 * move); an overridden tier stays frozen until touched.
 */
export interface RunnerTierOverride {
	model: string;
	/** Provider-specific reasoning effort (Claude managed agents). */
	effort?: string;
}

export type RunnerTierOverrides = Partial<Record<ModelTier, RunnerTierOverride>>;

/**
 * Per-runner money limits. The per-run caps ship with the managed runners
 * (mapped to provider-native ceilings — Claude's session budget); the daily
 * limits are stored now but enforced by the daily-budget milestone.
 */
export interface RunnerBudget {
	daily_usd?: number;
	daily_tokens?: number;
	/** Hard per-attempt dollar ceiling (platform-enforced for Claude). */
	max_run_cost_usd?: number;
	/** Hard per-attempt token ceiling (input + output; cache reads excluded). */
	max_run_tokens?: number;
}

/**
 * Known predecessors of each current built-in tier model, newest first —
 * the stale-override marker's data: an override pointing at a predecessor
 * of its tier's current built-in is stale (informational only, never
 * auto-migrated).
 */
export const MODEL_PREDECESSORS: Record<string, readonly string[]> = {
	'claude-fable-5-1': [
		'claude-fable-5',
		'claude-opus-5',
		'claude-opus-4-8',
		'claude-opus-4-7',
		'claude-opus-4-6'
	],
	'claude-fable-5': ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6'],
	'claude-opus-5': [
		'claude-opus-4-8',
		'claude-opus-4-7',
		'claude-opus-4-6',
		'claude-opus-4-5',
		'claude-opus-4-1'
	],
	'claude-sonnet-5': ['claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-3-7-sonnet-latest'],
	'claude-haiku-4-5': ['claude-3-5-haiku-latest'],
	'gemini-2.5-pro': ['gemini-1.5-pro'],
	'gemini-2.5-flash': ['gemini-2.0-flash', 'gemini-1.5-flash'],
	'gemini-2.5-flash-lite': ['gemini-2.0-flash-lite', 'gemini-1.5-flash-8b'],
	'gpt-6-astra': ['gpt-5-codex'],
	'gpt-5.6-sol': ['gpt-5-codex'],
	'gpt-5.6-luna': ['gpt-5-codex']
};

/** True when a tier override points at a model older than its tier's current built-in. */
export function isStaleTierOverride(
	builtinModel: string | null | undefined,
	overrideModel: string | null | undefined
): boolean {
	if (!builtinModel || !overrideModel || builtinModel === overrideModel) return false;
	return (MODEL_PREDECESSORS[builtinModel] ?? []).includes(overrideModel);
}

/** At most `limit` runs in launching/running across everything. */
export interface GlobalCapQuota {
	type: 'global_cap';
	limit: number;
}

/**
 * At most N concurrent runs per workflow state — counted by the state a run
 * started in (`state_id_at_start`) — with a fallback default and per-state
 * overrides keyed by state id.
 */
export interface StateRosterQuota {
	type: 'state_roster';
	default_limit: number;
	overrides: Record<string, number>;
}

/** One user-chosen policy governs the total picture; new types are additive. */
export type QuotaPolicy = GlobalCapQuota | StateRosterQuota;

export interface SupervisorSettings {
	/** The kill switch: nothing dispatches while off. Off for new users. */
	enabled: boolean;
	quota: QuotaPolicy;
	/** Strikes before an issue parks (`needs_attention`). */
	attempt_limit: number;
	/**
	 * Display hint for the stored GitHub PAT ("github_pat_…cdef"); null when
	 * none is stored. The PAT itself is write-only — never returned.
	 */
	github_pat_hint: string | null;
	/** Null until the settings row has been written at least once. */
	updated_at: number | null;
}

/** PUT is a merge: omitted fields keep their current values. */
export interface UpdateSupervisorSettingsRequest {
	enabled?: boolean;
	quota?: QuotaPolicy;
	attempt_limit?: number;
	/**
	 * Only with `enabled: false`: also cancel the in-flight (launching/running)
	 * runs, as plain individual cancels — strikes and all. Not-yet-acknowledged
	 * `assigned` runs are always canceled by the switch turning off.
	 */
	cancel_in_flight?: boolean;
	/**
	 * Replace the stored GitHub PAT (fine-grained, scoped to exactly the
	 * repos context items point at — that scope is the blast radius of a
	 * compromised run). Write-only: reads return only `github_pat_hint`.
	 * `null` clears it.
	 */
	github_pat?: string | null;
}

/** `PUT /supervisor/settings` response; `canceled_runs` reports the switch-off sweep. */
export interface SupervisorSettingsResponse extends SupervisorSettings {
	/** Runs canceled by this write (kill switch off / bulk cancel), when any. */
	canceled_runs?: number;
}

/**
 * Per-user UI preferences. Never read by agents: `/api/v1/preferences` is
 * control-plane fenced, GET included. See specs/projects/SPEC.md "Project focus".
 */
export interface UserPreferences {
	/**
	 * The focused project, or null for "All projects". Raw: it may still name a
	 * project that has since been archived, until a page load resolves it.
	 */
	focused_project_id: string | null;
	/** The project New issue falls back to under "All projects": last focused or last created-in. */
	last_project_id: string | null;
	/** Null until the preferences row has been written at least once. */
	updated_at: number | null;
}

/** Merge-patch: an absent field is unchanged, an explicit null clears it. */
export interface UpdatePreferencesRequest {
	focused_project_id?: string | null;
	last_project_id?: string | null;
}

/** A registered executor. Secrets are never serialized. */
export interface Runner {
	id: string;
	type: RunnerType;
	/** Unique per user — routing rules and the CLI address runners by name. */
	name: string;
	status: RunnerStatus;
	/** The runner's own concurrency cap; always enforced. */
	max_concurrent: number;
	/** Local runners only: durable requested cap and daemon acknowledgement state. */
	concurrency_control: RunnerConcurrencyControl | null;
	max_run_minutes: number;
	/** Experimental continuation policy; disabled by default. */
	resume_enabled: boolean;
	resume_window_hours: number;
	resume_max_turns: number;
	resume_max_tokens: number;
	resume_max_cost_usd: number;
	default_tier: ModelTier;
	/** Per-tier model overrides; null = all built-ins. */
	tiers: RunnerTierOverrides | null;
	/**
	 * The built-in tier→model table for this runner's type (and harness), so
	 * clients can render resolution and the stale-override marker without
	 * duplicating the table. Null = tiers don't apply (custom harness).
	 */
	tier_models: Record<ModelTier, string> | null;
	/** Per-runner money limits; null = none. */
	budget: RunnerBudget | null;
	/** Managed types: whether a provider API key is stored (write-only). */
	has_api_key: boolean;
	/** Non-secret config (harness, hostname…). */
	config: Record<string, unknown>;
	/**
	 * Managed runners are always online; a local runner is online while its
	 * daemon has polled within the last 2 minutes.
	 */
	online: boolean;
	last_seen_at: number | null;
	/** Last capability assertion from this daemon boot; null means a legacy daemon. */
	effort_capabilities: EffortCapabilities | null;
	/** Exact-model effort choices projected by the server; null means unknown/unsupported. */
	effort_models: Record<string, string[]> | null;
	/**
	 * Local runners: the daemon is finishing its in-flight runs and will exit
	 * for its service manager to relaunch a newer version. Nothing new is
	 * dispatched to it until the relaunched daemon polls.
	 */
	draining: boolean;
	launch_failures: number;
	backoff_until: number | null;
	/**
	 * Why `backoff_until` is set: 'rate_limit' = the runner's harness account hit
	 * a usage limit and the hold ends at the reported reset; null = the ordinary
	 * consecutive-failure backoff counted by `launch_failures`.
	 */
	backoff_reason: 'rate_limit' | null;
	/** Runs currently holding a claim on this runner (assigned/launching/running). */
	active_runs: number;
	created_at: number;
	updated_at: number;
}

export interface CreateRunnerRequest {
	/** 'local' or 'claude_managed' ('gemini_managed' arrives in a later milestone). */
	type: RunnerType;
	name: string;
	/**
	 * Managed types: the provider API key, required at create. Validated with
	 * a ping before anything is stored; write-only (encrypted) after.
	 */
	api_key?: string;
	max_concurrent?: number;
	max_run_minutes?: number;
	resume_enabled?: boolean;
	resume_window_hours?: number;
	resume_max_turns?: number;
	resume_max_tokens?: number;
	resume_max_cost_usd?: number;
	default_tier?: ModelTier;
	tiers?: RunnerTierOverrides;
	/**
	 * Managed runners default to `{ max_run_cost_usd: 5 }` when omitted; send
	 * `{}` to create one uncapped (the setup flow shows and edits this).
	 */
	budget?: RunnerBudget;
	/** Local runners: { harness?: 'claude_code' | 'codex' | 'custom', … }. */
	config?: Record<string, unknown>;
}

export interface UpdateRunnerRequest {
	name?: string;
	/** Pause with 'paused'; resume with 'active'. */
	status?: RunnerStatus;
	/** Managed types: replace the provider API key (ping-validated first). */
	api_key?: string;
	max_concurrent?: number;
	/** Required when changing a remotely controlled local runner cap. */
	expected_concurrency_revision?: number;
	max_run_minutes?: number;
	resume_enabled?: boolean;
	resume_window_hours?: number;
	resume_max_turns?: number;
	resume_max_tokens?: number;
	resume_max_cost_usd?: number;
	default_tier?: ModelTier;
	/** Replaces the override map wholesale; null clears all overrides. */
	tiers?: RunnerTierOverrides | null;
	/** Replaces the budget wholesale; null clears it. */
	budget?: RunnerBudget | null;
	config?: Record<string, unknown>;
}

/**
 * DELETE body. Removal is refused (422 naming them) while the runner has
 * active runs or is referenced by any routing-rule target or issue pin;
 * `force` strips rule targets and clears pins instead (active runs always
 * block). A rule the cascade empties is flagged, not deleted.
 */
export interface DeleteRunnerRequest {
	force?: boolean;
}

// ---------------------------------------------------------------------------
// Local runner protocol (SPEC.md "Local runner protocol")

/**
 * `POST /api/v1/runners/register` — user API key auth. Creates a local
 * runner, or reconnects an existing one by name (re-minting its token, the
 * daemon-lost-its-config path). The response's token is shown exactly once.
 */
export interface RegisterRunnerRequest {
	name: string;
	harness?: 'claude_code' | 'codex' | 'custom';
	/** Custom harness only: the command template. */
	command?: string;
	max_concurrent?: number;
	max_run_minutes?: number;
	default_tier?: ModelTier;
	/** Device display info, shown on the runner card. */
	hostname?: string;
	platform?: string;
}

/** Register and rotate-token both hand the token over exactly once. */
export interface RunnerTokenResponse {
	runner: Runner;
	/** The plaintext runner token; only its hash is stored. */
	runner_token: string;
}

/** `POST /api/v1/runners/:id/poll` — runner-token auth. */
export interface RunnerPollRequest {
	/** Stable for one daemon boot. Absent only for legacy clients. */
	instance_id?: string;
	/** Run ids the daemon is actually executing right now. */
	owned_runs: string[];
	/**
	 * The daemon's `--max-concurrent`. When present the server adopts it as
	 * the runner's cap, so restarting the daemon with a new flag value takes
	 * effect without re-registering.
	 */
	max_concurrent?: number;
	/** Locally asserted, machine-owned remote concurrency boundary. */
	concurrency_control?: {
		version: 1;
		allow_remote: boolean;
		ceiling: number;
		applied?: { revision: number; cap: number };
	};
	/** Assignments refused before process launch and awaiting server release. */
	declined_assignments?: string[];
	/**
	 * True while the daemon is finishing its runs before exiting for a
	 * self-update restart: the dispatcher assigns it nothing new, while runs
	 * it already claimed are still delivered. Absent or false clears it, so
	 * the relaunched daemon's first poll reopens the runner.
	 */
	draining?: boolean;
	/** V1 exact-model effort support discovered by this daemon boot. */
	effort_capabilities?: EffortCapabilities;
	/**
	 * Capability: this daemon merges `RunnerAssignment.env` into the harness
	 * environment. Absent → the server delivers no env and logs a warning.
	 */
	env_delivery?: 1;
}

/** One delivered assignment: everything the daemon needs to launch. */
export interface RunnerAssignment {
	run: AgentRun;
	/** Enforced launch setting, omitted for provider-default and legacy-tier delivery. */
	effort?: {
		version: 1;
		value: string;
		source: import('./effort.js').EffortSource;
		/** Capability catalog the server checked immediately before delivery. */
		capability_digest: string;
	};
	/** Supervisor preamble + stitched context + issue block, assembled at delivery. */
	prompt: string;
	/**
	 * The effective-context bundle (the `tines issues context --json` shape);
	 * the daemon writes it out in the `--out` workspace layout.
	 */
	bundle: EffectiveContext;
	/** The ephemeral run key — the harness's TINES_API_KEY. Never logged. */
	run_key: string;
	/**
	 * Resolved env context items for the harness process environment. Sent
	 * only to daemons that polled with `env_delivery: 1`; never inside
	 * `bundle`, never written to the workspace. Secret values are masked
	 * from the run log by the daemon.
	 */
	env?: RunnerAssignmentEnv[];
	/** Minutes until the daemon must kill the harness. */
	timeout_minutes: number;
	/**
	 * Present only when this run continues the previous run's conversation:
	 * the daemon skips workspace materialization and cloning, launches the
	 * harness in `workspace_path`, and resumes `provider_session_id`. The
	 * prompt above is then the reduced continuation message, not a full
	 * launch prompt. Absent = launch fresh exactly as before.
	 */
	resume?: RunnerAssignmentResume;
}

export interface RunnerAssignmentEnv {
	name: string;
	value: string;
	secret: boolean;
}

/** The continuation instructions delivered with a resumed assignment. */
export interface RunnerAssignmentResume {
	/** The run whose conversation this one continues. */
	previous_run_id: string;
	/** The harness session to reopen (`claude -p --resume <id>`). */
	provider_session_id: string;
	/** The predecessor's workspace, kept on disk for exactly this. */
	workspace_path: string;
	/**
	 * Turns already in that conversation, so the daemon can report the
	 * accumulated count and the next resume decision sees the real size.
	 */
	prior_turn_count: number;
}

export interface RunnerPollResponse {
	assignments: RunnerAssignment[];
	concurrency_control?: {
		version: 1;
		available: boolean;
		revision: number;
		cap: number;
		ceiling: number | null;
		reason?: RunnerConcurrencyUnavailableReason;
	};
	/** Declines now terminal or absent and safe to forget locally. */
	released_assignments?: string[];
	/**
	 * Run ids to kill WITHOUT finish-reporting: the supervisor has already
	 * settled these (cancel, timeout, the offline sweep).
	 */
	cancels: string[];
}

/** `POST /api/v1/runs/:id/logs` — runner-token auth; appended to the tail. */
export interface AppendRunLogRequest {
	chunk: string;
	/** Local launch milestone; accepted only for this run's resolved effort. */
	effort_application?: {
		status: 'accepted_unconfirmed' | 'rejected';
		attempted_effort: string;
		transport: 'argv';
		reason?: string;
	};
	/**
	 * Per-run, 1-based, monotonic chunk number assigned by the daemon. A
	 * chunk whose seq the server has already applied is a retry of a send
	 * whose response was lost, and is ignored — appends are exactly-once.
	 * Optional: older daemons and the managed-run sweep send none.
	 */
	seq?: number;
}

export interface AppendRunLogResponse {
	/** Post-append status (the first append flips `launching` → `running`). */
	status: RunStatus;
	log_bytes_dropped: number;
	/** Highest chunk seq the server has applied (0 when the client sends none). */
	log_seq: number;
}

/** `POST /api/v1/runs/:id/finish` — runner-token auth. */
export interface FinishRunRequest {
	status: 'completed' | 'failed';
	error?: string;
	/** Last local launch milestone, repeated so a fast finish can recover a lost log request. */
	effort_application?: AppendRunLogRequest['effort_application'];
	/**
	 * `interrupted` = the daemon died, restarted, or was shut down around the
	 * run; the work did not fail, so the issue must not take a strike. Only
	 * honoured with `status: 'failed'`; absent — as from any daemon predating
	 * the field — is judged exactly as before.
	 *
	 * `rate_limited` = the harness's provider refused the work because its usage
	 * limit was reached. The run is judged like an interruption (no strike), and
	 * the runner is held until `resume_at`.
	 */
	judgment?: 'interrupted' | 'rate_limited';
	/**
	 * `rate_limited` only: when the harness's provider said the usage window
	 * resets, epoch ms. Absent = unknown; the server applies a default hold.
	 */
	resume_at?: number;
	/** Opaque resumable session/thread id reported by the local harness. */
	provider_session_id?: string;
	/**
	 * Assistant turns in THIS run, and in the whole conversation the harness
	 * ran (they differ only for a resumed run, where the conversation carries
	 * its predecessors' turns). The conversation count is what the resume
	 * size guard reads.
	 */
	turn_count?: number;
	conversation_turn_count?: number;
	/**
	 * Absolute path of the workspace the run used. Recorded so a later run on
	 * the same runner can be continued in it; only meaningful together with
	 * `provider_session_id`.
	 */
	workspace_path?: string;
	/** Whatever the harness reported (Claude Code JSON output, etc.). */
	usage?: AgentRunUsage;
	/** Codex invocation and JSONL measurement evidence; rates remain server-owned. */
	pricing_evidence?: CodexPricingEvidenceV1;
}

/** One entry of a rule's ordered preference list, as stored/sent. */
export interface RoutingTarget {
	/** `'*'` is reserved for a singleton scoped tier-only rule. */
	runner_id: string;
	/** Null/absent = the runner's default tier. */
	tier?: ModelTier | null;
	/** Explicit routing override; absent inherits the selected runner tier. */
	effort?: string;
}

/** A target with its runner denormalized for display. */
export interface RoutingRuleTarget {
	runner_id: string;
	runner_name: string;
	/** Null for the `'*'` inherited-runner sentinel. */
	runner_status: RunnerStatus | null;
	tier: ModelTier | null;
	effort?: string;
}

/**
 * A routing rule: at most one per exact scope (any combination of label,
 * project and state, or global). The most specific matching rule wins
 * outright — label beats project beats state, so `label` > `project ∧ state`
 * — with no fallback across rules. Two rules of equal specificity (only
 * reachable between two label rules, since an issue carries a *set* of
 * labels) tie, and a tie dispatches nowhere. `scope.issue_id` is always null
 * (pins cover per-issue).
 */
export interface RoutingRule {
	id: string;
	scope: ContextScope;
	/** Ordered preference list. Empty = flagged "no targets" (a force-delete cascade emptied it). */
	targets: RoutingRuleTarget[];
	created_at: number;
	updated_at: number;
}

/** An authoring-time note that another rule shadows (or is shadowed by) this one. */
export interface ShadowWarning {
	/**
	 * `shadowed` — the named rule is more specific and wins for issues both
	 * match; `shadows` — this rule wins over the named one; `ambiguous` — the
	 * two tie, so an issue matching both dispatches to neither until one is
	 * made more specific. Only labels can produce a tie (an issue carries a
	 * set of them), so `ambiguous` never appears for project/state scopes.
	 */
	kind: 'shadowed' | 'shadows' | 'ambiguous';
	rule_id: string;
	scope_label: string;
	message: string;
}

/** Create/update responses carry shadow hints so the interaction surfaces when the rule is written. */
export interface RoutingRuleWithWarnings extends RoutingRule {
	warnings: ShadowWarning[];
}

export interface CreateRoutingRuleRequest {
	project_id?: string | null;
	workflow_state_id?: string | null;
	label_id?: string | null;
	targets: RoutingTarget[];
}

export interface UpdateRoutingRuleRequest {
	/** Scope is merge-patched: omitted = unchanged, explicit null = unset. */
	project_id?: string | null;
	workflow_state_id?: string | null;
	label_id?: string | null;
	targets?: RoutingTarget[];
}

// ---------------------------------------------------------------------------
// Agent runs

export interface CodexRawUsageV1 {
	input_tokens?: number;
	cached_input_tokens?: number;
	cache_write_input_tokens?: number;
	output_tokens?: number;
}

export type CodexRequestContextV1 = {
	version: 1;
	normalization: 'codex-rollout-delta-v1';
	harness_version?: string;
} & (
	| {
			status: 'complete';
			/** A supported Codex CLI version; see `isSupportedCodexRolloutVersion`. */
			harness_version: string;
			request_count: number;
			max_request_input_tokens: number;
			reconciled_usage: Required<CodexRawUsageV1>;
	  }
	| {
			status: 'unavailable' | 'unsupported' | 'invalid';
			reason:
				| 'not_applicable'
				| 'thread_id_missing'
				| 'rollout_missing'
				| 'rollout_ambiguous'
				| 'unsafe_path'
				| 'read_failed'
				| 'limit_exceeded'
				| 'unsupported_version'
				| 'metadata_mismatch'
				| 'malformed'
				| 'missing_dimension'
				| 'nonmonotonic'
				| 'delta_mismatch'
				| 'terminal_mismatch'
				| 'model_mismatch';
	  }
);

/** Bounded producer evidence for the Codex JSONL accounting contract. */
export interface CodexPricingEvidenceV1 {
	version: 1;
	harness: 'codex';
	model: string | null;
	identity_source: 'launch_argument';
	usage_scope: 'thread_total';
	session_mode: 'cold' | 'resumed';
	normalization: 'codex-jsonl-v1';
	raw_usage?: CodexRawUsageV1;
	model_rerouted: boolean;
	measurement_status:
		'complete' | 'missing' | 'invalid' | 'nonmonotonic' | 'incomplete_attempt' | 'multiple_threads';
	terminal_snapshots: number;
	daemon_version?: string;
	request_context?: CodexRequestContextV1;
}

export type RunPricingReason =
	| 'pricing_evidence_missing'
	| 'invalid_pricing_evidence'
	| 'model_missing'
	| 'model_mismatch'
	| 'model_rerouted'
	| 'unsupported_model'
	| 'missing_rate'
	| 'missing_token_dimension'
	| 'invalid_token_dimension'
	| 'long_context_band_unknown'
	| 'request_context_invalid'
	| 'long_context_rate_unsupported'
	| 'attempt_scope_unknown'
	| 'incomplete_attempt'
	| 'nonmonotonic_usage'
	| 'multiple_threads'
	| 'cost_out_of_range';

export interface RunPricingBasisV1 {
	calculation_version: 'tokens-times-usd-per-million-v1';
	provider: 'openai';
	model: string;
	model_identity: 'requested_launch_no_observed_reroute';
	usage_scope: 'attempt';
	plan: 'api_standard';
	context_band: 'short' | 'published';
	rate_id: string;
	rate_version: number;
	rate_adopted_at: number;
	rate_valid_to: number | null;
	rate_selected_at: number;
	source_url: string;
	source_checked_at: string;
	source_effective_at: string | null;
	unit_tokens: 1000000;
	rates: Record<
		'input_tokens' | 'cache_read_tokens' | 'cache_write_tokens' | 'output_tokens',
		string | null
	>;
	cost_usd_exact: string;
}

export type RunPricingV1 = {
	version: 1;
	evidence?: CodexPricingEvidenceV1;
	evaluated_at: number;
} & (
	| { status: 'calculated'; basis: RunPricingBasisV1 }
	| { status: 'unpriced'; reason: RunPricingReason }
	| { status: 'provider_authoritative' }
);

/** Per-run usage record; fields land as providers report them. */
export interface AgentRunUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_tokens?: number;
	cache_write_tokens?: number;
	cost_usd?: number;
	cost_source?: 'provider' | 'priced' | 'none';
	/** Server-owned immutable pricing decision and its reproducing evidence. */
	pricing?: RunPricingV1;
}

/** One attempt at one issue by one runner. */
export interface AgentRun {
	id: string;
	issue_id: string;
	/** Denormalized for display; null when the issue is gone. */
	issue_ref: IssueRef | null;
	runner_id: string;
	runner_name: string;
	status: RunStatus;
	/**
	 * How the supervisor judged the end. `advanced` = the agent transitioned
	 * the issue; `stalled` = it did not, and the issue took a strike;
	 * `interrupted` = the pipe died (runner offline, daemon restart or
	 * shutdown), so nothing was charged to the issue. Null while the run is
	 * active, for runs that never started, and for pre-0016 rows.
	 */
	outcome: RunEndOutcome | null;
	tier: ModelTier;
	/** Resolved at launch; null when the harness cannot vary its model. */
	model: string | null;
	/** Routed request before runner-tier fallback; immutable after claim. */
	requested_effort: string | null;
	/** Final configured intent, not proof of provider application. */
	resolved_effort: string | null;
	effort_source: EffortSource | null;
	effort_application_status: EffortApplicationStatus;
	effort_application_evidence: Record<string, unknown> | null;
	usage: AgentRunUsage | null;
	/** Resolved ledger dimensions, populated only for finalized period evidence. */
	usage_dimensions?: import('./usage.js').UsageDimensions;
	/** Accounting classification, populated only for finalized period evidence. */
	usage_accounting?: import('./usage.js').UsageEvidenceAccounting;
	state_id_at_start: string;
	state_at_start_name: string | null;
	state_id_at_end: string | null;
	state_at_end_name: string | null;
	provider_session_id: string | null;
	provider_url: string | null;
	turn_count: number | null;
	conversation_turn_count: number | null;
	resumed_from_run_id: string | null;
	resume_expires_at: number | null;
	resume_fallback_reason:
		| 'expired'
		| 'long_context'
		| 'incompatible'
		| 'unavailable'
		| 'unsupported'
		| 'provider_rejected'
		| null;
	error: string | null;
	created_at: number;
	started_at: number | null;
	ended_at: number | null;
}

/** Historical as-of evidence for a run that had not ended at the reporting cutoff. */
export interface UsagePendingRun {
	id: string;
	issue_id: string;
	issue_ref: IssueRef | null;
	runner_id: string;
	runner_name: string;
	tier: ModelTier;
	state_id_at_start: string;
	state_at_start_name: string | null;
	created_at: number;
	pending_at: number;
	usage_dimensions: Omit<import('./usage.js').UsageDimensions, 'outcome'>;
	accounting_status: 'pending';
}

/** Detail read: adds the captured log tail. */
export interface AgentRunDetail extends AgentRun {
	log: string;
	/** Bytes truncated from the head of the log when it hit the cap. */
	log_bytes_dropped: number;
	/**
	 * Size of the complete log (`log_bytes_dropped` + the tail's byte
	 * length) — what `GET /api/v1/runs/:id/log` serves. Deliberately a
	 * number and not the log itself: this payload is polled every 3s.
	 */
	log_full_bytes: number;
	/** Size of the raw harness stream, retrievable with `?raw=1`; 0 = none. */
	log_raw_bytes: number;
	/** Set once retention GC removed the full log; only the tail remains. */
	log_expired: boolean;
}

export interface RunFilters {
	/** Issue id. */
	issue?: string;
	/** Runner id. */
	runner?: string;
	/** Workflow state id captured when the run started. */
	state?: string;
	/** Only runs holding a claim (assigned/launching/running). */
	active?: boolean;
	/** Usage evidence population; requires from/to. */
	population?: 'finalized' | 'pending';
	/** Inclusive finalized end bound, ISO UTC/offset timestamp. */
	from?: string;
	/** Exclusive cutoff, ISO UTC/offset timestamp. */
	to?: string;
	project?: string;
	workflow?: string;
	tier?: string;
	outcome?: RunEndOutcome | 'unknown';
	accounting_status?: 'priced' | 'unpriced' | 'unreported';
	/** Period evidence display provenance; must be supplied as a pair. */
	timezone?: string;
	timezone_source?: 'supervisor_budget' | 'utc_fallback';
}

/**
 * Compact age of a timestamp, in the style of run durations: "42s", "5m",
 * "3h", "2d". Shared so the launch prompt and the CLI spell an age the same
 * way; the CLI's ISO-string form delegates here.
 */
export function ageLabel(at: number, now: number = Date.now()): string {
	if (!Number.isFinite(at)) return '—';
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
	return `${Math.floor(seconds / 86_400)}d`;
}

/** A pr version's canonical pull-request URL, or null when it is not a pr. */
export function prUrlOf(v: Pick<ArtifactVersion, 'pr_repo_url' | 'pr_number'>): string | null {
	return v.pr_repo_url && v.pr_number !== null ? `${v.pr_repo_url}/pull/${v.pr_number}` : null;
}

/** Compact duration for run rows: "42s", "12m"; "—" before launch. */
export function runDurationLabel(
	run: Pick<AgentRun, 'started_at' | 'ended_at'>,
	now: number = Date.now()
): string {
	if (!run.started_at) return '—';
	const seconds = Math.max(0, Math.round(((run.ended_at ?? now) - run.started_at) / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}

/** Run cost for a row: dollars where known, tokens where only they are, honest markers otherwise. */
export function runCostLabel(run: Pick<AgentRun, 'usage'>): string | null {
	const usage = run.usage;
	if (!usage) return null;
	if (usage.cost_usd !== undefined) {
		const dollars =
			usage.cost_usd === 0
				? '$0'
				: usage.cost_usd < 0.01
					? '<$0.01'
					: `$${usage.cost_usd.toFixed(2)}`;
		const source =
			usage.cost_source === 'provider'
				? 'Reported'
				: usage.cost_source === 'priced'
					? 'Estimated'
					: 'Recorded';
		return `${dollars} ${source}`;
	}
	if (usage.pricing?.status === 'unpriced') return 'Unpriced';
	if (usage.cost_source === 'none') return 'Unreported';
	const measured = [
		usage.input_tokens,
		usage.output_tokens,
		usage.cache_read_tokens,
		usage.cache_write_tokens
	].some((value) => value !== undefined);
	const tokens =
		(usage.input_tokens ?? 0) +
		(usage.output_tokens ?? 0) +
		(usage.cache_read_tokens ?? 0) +
		(usage.cache_write_tokens ?? 0);
	return tokens > 0 ? `${tokens.toLocaleString()} tok` : measured ? 'Unpriced' : null;
}

/** Whether a run still holds its issue's exclusive claim (and counts toward caps). */
export function isActiveRun(status: RunStatus): boolean {
	return ACTIVE_RUN_STATUSES.includes(status);
}

/**
 * Ids of every active-category state across the given workflows — the only
 * states the supervisor dispatches from, so the only ones a routing rule can
 * usefully be scoped to.
 */
export function activeStateIds(workflows: Pick<Workflow, 'states'>[]): Set<string> {
	return new Set(
		workflows.flatMap((w) => w.states.filter((s) => s.category === 'active').map((s) => s.id))
	);
}

/**
 * Utilization against the active quota policy, from the active runs — the
 * Agents tab's Runs header and `tines supervisor status` render this
 * identically. Roster states with an override always show; others only
 * while occupied.
 */
export function utilizationLabel(
	quota: QuotaPolicy,
	activeRuns: Pick<AgentRun, 'state_id_at_start' | 'state_at_start_name'>[],
	stateName: (id: string) => string = (id) => id
): string {
	if (quota.type === 'global_cap') {
		return `${activeRuns.length}/${quota.limit} global slot${quota.limit === 1 ? '' : 's'} in use`;
	}
	const counts = new Map<string, { name: string; n: number }>();
	for (const run of activeRuns) {
		const entry = counts.get(run.state_id_at_start) ?? {
			name: run.state_at_start_name ?? stateName(run.state_id_at_start),
			n: 0
		};
		entry.n += 1;
		counts.set(run.state_id_at_start, entry);
	}
	for (const stateId of Object.keys(quota.overrides)) {
		if (!counts.has(stateId)) counts.set(stateId, { name: stateName(stateId), n: 0 });
	}
	if (counts.size === 0) return `no active runs (roster default ${quota.default_limit} per state)`;
	return [...counts.entries()]
		.map(
			([stateId, { name, n }]) => `${name} ${n}/${quota.overrides[stateId] ?? quota.default_limit}`
		)
		.join(' · ');
}

// ---------------------------------------------------------------------------
// Dispatch explainer

/**
 * A remedy for a failing check: a place to click and/or a command to run.
 * Purely presentational — an action never affects `eligible`.
 */
export interface DispatchCheckAction {
	label: string;
	/** App-relative path. The web renders it as a link; the CLI has no origin, so text mode ignores it. */
	href?: string;
	/** A ready-to-paste CLI command. */
	cli?: string;
}

/** One eligibility check, pass or fail, with a human-readable detail. */
export interface DispatchCheck {
	name:
		| 'automation_enabled'
		| 'project_archived'
		| 'state_active'
		| 'ready'
		| 'no_active_run'
		| 'not_parked'
		| 'routed';
	ok: boolean;
	detail: string;
	/** Present only on checks with something to fix. Optional so published CLIs keep parsing. */
	action?: DispatchCheckAction;
}

export type DispatchTargetVerdict =
	| 'ok'
	| 'paused'
	| 'offline'
	| 'draining'
	| 'at_capacity'
	| 'backing_off'
	| 'rate_limited'
	| 'quota_exhausted'
	| 'effort_incompatible';

/** One rule/pin target's verdict, in preference order. */
export interface DispatchTarget {
	runner_id: string;
	runner_name: string;
	/** The tier the entry resolves to and the model it would launch. */
	tier: ModelTier;
	model: string | null;
	verdict: DispatchTargetVerdict;
	detail: string;
}

/** `GET /api/v1/issues/:id/dispatch` — "why isn't this running?". */
export interface DispatchExplainer {
	/** All checks pass (rule/pin match included) — dispatchable. */
	eligible: boolean;
	checks: DispatchCheck[];
	/** The pin, when set (replaces rule matching entirely). */
	pin: { runner_id: string; runner_name: string | null; tier: ModelTier | null } | null;
	/** The winning rule; null when pinned, nothing matches, or two rules tie. */
	matched_rule: { rule_id: string; scope_label: string } | null;
	/** Concrete runner source when `matched_rule` is a tier-only rule. */
	runner_rule?: { rule_id: string; scope_label: string } | null;
	/** Tier applied to all inherited runner targets. */
	tier_override?: ModelTier | null;
	/**
	 * The rules that tied, when two label rules match an issue at equal
	 * specificity: the issue does not dispatch until one is made more
	 * specific. Empty in every other case.
	 */
	ambiguous_rules: { rule_id: string; scope_label: string }[];
	/** Per-target verdicts, in preference order. */
	targets: DispatchTarget[];
	parked: boolean;
	attempt_count: number;
	attempt_limit: number;
	active_run: AgentRun | null;
	/**
	 * Eligible-but-waiting only: how many eligible, routed issues are ahead in
	 * the oldest-`updated_at`-first queue.
	 */
	queue_position: number | null;
	/** The one-line human verdict the UI and CLI render. */
	verdict: string;
}

// ---------------------------------------------------------------------------
// Fleet queue: the Now row — every eligible issue with no active run, grouped
// by why it is waiting (Tines/256).

/**
 * Why an eligible issue is waiting. The target verdicts, plus the routing and
 * eligibility failures a per-runner verdict cannot express (an issue with no
 * matching rule has no target to carry a verdict at all).
 */
export type QueueVerdict =
	| DispatchTargetVerdict
	| 'no_rule'
	| 'ambiguous_rule'
	| 'no_targets'
	| 'pin_missing'
	| 'automation_off'
	| 'parked';

/** Which limit is binding, for the capacity and quota verdicts; null for the rest. */
export type QueueBinding =
	| {
			kind: 'max_concurrent';
			runner_id: string;
			runner_name: string;
			current: number;
			limit: number;
	  }
	| { kind: 'global_cap'; current: number; limit: number }
	| { kind: 'state_roster'; state_id: string; current: number; limit: number; overridden: boolean };

export interface QueueIssueRef {
	id: string;
	project_name: string;
	number: number;
	title: string;
	/** `COALESCE(state_entered_at, created_at)` — the wait clock. */
	entered_at: number;
	/** Position in the dispatch queue, matching the explainer; null when unrouted or parked. */
	queue_position: number | null;
}

/** One `{state, verdict, runner}` bucket of the Now row. */
export interface QueueGroup {
	state_id: string;
	state_name: string;
	workflow_id: string;
	workflow_name: string;
	verdict: QueueVerdict;
	/** The speaking target's verdict detail, or the routing failure sentence. */
	detail: string;
	runner_id: string | null;
	runner_name: string | null;
	/** The matched rule, for the "no targets" remedy and rule-row annotations. */
	rule_id: string | null;
	/** The tied rules, for `ambiguous_rule`; empty otherwise. */
	ambiguous_rule_ids: string[];
	binding: QueueBinding | null;
	count: number;
	oldest_entered_at: number;
	/** Refs in dispatch order, capped at `QUEUE_GROUP_REF_LIMIT`; `count` is authoritative. */
	issues: QueueIssueRef[];
}

/** How many issue refs a group carries; the count is always the full size. */
export const QUEUE_GROUP_REF_LIMIT = 10;

/** `GET /api/v1/supervisor/queue` — the fleet's waiting work. */
export interface FleetQueue {
	generated_at: number;
	project: { id: string; name: string } | null;
	automation_enabled: boolean;
	quota: QuotaPolicy;
	/** Sorted count desc, then oldest first. */
	groups: QueueGroup[];
	/** Sum of the group counts; excludes parked and awaiting-human. */
	waiting: number;
	parked: { count: number; oldest_entered_at: number | null; issues: QueueIssueRef[] };
	/** Human stages get a summary line only — no table (Tines/256 scope). */
	awaiting_human: { count: number; oldest_entered_at: number | null };
}

// ---------------------------------------------------------------------------
// Stage stats — the flow board's "This week" row (Tines/257)

/**
 * How a run ended, for the stage table's outcome mix. `RunEndOutcome` plus the
 * two buckets the column needs that the stored outcome cannot express: a run
 * that never started (a launch failure — nothing to judge) and a row that
 * ended before migration 0016 added the column.
 */
export type RunOutcomeBucket = RunEndOutcome | 'failed' | 'unrecorded';

export const RUN_OUTCOME_BUCKETS: readonly RunOutcomeBucket[] = [
	...RUN_END_OUTCOMES,
	'failed',
	'unrecorded'
];

/** A duration distribution in ms; `n` is how many samples it was measured over. */
export interface DurationStats {
	p50: number;
	p90: number;
	total: number;
	n: number;
}

/** One stage's figures over one window. All durations are ms. */
export interface StageWindowFigures {
	since: number;
	until: number;
	/** Entries into the state inside the window. */
	visits: number;
	/** Exits from the state inside the window; not the same population as `visits`. */
	exits: number;
	/** Entry → first started run. Null when nothing was measurable. */
	queue_wait: DurationStats | null;
	queue_wait_measured: number;
	/** Visits still waiting for their first run — excluded from the percentiles. */
	waiting_now: number;
	/** Closed visits that never saw a started run. */
	never_started: number;
	/** First started run → exit, closed visits only. */
	work: DurationStats | null;
	work_measured: number;
	open_now: number;
	runs: {
		total: number;
		/** Runs bound to visits ÷ all entered visits; null when there are no entered visits. */
		per_visit: number | null;
		active: number;
		/** Runs that could not be bound to a visit in the scan (see `bindRuns`). */
		unbound: number;
		/** `unrecorded` rows judged `advanced` from the run key's own transition. */
		recovered_advanced: number;
		outcomes: Record<RunOutcomeBucket, number>;
		top_runner: { id: string; name: string; runs: number } | null;
	};
	sent_back: {
		count: number;
		/** Of exits; null when there were none. */
		share: number | null;
		agent: number;
		human: number;
		by_target: {
			state_id: string;
			state_name: string;
			count: number;
			agent: number;
			human: number;
		}[];
	};
	received_back: number;
	/** Reserved for the spend column (Tines/199); always null here. */
	cost: null;
}

/** Current − previous per figure; null when either side is unmeasured. */
export interface StageStatsDelta {
	visits: number | null;
	exits: number | null;
	queue_wait_p50: number | null;
	queue_wait_p90: number | null;
	work_p50: number | null;
	work_p90: number | null;
	runs_per_visit: number | null;
	sent_back_share: number | null;
	outcomes: Record<RunOutcomeBucket, number | null>;
}

export interface StageStats {
	state_id: string;
	state_name: string;
	workflow_id: string;
	workflow_name: string;
	current: StageWindowFigures;
	previous: StageWindowFigures | null;
	delta: StageStatsDelta;
}

export interface MarkerFigures {
	visits: number;
	exits: number;
	sent_back_share: number | null;
	queue_wait_p50: number | null;
}

export interface ChangeMarker {
	id: string;
	at: number;
	kind: 'prompt' | 'quota' | 'automation' | 'runner_cap' | 'rule';
	label: string;
	event_ids: string[];
	state_ids: string[];
	effects: { state_id: string; before: MarkerFigures | null; after: MarkerFigures | null }[];
}

/** `GET /api/v1/supervisor/stats` — per-stage flow over a rolling window. */
export interface StageStatsReport {
	generated_at: number;
	window: { ms: number; since: number; until: number };
	previous: { since: number; until: number } | null;
	project: { id: string; name: string } | null;
	/**
	 * The oldest recorded run outcome. Deltas whose previous window starts
	 * before this are blanked rather than reported as a fall to zero.
	 */
	outcome_recorded_since: number | null;
	/** Active states that saw work in either window, ordered by total queue wait desc. */
	states: StageStats[];
	/** Newest prompt, quota, cap and routing edits inside the current window. */
	markers: ChangeMarker[];
}

/** Query for `GET /api/v1/supervisor/stats`. */
export interface StatsQuery {
	/** `<n>h` or `<n>d`, 1h–90d; default `7d`. */
	window?: string;
	/** `previous` (default) computes the prior window and the deltas. */
	compare?: 'previous' | 'none';
	/** Project id or name; narrows both board rows. */
	project?: string;
}

/** Evidence behind one stage's sent-back figure. */
export interface SentBackDrilldown {
	state: { id: string; name: string; workflow_id: string; workflow_name: string };
	window: { since: number; until: number };
	prompt: { context_id: string; name: string; current_version: number; edit_url: string } | null;
	items: {
		issue: { id: string; project_name: string; number: number; title: string };
		transitioned_at: number;
		to_state_id: string;
		to_state_name: string;
		action: string | null;
		actor: Actor;
		comment: { id: string; excerpt: string; created_at: number } | null;
		prompt_version: number | null;
		prompt_context_id: string | null;
	}[];
}

// ---------------------------------------------------------------------------
// Comments

export interface Comment {
	id: string;
	issue_id: string;
	body: string;
	actor: Actor;
	created_at: number;
	/** Null when the comment has never been edited. */
	updated_at: number | null;
}

export interface CreateCommentRequest {
	body: string;
}

export interface UpdateCommentRequest {
	body: string;
}

// ---------------------------------------------------------------------------
// Events

/**
 * Every event type this build knows how to render, in emission order.
 *
 * The array is the source of truth rather than the union: it gives the
 * renderer in `events.ts` a closed set to be exhaustive over (a missing
 * describer is a compile error) and the tests a list to iterate.
 */
export const EVENT_TYPES = [
	'issue.created',
	'issue.updated',
	'issue.transferred',
	'issue.transitioned',
	'issue.commented',
	'issue.comment_edited',
	'issue.comment_deleted',
	'issue.link_added',
	'issue.link_removed',
	'issue.labeled',
	'issue.unlabeled',
	'label.created',
	'label.updated',
	'label.deleted',
	'project.created',
	'project.updated',
	'project.deleted',
	'project.archived',
	'project.unarchived',
	'workflow.created',
	'workflow.updated',
	'workflow.deleted',
	'api_key.created',
	'api_key.revoked',
	'scheduled_task.created',
	'scheduled_task.updated',
	'scheduled_task.deleted',
	'scheduled_task.skipped',
	'context.created',
	'context.updated',
	'context.deleted',
	'runner.registered',
	'runner.updated',
	'runner.daemon_replaced',
	'runner.removed',
	'runner.errored',
	'runner.rate_limited',
	'routing_rule.created',
	'routing_rule.updated',
	'routing_rule.deleted',
	'settings.updated',
	'agent_run.started',
	'agent_run.ended',
	'issue.parked',
	'issue.resumed'
] as const;

/** An event type this build knows about — closed, so `Record` keys can be checked. */
export type KnownEventType = (typeof EVENT_TYPES)[number];

// Open-ended by design: later phases add types without migration, and an
// older client reading a newer server's feed must still accept them.
export type EventType = KnownEventType | (string & {});

export interface TinesEvent {
	id: string;
	type: EventType;
	actor: Actor;
	issue_id: string | null;
	project_id: string | null;
	/** Denormalized for display; null when the referent is gone or absent. */
	issue_ref: { project_name: string; number: number; title: string } | null;
	project_name: string | null;
	payload: Record<string, unknown>;
	created_at: number;
}

export interface EventFilters {
	/** Issue id. */
	issue?: string;
	/** Project id. */
	project?: string;
	/** One event type or a comma-separated list. */
	type?: string;
	/** Inclusive lower time bound, epoch ms or ISO 8601. */
	since?: number | string;
	/** Exclusive upper time bound, epoch ms or ISO 8601. */
	until?: number | string;
	/** Workflow state id referenced by an event payload. */
	state?: string;
}

// ---------------------------------------------------------------------------
// API keys

export interface ApiKey {
	id: string;
	name: string;
	/** First characters of the secret, for display ("tines_ab12cd34…"). */
	key_prefix: string;
	created_at: number;
	last_used_at: number | null;
	revoked_at: number | null;
	/**
	 * Set on *run keys*: the agent run this key was minted for, resolved to the
	 * runner and the run's issue. Absent on user-created keys.
	 */
	run?: ActorRun | null;
}

/** Which run keys a listing includes alongside the user's own keys. */
export type RunKeyFilter = 'none' | 'active' | 'all';

export const RUN_KEY_FILTERS: readonly RunKeyFilter[] = ['none', 'active', 'all'];

/** How many run keys a user has, split by whether they can still act. */
export interface RunKeyCounts {
	active: number;
	revoked: number;
}

export interface ApiKeyCreated extends ApiKey {
	/** The full secret. Shown once; never retrievable again. */
	key: string;
}

export interface CreateApiKeyRequest {
	name: string;
}

// ---------------------------------------------------------------------------
// Envelopes

export interface ListResponse<T> {
	items: T[];
	/** Pass back as `?cursor=` to fetch the next page; null = no more. */
	next_cursor: string | null;
	/** Present on stable period-run evidence pages. */
	usage_window?: {
		from: number;
		to: number;
		timezone: string;
		population: 'finalized' | 'pending';
		timezone_source: 'supervisor_budget' | 'utc_fallback';
		cursor_version: 'usage-runs-v2';
		scan_complete: boolean;
		accounting_basis: 'finalized_by_ended_at_v1';
		attribution_basis: 'current_issue_project_start_state_workflow_v1';
	};
}

export interface PageParams {
	cursor?: string;
	limit?: number;
}

/**
 * Structured error body. `code` is stable and machine-readable; `details`
 * carries recovery data (e.g. `allowed_transitions` on an illegal move) so
 * agents can recover from a 422 without human help.
 */
export interface ApiErrorBody {
	error: {
		code: string;
		message: string;
		details?: Record<string, unknown>;
	};
}

// ---------------------------------------------------------------------------
// Library export / import: the portable form of a deployment's reusable
// library — non-system workflows plus every non-issue-scoped context item.
// Deliberately excludes tracker data (issues, comments, events, runs,
// schedules, artifacts) and every credential.

/** Discriminator on the exported document; guards against feeding in a stray JSON file. */
export const LIBRARY_FORMAT = 'tines.library';
/**
 * Bumped when the document shape changes incompatibly; import refuses anything
 * higher. Version history:
 *
 * - **1** — projects, workflows (states, transitions, artifact requirements)
 *   and context items, all referenced by name.
 * - **2** — historical documents may carry `inherits_from` (Tines/270) as a
 *   qualified state reference. Inspection and download preserve this shape;
 *   Release B mutation/import paths reject non-null pointers.
 */
export const LIBRARY_VERSION = 2;

/** Document-level caps, checked before the entries are walked. */
export const LIBRARY_MAX_BYTES = 5 * 1024 * 1024;
export const LIBRARY_MAX_ENTRIES = 1000;

/**
 * A context item's scope by name rather than by id, so a document imports
 * into a deployment that shares none of the source's ids. `{}` is global;
 * a state ref is workflow-qualified because state names are unique only
 * within their workflow.
 */
export interface LibraryScopeRef {
	project?: string;
	state?: { workflow: string; name: string };
	/** Issue label by name; created on import when this deployment lacks it. */
	label?: string;
}

/** A project carried only as a scope referent — no issues come with it. */
export interface LibraryProject {
	name: string;
	description?: string;
	/**
	 * Default workflow by name, restored on import when a workflow of that name
	 * exists here or arrives in the same document; otherwise skipped, with the
	 * reason recorded on the project's plan entry.
	 */
	default_workflow?: string | null;
}

/**
 * A context item in portable form: its `CreateContextItemRequest` payload
 * with the three scope ids replaced by {@link LibraryScopeRef}.
 */
export interface LibraryContextEntry {
	kind: ContextKind;
	name: string;
	description?: string;
	scope: LibraryScopeRef;
	/** True for the project ∧ state prompt named `journal` (deployment memory). */
	journal?: boolean;
	/** prompt */
	body?: string;
	/** skill */
	files?: ContextFile[];
	/** repo */
	repo_url?: string;
	repo_branch?: string | null;
	repo_dir?: string | null;
}

/**
 * Historical pointer-bearing documents remain valid for inspection/download,
 * but Release B mutation/import requires a pointer-free document before
 * applying it to a deployment.
 *
 * The system `Standard` workflow is never exported (it is seeded with
 * identical ids on every instance); items scoped to its states are retained
 * for historical inspection and re-resolve by name.
 */
export interface LibraryDocument {
	format: typeof LIBRARY_FORMAT;
	version: number;
	exported_at: number;
	projects: LibraryProject[];
	workflows: CreateWorkflowRequest[];
	context: LibraryContextEntry[];
}

export interface ExportLibraryOptions {
	/** v3 is the default; v2 is available for older importers. */
	version?: 2 | 3;
	/** Journals are deployment-specific memory; opt out to leave them behind. */
	journals?: boolean;
}

export interface ImportLibraryRequest {
	document: LibraryDocument | import('./library/types.js').LibraryV3Document;
	/** Explicit destination choice keyed by document-local workflow ID (v3 only). */
	workflow_targets?: Record<
		string,
		{ kind: 'target'; workflow_id: string } | { kind: 'create'; name: string }
	>;
	/** Plan only: returns exactly the plan an apply would follow. */
	dry_run?: boolean;
	/** Context items only; workflow definition conflicts always refuse. */
	on_collision?: 'skip' | 'overwrite';
	/** Create projects the document scopes to but this deployment lacks (default true). */
	create_projects?: boolean;
	/** Import journal items (default true). */
	include_journals?: boolean;
}

export type ImportAction = 'create' | 'skip' | 'overwrite' | 'refuse' | 'error';

export const IMPORT_ACTIONS: readonly ImportAction[] = [
	'create',
	'skip',
	'overwrite',
	'refuse',
	'error'
];

export interface ImportPlanEntry {
	section: 'project' | 'workflow' | 'context' | 'label';
	/** Stable source identity for v3 reports. */
	local_id?: string;
	target_id?: string;
	/** Resolved destination name, present for successful v3 workflow plans and receipts. */
	target_name?: string;
	/** Human-readable identity, e.g. `prompt "instructions" (state Engineering / Research)`. */
	ref: string;
	action: ImportAction;
	/** Why, for every action but `create`. */
	reason?: string;
}

export interface ImportLibraryResponse {
	/** False for a dry run: nothing was written. */
	applied: boolean;
	entries: ImportPlanEntry[];
	counts: Record<ImportAction, number>;
}
