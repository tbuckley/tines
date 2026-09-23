import type { StateCategory } from '@tines/shared';
import { Kysely, SqliteAdapter } from 'kysely';
import { D1Dialect } from 'kysely-d1';
import { traceUsageScaleDb } from './usage-scale-trace';

export interface ProjectTable {
	id: string;
	user_id: string;
	name: string;
	description: string;
	default_workflow_id: string | null;
	/** Set (ms) while the project is archived; NULL = live. */
	archived_at: number | null;
	created_at: number;
	updated_at: number;
}

export interface WorkflowTable {
	id: string;
	/** NULL = system workflow (the built-in standard workflow). */
	user_id: string | null;
	name: string;
	description: string;
	initial_state_id: string;
	created_at: number;
	updated_at: number;
}

export interface WorkflowStateTable {
	id: string;
	workflow_id: string;
	name: string;
	category: StateCategory;
	position: number;
	/** The state this one inherits context from (Tines/238), or null. */
	inherits_from_state_id: string | null;
	created_at: number;
}

export interface WorkflowTransitionTable {
	id: string;
	workflow_id: string;
	/** The action this transition represents ("approve", "send back"). */
	name: string;
	from_state_id: string;
	to_state_id: string;
	/** JSON array of artifact requirements; NULL = none. */
	requirements: string | null;
}

export interface IssueTable {
	id: string;
	project_id: string;
	number: number;
	title: string;
	description: string;
	workflow_id: string;
	state_id: string;
	/** Set when the issue was created by a scheduled task; NULL after the schedule is deleted. */
	scheduled_task_id: string | null;
	/** Pin: replaces routing-rule matching entirely for this issue. */
	pinned_runner_id: string | null;
	pinned_tier: string | null;
	/** Strikes toward the attempt limit; reset when a run advances the issue. */
	attempt_count: number;
	/** 0/1: parked after striking out; cleared by resume or a manual transition. */
	needs_attention: number;
	/**
	 * When the issue last entered its current state; stamped by every path
	 * that changes state_id. NULL only on rows predating migration 0011's
	 * backfill in exotic cases — readers fall back to created_at.
	 */
	state_entered_at: number | null;
	created_at: number;
	updated_at: number;
	/** Opaque fence changed on every project transfer, including A -> B -> A. */
	project_assignment_token: string;
}

export interface IssueAddressTable {
	project_id: string;
	number: number;
	issue_id: string;
	created_at: number;
}

export interface ScheduledTaskTable {
	id: string;
	project_id: string;
	name: string;
	title_template: string;
	description_template: string;
	workflow_id: string;
	/** Start state for created instances; NULL = the workflow's initial state. */
	state_id: string | null;
	/** Always populated (presets compile to it); the only thing the sweep evaluates. */
	cron: string;
	/** JSON preset for UI round-tripping; NULL = raw cron. */
	preset: string | null;
	/** IANA timezone the cron expression is evaluated in. */
	timezone: string;
	require_all_closed: number;
	enabled: number;
	next_run_at: number;
	last_run_at: number | null;
	run_count: number;
	created_at: number;
	updated_at: number;
}

export interface IssueLinkTable {
	id: string;
	/** `blocks`: source blocks target. `duplicate_of`: source duplicates target (the canonical issue). */
	source_issue_id: string;
	target_issue_id: string;
	kind: 'blocks' | 'duplicate_of';
	created_at: number;
}

export interface LabelTable {
	id: string;
	user_id: string;
	name: string;
	/** A LABEL_COLORS palette key, not a hex value. */
	color: string;
	description: string;
	created_at: number;
	updated_at: number;
}

export interface IssueLabelTable {
	issue_id: string;
	label_id: string;
	created_at: number;
}

