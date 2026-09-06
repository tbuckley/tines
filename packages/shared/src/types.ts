/** Wire types for the Tines phase-one API (`/api/v1/*`). All snake_case. */

import type { SchedulePreset } from './schedule.js';

export type StateCategory = 'backlog' | 'active' | 'awaiting_human' | 'done';

export const STATE_CATEGORIES: readonly StateCategory[] = [
	'backlog',
	'active',
	'awaiting_human',
	'done'
];

/**
 * A run-key actor's provenance: resolved through the run to the runner, for
 * "via <runner> · run on <issue>" rendering.
 */
export interface ActorRun {
	run_id: string;
	runner_name: string;
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
	/** Set when the key is a run key: attribution goes to the runner + run. */
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
 * "alice via laptop-key", or — for run keys — "alice via laptop-m4 · run on
 * demo/12".
 */
export function actorLabel(actor: Actor): string {
	if (actor.run) {
		return `${actor.user_name} via ${actor.run.runner_name} · ${runRefLabel(actor.run)}`;
	}
	return actor.api_key_name ? `${actor.user_name} via ${actor.api_key_name}` : actor.user_name;
}

// ---------------------------------------------------------------------------
// Projects

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
	 */
	initial_prompt?: string;
}

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
}

export interface WorkflowResponse extends Workflow {
	/** Non-fatal advisories, e.g. a non-done state left with no way out. */
	warnings?: string[];
	/** Context items swept by a forced state removal in this update. */
	deleted_context?: DeletedContextItem[];
}

/** Body accepted by project/workflow DELETE; see force_delete_context above. */
export interface DeleteAnchorRequest {
	force_delete_context?: boolean;
}

/** DELETE response when a forced delete swept context items (else 204). */
export interface DeleteAnchorResponse {
	deleted_context: DeletedContextItem[];
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
	/** Pin: replaces routing-rule matching entirely for this issue. */
	pinned_runner_id: string | null;
	pinned_runner_name: string | null;
	/** Tier for the pinned runner; null = the runner's default tier. */
	pinned_tier: ModelTier | null;
	/** Strikes toward the attempt limit; reset when a run advances the issue. */
	attempt_count: number;
	/** Parked after striking out; cleared by resume or a manual transition. */
	needs_attention: boolean;
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
	/** Only issues that are not done, not duplicates, and have all blockers effectively done. */
	ready?: boolean;
	/** Title/description substring search. */
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

export type ContextKind = 'prompt' | 'skill' | 'repo' | 'artifact';

export const CONTEXT_KINDS: readonly ContextKind[] = ['prompt', 'skill', 'repo', 'artifact'];

/** Byte caps (UTF-8), enforced at the API layer with structured 422s. */
export const PROMPT_MAX_BYTES = 32 * 1024;
export const SKILL_MAX_FILES = 20;
export const SKILL_MAX_TOTAL_BYTES = 100 * 1024;

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
	/** Name/description search. */
	q?: string;
	exact?: boolean;
	/** Without a project filter, items scoped to archived projects are hidden by default. */
	archived?: ArchivedFilter;
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
}

export interface EffectiveSkill {
	item_id: string;
	name: string;
	scope: ContextScope;
	/** Empty when the bundle was assembled without file contents. */
	files: ContextFile[];
	file_count: number;
	version: number;
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
}

/** A name-collision loser: a more specific item of the same kind+name won. */
export interface OverriddenContextItem {
	item_id: string;
	kind: ContextKind;
	name: string;
	scope: ContextScope;
	overridden_by: string;
}

export interface RepoDirConflict {
	kind: 'repo_dir';
	dir: string;
	item_ids: string[];
}

