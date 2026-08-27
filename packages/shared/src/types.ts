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
 * Canonical actor rendering everywhere actions are attributed: "alice",
 * "alice via laptop-key", or — for run keys — "alice via laptop-m4 · run on
 * demo/12".
 */
export function actorLabel(actor: Actor): string {
	if (actor.run) {
		const ref = actor.run.issue_ref
			? `run on ${actor.run.issue_ref.project_name}/${actor.run.issue_ref.number}`
			: `run ${actor.run.run_id}`;
		return `${actor.user_name} via ${actor.run.runner_name} · ${ref}`;
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
	| 'assigned'
	| 'launching'
	| 'running'
	| 'completed'
	| 'failed'
	| 'timed_out'
	| 'canceled';

export const RUN_STATUSES: readonly RunStatus[] = [
	'assigned',
	'launching',
	'running',
	'completed',
	'failed',
	'timed_out',
	'canceled'
];

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
	/** Null until the settings row has been written at least once. */
	updated_at: number | null;
}

/** PUT is a merge: omitted fields keep their current values. */
export interface UpdateSupervisorSettingsRequest {
	enabled?: boolean;
	quota?: QuotaPolicy;
	attempt_limit?: number;
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
	/** Non-secret config (harness, hostname…). */
	config: Record<string, unknown>;
	/**
	 * Managed runners are always online; a local runner is online while its
	 * daemon has polled within the last 2 minutes.
	 */
	online: boolean;
	last_seen_at: number | null;
	launch_failures: number;
	backoff_until: number | null;
	/** Runs currently holding a claim on this runner (assigned/launching/running). */
	active_runs: number;
	created_at: number;
	updated_at: number;
}

export interface CreateRunnerRequest {
	/** Only 'local' can be created over the API for now (managed types come with credential handling). */
	type: RunnerType;
	name: string;
	max_concurrent?: number;
	max_run_minutes?: number;
	default_tier?: ModelTier;
	/** Local runners: { harness?: 'claude_code' | 'codex' | 'custom', … }. */
	config?: Record<string, unknown>;
}

export interface UpdateRunnerRequest {
	name?: string;
	/** Pause with 'paused'; resume with 'active'. */
	status?: RunnerStatus;
	max_concurrent?: number;
	max_run_minutes?: number;
	default_tier?: ModelTier;
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
 * A routing rule: at most one per exact scope (project ∧ state, project,
 * state, or global). The most specific matching rule wins outright —
 * `project ∧ state` > `project` > `state` > global — with no fallback
 * across rules. `scope.issue_id` is always null (pins cover per-issue).
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
	targets: RoutingTarget[];
}

export interface UpdateRoutingRuleRequest {
	/** Scope is merge-patched: omitted = unchanged, explicit null = unset. */
	project_id?: string | null;
	workflow_state_id?: string | null;
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
		.map(([stateId, { name, n }]) => `${name} ${n}/${quota.overrides[stateId] ?? quota.default_limit}`)
		.join(' · ');
}

// ---------------------------------------------------------------------------
// Dispatch explainer

/** One eligibility check, pass or fail, with a human-readable detail. */
export interface DispatchCheck {
	name:
		| 'automation_enabled'
		| 'state_active'
		| 'ready'
		| 'no_active_run'
		| 'not_parked'
		| 'routed';
	ok: boolean;
	detail: string;
}

export type DispatchTargetVerdict =
	| 'ok'
	| 'paused'
	| 'offline'
	| 'at_capacity'
	| 'backing_off'
	| 'quota_exhausted';

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
	/** The winning rule; null when pinned or nothing matches. */
	matched_rule: { rule_id: string; scope_label: string } | null;
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
	| 'runner.registered'
	| 'runner.updated'
	| 'runner.removed'
	| 'runner.errored'
	| 'routing_rule.created'
	| 'routing_rule.updated'
	| 'routing_rule.deleted'
	| 'settings.updated'
	| 'agent_run.started'
	| 'agent_run.ended'
	| 'issue.parked'
	| 'issue.resumed'
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