export interface ContextItemTable {
	id: string;
	user_id: string;
	/** 'prompt' | 'skill' | 'repo'; open-ended by schema design. */
	kind: string;
	name: string;
	description: string;
	/** Scope: nullable dimensions with AND semantics; all NULL = global. */
	project_id: string | null;
	workflow_state_id: string | null;
	issue_id: string | null;
	/** Set-valued dimension: matches an issue that carries this label. */
	label_id: string | null;
	/** Prompt payload: Markdown body. */
	body: string | null;
	/** Repo payload: pointer fields (dir defaults at read time). */
	repo_url: string | null;
	repo_branch: string | null;
	repo_dir: string | null;
	/** JSON kind-specific config; artifacts store {"artifact_type": …}. */
	config: string | null;
	/**
	 * Env payload: exactly one of `env_value` (plaintext, non-secret) and
	 * `env_value_enc` (AES-GCM under SECRET_ENCRYPTION_KEY) is set; the hint
	 * is user-supplied display text, never derived from the value.
	 */
	env_value: string | null;
	env_value_enc: string | null;
	env_hint: string | null;
	/** Ordering within the same exact scope tuple. */
	position: number;
	/** Monotonic write counter — a CAS token, not history. */
	version: number;
	created_at: number;
	updated_at: number;
}

/** One immutable attached version of an artifact context item. */
export interface ArtifactVersionTable {
	id: string;
	context_item_id: string;
	/** 1..N, unique per artifact. */
	version: number;
	/** file/text: display name. */
	filename: string | null;
	/** file/text: declared MIME type. */
	content_type: string | null;
	/** file: uploaded byte count. */
	size_bytes: number | null;
	/** file: opaque R2 object key; never exposed over the API. */
	r2_key: string | null;
	/** text: the inline document. */
	content: string | null;
	/** link: the URL. */
	url: string | null;
	/** link: optional display title. */
	title: string | null;
	/** pr: canonical https://github.com/{owner}/{repo}. */
	pr_repo_url: string | null;
	/** pr: the pull request number. */
	pr_number: number | null;
	/** Version number this version reaffirms, when it is a reaffirmation. */
	reaffirmed_from: number | null;
	actor_user_id: string | null;
	actor_api_key_id: string | null;
	created_at: number;
}

/** One file of a folder artifact version (an immutable snapshot entry). */
export interface ArtifactVersionFileTable {
	id: string;
	artifact_version_id: string;
	/** Workspace-relative path; unique per version. */
	path: string;
	/** Declared MIME type. */
	content_type: string;
	size_bytes: number;
	/** Opaque R2 object key; never exposed over the API. */
	r2_key: string;
}

export interface ContextItemFileTable {
	id: string;
	context_item_id: string;
	/** Workspace-relative path; unique per item. */
	path: string;
	content: string;
	created_at: number;
	updated_at: number;
}

export interface CommentTable {
	id: string;
	issue_id: string;
	body: string;
	actor_user_id: string;
	actor_api_key_id: string | null;
	created_at: number;
	/** Null until the comment is edited. */
	updated_at: number | null;
}

export interface EventTable {
	id: string;
	user_id: string;
	type: string;
	actor_user_id: string;
	actor_api_key_id: string | null;
	issue_id: string | null;
	project_id: string | null;
	/** JSON-encoded payload. */
	payload: string;
	created_at: number;
}

export interface ApiKeyTable {
	id: string;
	user_id: string;
	name: string;
	/** Mint-time workflow name for run keys; NULL for legacy and ordinary keys. */
	run_workflow_name: string | null;
	/** Mint-time starting-state name for run keys; NULL for legacy and ordinary keys. */
	run_state_name: string | null;
	key_hash: string;
	key_prefix: string;
	/** Set on run keys: the run this key is bound to. NULL for ordinary keys. */
	agent_run_id: string | null;
	/** Run keys only: the key is dead past this time even if never revoked. */
	expires_at: number | null;
	created_at: number;
	last_used_at: number | null;
	revoked_at: number | null;
}

