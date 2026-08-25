/** Wire types for the Tines phase-one API (`/api/v1/*`). All snake_case. */

import type { SchedulePreset } from './schedule.js';

export type StateCategory = 'backlog' | 'active' | 'awaiting_human' | 'done';

export const STATE_CATEGORIES: readonly StateCategory[] = [
	'backlog',
	'active',
	'awaiting_human',
	'done'
];

/** Who performed an action: always a user, optionally via a named API key. */
export interface Actor {
	user_id: string;
	user_name: string;
	/** NULL when the user acted directly (browser session). */
	api_key_id: string | null;
	api_key_name: string | null;
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

export interface Issue {
	id: string;
	project_id: string;
	project_name: string;
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
	/** Set when the issue was created by a scheduled task (null once the schedule is deleted). */
	scheduled_task_id: string | null;
	scheduled_task_name: string | null;
	created_at: number;
	updated_at: number;
	/** Timestamp of the most recent event touching this issue. */
	last_activity_at: number;
}

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
}

export interface IssueDetail extends Issue {
	workflow: Workflow;
	comments: Comment[];
	/** The named transitions legally available from the current state. */
	allowed_transitions: AllowedTransition[];
	links: IssueLinks;
	/** Per-kind counts of the currently effective context, post-dedupe. */
	context_summary: ContextSummary;
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
	/** Unique within the project; schedules are addressed as `<project>/<name>`. */
	name: string;
	title_template: string;
	description_template: string;
	workflow_id: string;
	workflow_name: string;
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
}

// ---------------------------------------------------------------------------
// Context items

export type ContextKind = 'prompt' | 'skill' | 'repo';

export const CONTEXT_KINDS: readonly ContextKind[] = ['prompt', 'skill', 'repo'];

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

- **Issue comments** — all prose about this issue: progress, findings, dead ends, questions, and instructions for whoever picks it up next. \`tines issues comment <project>/<number> "<markdown>"\`
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
	/** Name/description search. */
	q?: string;
	exact?: boolean;
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
}

/** `GET /api/v1/issues/:id/prompt` — stitched context plus the issue block. */
export interface LaunchPromptResponse {
	text: string;
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
	if (!base || base === '.' || base === '..' || base.includes('\\') || base.includes('=')) return 'repo';
	return base;
}

// ---------------------------------------------------------------------------
// Comments

export interface Comment {
	id: string;
	issue_id: string;
	body: string;
	actor: Actor;
	created_at: number;
}

export interface CreateCommentRequest {
	body: string;
}

// ---------------------------------------------------------------------------
// Events

export type EventType =
	| 'issue.created'
	| 'issue.updated'
	| 'issue.transitioned'
	| 'issue.commented'
	| 'issue.link_added'
	| 'issue.link_removed'
	| 'project.created'
	| 'project.updated'
	| 'project.deleted'
	| 'workflow.created'
	| 'workflow.updated'
	| 'workflow.deleted'
	| 'api_key.created'
	| 'api_key.revoked'
	| 'scheduled_task.created'
	| 'scheduled_task.updated'
	| 'scheduled_task.deleted'
	| 'scheduled_task.skipped'
	| 'context.created'
	| 'context.updated'
	| 'context.deleted'
	// Open-ended by design: later phases add types without migration.
	| (string & {});

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