/** `GET /api/v1/issues/:id/context` — the assembled bundle for an issue. */
export interface EffectiveContext {
	prompt: {
		/** The stitched prompt, `## Context: <scope>` headings included. */
		text: string;
		parts: EffectivePromptPart[];
	};
	skills: EffectiveSkill[];
	repos: EffectiveRepo[];
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
	 * issue read and the 422 all quote the same string.
	 */
	fix: string;
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

/** Local-runner liveness: online = last poll within this window. */
export const RUNNER_ONLINE_WINDOW_MS = 2 * 60 * 1000;

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
	'gemini-2.5-flash-lite': ['gemini-2.0-flash-lite', 'gemini-1.5-flash-8b']
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

/** A registered executor. Secrets are never serialized. */
export interface Runner {
	id: string;
	type: RunnerType;
	/** Unique per user — routing rules and the CLI address runners by name. */
	name: string;
	status: RunnerStatus;
	/** The runner's own concurrency cap; always enforced. */
	max_concurrent: number;
	max_run_minutes: number;
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
	/**
	 * Local runners: the daemon is finishing its in-flight runs and will exit
	 * for its service manager to relaunch a newer version. Nothing new is
	 * dispatched to it until the relaunched daemon polls.
	 */
	draining: boolean;
	launch_failures: number;
	backoff_until: number | null;
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
	max_run_minutes?: number;
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
	/** Run ids the daemon is actually executing right now. */
	owned_runs: string[];
	/**
	 * The daemon's `--max-concurrent`. When present the server adopts it as
	 * the runner's cap, so restarting the daemon with a new flag value takes
	 * effect without re-registering.
	 */
	max_concurrent?: number;
	/**
	 * True while the daemon is finishing its runs before exiting for a
	 * self-update restart: the dispatcher assigns it nothing new, while runs
	 * it already claimed are still delivered. Absent or false clears it, so
	 * the relaunched daemon's first poll reopens the runner.
	 */
	draining?: boolean;
}

/** One delivered assignment: everything the daemon needs to launch. */
export interface RunnerAssignment {
	run: AgentRun;
	/** Supervisor preamble + stitched context + issue block, assembled at delivery. */
	prompt: string;
	/**
	 * The effective-context bundle (the `tines issues context --json` shape);
	 * the daemon writes it out in the `--out` workspace layout.
	 */
	bundle: EffectiveContext;
	/** The ephemeral run key — the harness's TINES_API_KEY. Never logged. */
	run_key: string;
	/** Minutes until the daemon must kill the harness. */
	timeout_minutes: number;
}

export interface RunnerPollResponse {
	assignments: RunnerAssignment[];
	/**
	 * Run ids to kill WITHOUT finish-reporting: the supervisor has already
	 * settled these (cancel, timeout, the offline sweep).
	 */
	cancels: string[];
}

/** `POST /api/v1/runs/:id/logs` — runner-token auth; appended to the tail. */
export interface AppendRunLogRequest {
	chunk: string;
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
	/**
	 * `interrupted` = the daemon died, restarted, or was shut down around the
	 * run; the work did not fail, so the issue must not take a strike. Only
	 * honoured with `status: 'failed'`; absent — as from any daemon predating
	 * the field — is judged exactly as before.
	 */
	judgment?: 'interrupted';
	/** Whatever the harness reported (Claude Code JSON output, etc.). */
	usage?: AgentRunUsage;
}

/** One entry of a rule's ordered preference list, as stored/sent. */
export interface RoutingTarget {
	runner_id: string;
	/** Null/absent = the runner's default tier. */
	tier?: ModelTier | null;
}

/** A target with its runner denormalized for display. */
export interface RoutingRuleTarget {
	runner_id: string;
	runner_name: string;
	runner_status: RunnerStatus;
	tier: ModelTier | null;
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

/** Per-run usage record; fields land as providers report them. */
export interface AgentRunUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_tokens?: number;
	cache_write_tokens?: number;
	cost_usd?: number;
	cost_source?: 'provider' | 'priced' | 'none';
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
	usage: AgentRunUsage | null;
	state_id_at_start: string;
	state_at_start_name: string | null;
	state_id_at_end: string | null;
	state_at_end_name: string | null;
	provider_session_id: string | null;
	provider_url: string | null;
	error: string | null;
	created_at: number;
	started_at: number | null;
	ended_at: number | null;
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
	/** Only runs holding a claim (assigned/launching/running). */
	active?: boolean;
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
	if (usage.cost_usd !== undefined) return `$${usage.cost_usd.toFixed(2)}`;
	if (usage.cost_source === 'none') return 'unreported';
	const tokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
	return tokens > 0 ? `${tokens.toLocaleString()} tok` : null;
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
}

export type DispatchTargetVerdict =
	'ok' | 'paused' | 'offline' | 'draining' | 'at_capacity' | 'backing_off' | 'quota_exhausted';

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
	'runner.removed',
	'runner.errored',
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
	type?: string;
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
/** Bumped when the document shape changes incompatibly; import refuses anything higher. */
export const LIBRARY_VERSION = 1;

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
 * The exported document. Each `workflows` entry is literally a valid
 * `CreateWorkflowRequest`, and each `context` entry is a
 * `CreateContextItemRequest` bar its scope — so import is a pass-through
 * into the existing validators rather than a second parser.
 *
 * The system `Standard` workflow is never exported (it is seeded with
 * identical ids on every instance); items scoped to its states are, and
 * re-resolve by name.
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
	/** Journals are deployment-specific memory; opt out to leave them behind. */
	journals?: boolean;
}

export interface ImportLibraryRequest {
	document: LibraryDocument;
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
	section: 'project' | 'workflow' | 'context';
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