export interface RunnerTable {
	id: string;
	user_id: string;
	/** 'claude_managed' | 'gemini_managed' | 'local'. */
	type: string;
	name: string;
	/** 'active' | 'paused'. */
	status: string;
	max_concurrent: number;
	/** 'legacy' | 'local' | 'remote'. */
	concurrency_mode: string;
	concurrency_ceiling: number | null;
	concurrency_requested: number | null;
	concurrency_revision: number;
	concurrency_instance_id: string | null;
	concurrency_applied_revision: number | null;
	concurrency_applied_cap: number | null;
	concurrency_applied_instance_id: string | null;
	concurrency_applied_at: number | null;
	concurrency_unavailable_reason: string | null;
	max_run_minutes: number;
	default_tier: string;
	/** JSON per-tier model overrides; NULL = built-ins only. */
	tiers: string | null;
	/** JSON budget; NULL = none. */
	budget: string | null;
	/** JSON non-secret config (harness, hostname, agent ids…). */
	config: string;
	/** Encrypted provider API key (managed types); never serialized. */
	secret_enc: string | null;
	/** Hashed daemon token (local type); never serialized. */
	runner_token_hash: string | null;
	/** Current local-daemon boot admitted to mutate this runner through poll. */
	daemon_instance_id: string | null;
	/** JSON exact-model support asserted by the admitted daemon boot. */
	effort_capabilities: string | null;
	/** Immediately preceding daemon boot, rejected if it polls again. */
	fenced_instance_id: string | null;
	last_seen_at: number | null;
	launch_failures: number;
	backoff_until: number | null;
	/** 'rate_limit' when the hold is a usage limit; NULL for the failure backoff. */
	backoff_reason: string | null;
	/**
	 * 0/1: the daemon is finishing its runs before restarting for a
	 * self-update; set and cleared by its polls. Dispatch skips it while set.
	 */
	draining: number;
	resume_enabled: number;
	resume_window_hours: number;
	resume_max_turns: number;
	resume_max_tokens: number;
	resume_max_cost_usd: number;
	resume_config_revision: number;
	created_at: number;
	updated_at: number;
}

export interface AgentRunTable {
	id: string;
	user_id: string;
	issue_id: string;
	runner_id: string;
	/** 'assigned' | 'launching' | 'running' | 'completed' | 'failed' | 'timed_out' | 'canceled'. */
	status: string;
	/**
	 * How the end was judged: 'advanced' | 'stalled' | 'interrupted'. NULL
	 * while the run is active, for runs that never started (nothing to
	 * judge), and for every row that ended before the column existed.
	 */
	outcome: string | null;
	tier: string;
	/** Resolved at launch; NULL when the harness cannot vary its model. */
	model: string | null;
	requested_effort: string | null;
	resolved_effort: string | null;
	effort_source: string | null;
	effort_application_status: string | null;
	effort_application_evidence: string | null;
	/** JSON usage record. */
	usage: string | null;
	state_id_at_start: string;
	state_id_at_end: string | null;
	provider_session_id: string | null;
	provider_url: string | null;
	turn_count: number | null;
	conversation_turn_count: number | null;
	workspace_path: string | null;
	resume_fingerprint: string | null;
	resumed_from_run_id: string | null;
	resume_expires_at: number | null;
	resume_fallback_reason: string | null;
	api_key_id: string | null;
	/**
	 * JSON provider bookkeeping owned by the run's adapter (per-run vault id,
	 * event-poll cursor, GC marker); never serialized into API responses.
	 */
	provider_meta: string | null;
	/** Append-only tail, head-truncated at the cap. */
	log: string;
	log_bytes_dropped: number;
	/** Highest client-assigned chunk seq applied (log append idempotency). */
	log_seq: number;
	/** Highest `part.{n}` object written to the run-log bucket. */
	log_part_count: number;
	/** Parts at or below this index are merged into the `head` object. */
	log_compacted_through: number;
	/** 1 once the complete log is written to the `full` object. */
	log_sealed: number;
	/** Size of the raw harness stream object; 0 = none uploaded. */
	log_raw_bytes: number;
	/** Retention GC deleted this run's R2 objects (the D1 tail survives). */
	log_objects_deleted_at: number | null;
	error: string | null;
	created_at: number;
	started_at: number | null;
	ended_at: number | null;
	/** Assignment fence copied from the issue by the successful claim. */
	project_assignment_token: string;
}

export interface RoutingRuleTable {
	id: string;
	user_id: string;
	/** Scope: nullable dimensions with AND semantics; all NULL = global. */
	project_id: string | null;
	workflow_state_id: string | null;
	/** Set-valued dimension: matches an issue that carries this label. */
	label_id: string | null;
	/** JSON ordered target list: [ { runner_id, tier? } ]. */
	targets: string;
	created_at: number;
	updated_at: number;
}

/**
 * Global, singleton-per-key housekeeping state for sweep passes that cannot
 * finish in one pass. Currently just the run-log orphan pass's position in
 * the R2 keyspace (`run_log_gc_after`).
 */
export interface SupervisorSweepStateTable {
	key: string;
	value: string | null;
	updated_at: number;
}

export interface SupervisorSettingsTable {
	user_id: string;
	/** 0/1: the kill switch. Missing rows and new rows default on; stored 0 stays stopped. */
	enabled: number;
	/** JSON typed quota policy. */
	quota: string;
	attempt_limit: number;
	/** JSON global budget; unused until the money milestone. */
	budget: string | null;
	/** JSON pricing overrides; unused until the money milestone. */
	pricing: string | null;
	/** Encrypted GitHub PAT (AES-GCM; see crypto.ts). Write-only over the API. */
	github_pat_enc: string | null;
	/** Display hint for the stored PAT ("github_pat_…cdef"); never the value. */
	github_pat_hint: string | null;
	source_credentials_revision: number;
	updated_at: number;
}

export interface UserModelRateTable {
	id: string;
	user_id: string;
	model: string;
	version: number;
	input_rate: string;
	cache_read_rate: string;
	cache_write_rate: string | null;
	output_rate: string;
	copied_from: string | null;
	created_at: number;
	retired_at: number | null;
}

export interface RunResourceTable {
	id: string;
	user_id: string;
	runner_id: string | null;
	issue_id: string | null;
	kind: 'local_claude' | 'claude_managed';
	owner_run_id: string | null;
	state: 'active' | 'pending_retention' | 'available' | 'claimed' | 'disposing' | 'disposed';
	claim_run_id: string | null;
	claim_token: string | null;
	claim_started_at: number | null;
	transfer_phase: 'preparing' | 'sending' | 'accepted' | null;
	expires_at: number | null;
	available_seen_at: number | null;
	provider_session_id: string | null;
	vault_id: string | null;
	credential_id: string | null;
	workspace_path: string | null;
	resume_fingerprint: string;
	transfer_data: string | null;
	created_at: number;
	updated_at: number;
}

/** Better Auth's user table — only the columns we read. */
export interface UserTable {
	id: string;
	name: string;
	email: string;
}

/** Per-user UI preferences (the project focus, Tines/259); created lazily. */
export interface UserPreferenceTable {
	user_id: string;
	/** The focused project, or null for "All projects". */
	focused_project_id: string | null;
	/** The project New issue falls back to under "All projects". */
	last_project_id: string | null;
	updated_at: number;
}

/** Immutable proof that one signed workflow-package plan committed. */
export interface LibraryInstallTable {
	id: string;
	user_id: string;
	actor_key: string;
	document_digest: string;
	plan_digest: string;
	request_digest: string;
	execution_nonce: string;
	receipt_json: string;
	created_at: number;
}

export interface WorkflowPublicationTable {
	id: string;
	user_id: string;
	actor_key: string;
	prepare_request_id: string;
	prepare_request_hash: string;
	source_workflow_id: string | null;
	source_kind: 'owned_workflow' | 'file';
	source_provenance_json: string;
	document_json: string;
	document_digest: string;
	bytes_sha256: string;
	byte_length: number;
	metadata_json: string;
	review_digest: string;
	policy_version: number;
	created_at: number;
	expires_at: number;
	snapshot_id: string | null;
	published_at: number | null;
	owner_state: 'candidate' | 'published' | 'withdrawn';
	host_state: 'active' | 'removed';
	status_version: number;
	confirmed_at: number | null;
	confirmed_actor_key: string | null;
	publication_receipt_json: string | null;
	attempt_nonce: string | null;
	host_decision_reason: string | null;
	host_decision_reference: string | null;
}

export interface WorkflowPublicationSourceTable {
	publication_id: string;
	source_witness_json: string;
	source_fingerprint: string;
}

export interface WorkflowPublisherStatusTable {
	user_id: string;
	suspended: number;
	status_version: number;
	decision_reference: string | null;
	decision_reason: string | null;
}

export interface WorkflowPublicationQuotaFenceTable {
	user_id: string;
	version: number;
	attempt_nonce: string;
}

export interface WorkflowPublicationEventTable {
	id: string;
	publication_id: string;
	snapshot_id: string | null;
	user_id: string;
	actor_key: string;
	action:
		| 'published'
		| 'withdrawn'
		| 'restored'
		| 'host_removed'
		| 'publisher_suspended'
		| 'publisher_restored';
	publication_status_version: number;
	publisher_status_version: number;
	reason: string | null;
	reference: string | null;
	created_at: number;
}

export interface WorkflowReportCaseTable {
	snapshot_id: string;
	version: number;
	read_through_version: number;
	resolved_through_version: number;
	latest_report_at: number;
	updated_at: number;
}

export interface WorkflowReportTable {
	id: string;
	snapshot_id: string;
	case_version: number;
	reason: 'harmful_abusive' | 'malicious_phishing' | 'private_information' | 'rights' | 'other';
	note: string;
	note_hash: string;
	created_at: number;
	resolved_at: number | null;
}

export interface WorkflowReportRequestTable {
	request_token: string;
	body_hash: string;
	receipt_id: string;
	created_at: number;
	expires_at: number;
	attempt_nonce: string;
}

export interface WorkflowReportRateEventTable {
	receipt_id: string;
	subject_kind: 'network' | 'account';
	subject_token: string;
	accepted_at: number;
	expires_at: number;
}

export interface WorkflowModerationAuditTable {
	id: string;
	request_id: string;
	request_hash: string;
	actor_user_id: string;
	actor_name: string;
	action: 'dismiss' | 'disable' | 'restore' | 'suspend' | 'unsuspend';
	target_kind: 'snapshot' | 'publisher';
	target_id: string;
	snapshot_id: string | null;
	document_digest: string | null;
	bytes_sha256: string | null;
	publisher_user_id: string | null;
	before_json: string;
	after_json: string;
	case_cutoff: number | null;
	reason: string;
	created_at: number;
	expires_at: number;
}

export interface Database {
	project: ProjectTable;
	workflow: WorkflowTable;
	workflow_state: WorkflowStateTable;
	workflow_transition: WorkflowTransitionTable;
	issue: IssueTable;
	issue_address: IssueAddressTable;
	issue_link: IssueLinkTable;
	label: LabelTable;
	issue_label: IssueLabelTable;
	scheduled_task: ScheduledTaskTable;
	context_item: ContextItemTable;
	context_item_file: ContextItemFileTable;
	artifact_version: ArtifactVersionTable;
	artifact_version_file: ArtifactVersionFileTable;
	comment: CommentTable;
	event: EventTable;
	api_key: ApiKeyTable;
	runner: RunnerTable;
	agent_run: AgentRunTable;
	run_resource: RunResourceTable;
	routing_rule: RoutingRuleTable;
	supervisor_settings: SupervisorSettingsTable;
	user_model_rate: UserModelRateTable;
	supervisor_sweep_state: SupervisorSweepStateTable;
	user_preference: UserPreferenceTable;
	library_install: LibraryInstallTable;
	workflow_publication: WorkflowPublicationTable;
	workflow_publication_source: WorkflowPublicationSourceTable;
	workflow_publisher_status: WorkflowPublisherStatusTable;
	workflow_publication_quota_fence: WorkflowPublicationQuotaFenceTable;
	workflow_publication_event: WorkflowPublicationEventTable;
	workflow_report_case: WorkflowReportCaseTable;
	workflow_report: WorkflowReportTable;
	workflow_report_request: WorkflowReportRequestTable;
	workflow_report_rate_event: WorkflowReportRateEventTable;
	workflow_moderation_audit: WorkflowModerationAuditTable;
	user: UserTable;
}

/**
 * kysely-d1 reuses Kysely's stock SqliteAdapter, whose
 * `supportsMultipleConnections = false` makes Kysely wrap every query in a
 * connection mutex. That is right for a local SQLite file and wrong for D1,
 * which is a remote binding that accepts concurrent statements: the mutex
 * silently serialises every `Promise.all` fan-out in our loads (measured:
 * the issue page ran 26 queries in 26 sequential round trips).
 *
 * INVARIANT: nothing under `apps/web/src` may call `db.transaction()`. A
 * Kysely transaction pins one connection, and with the mutex lifted unrelated
 * statements would interleave into it. Every multi-statement write goes
 * through `runAtomic()` -> `env.DB.batch()`, which never touches Kysely's
 * connection at all. Enforced by a test in db.test.ts.
 *
 * Fan-out ceiling: the widest load (the issue page) peaks at ~11 concurrent
 * statements — far below the Worker subrequest cap — so no throttle is
 * needed. Re-check that if a load grows a much wider Promise.all.
 */
class ConcurrentD1Adapter extends SqliteAdapter {
	override get supportsMultipleConnections() {
		return true;
	}
}

export class ConcurrentD1Dialect extends D1Dialect {
	override createAdapter(): SqliteAdapter {
		return new ConcurrentD1Adapter();
	}
}

const dbs = new WeakMap<object, Kysely<Database>>();

/**
 * Kysely over D1, memoized per binding. In production one isolate sees one
 * binding, so this is the old per-isolate singleton; keying on the binding
 * (rather than a module global) additionally keeps separate `Env`s — e.g.
 * per-test fakes — from sharing one connection.
 */
export function getDb(env: Env): Kysely<Database> {
	let db = dbs.get(env.DB);
	if (!db) {
		db = new Kysely<Database>({
			dialect: new ConcurrentD1Dialect({
				database: env.USAGE_SCALE_SQL_TRACE === '1' ? traceUsageScaleDb(env.DB) : env.DB
			})
		});
		dbs.set(env.DB, db);
	}
	return db;
}

/**
 * D1 caps bound parameters per statement at 100, and each id in an `IN` list
 * binds one. Anything that builds an `IN` list from a set the caller does not
 * control the size of — a page of R2 keys, a user's whole artifact list —
 * queries in chunks of this and re-assembles.
 */
export const IN_LIST_CHUNK = 90;

export function idChunks(ids: string[]): string[][] {
	return chunked(ids, IN_LIST_CHUNK);
}

/**
 * `items` in slices of at most `size`. For a statement that binds more than
 * one parameter per item, pass `IN_LIST_CHUNK / perItem` (floored) so a full
 * chunk still fits under D1's cap.
 */
export function chunked<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
	return chunks;
}

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Uniform random string over the 62-char alphabet. Rejection sampling: bytes
 * ≥ 248 (the largest multiple of 62 below 256) are discarded so no character
 * is more likely than another — a plain `byte % 62` would bias toward the
 * first 8 characters.
 */
export function randomString(length: number): string {
	const limit = 256 - (256 % ID_ALPHABET.length);
	let out = '';
	while (out.length < length) {
		const bytes = new Uint8Array(length - out.length + 8);
		crypto.getRandomValues(bytes);
		for (const b of bytes) {
			if (b < limit) {
				out += ID_ALPHABET[b % ID_ALPHABET.length];
				if (out.length === length) break;
			}
		}
	}
	return out;
}

/** Opaque id with a type prefix, e.g. `iss_h2K9x…` (16 random chars). */
export function newId(prefix: string): string {
	return `${prefix}_${randomString(16)}`;
}
