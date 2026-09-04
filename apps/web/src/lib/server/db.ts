import type { StateCategory } from '@tines/shared';
import { Kysely, SqliteAdapter } from 'kysely';
import { D1Dialect } from 'kysely-d1';

export interface ProjectTable {
	id: string;
	user_id: string;
	name: string;
	description: string;
	default_workflow_id: string | null;
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
	/** Prompt payload: Markdown body. */
	body: string | null;
	/** Repo payload: pointer fields (dir defaults at read time). */
	repo_url: string | null;
	repo_branch: string | null;
	repo_dir: string | null;
	/** JSON kind-specific config; artifacts store {"artifact_type": …}. */
	config: string | null;
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
	last_seen_at: number | null;
	launch_failures: number;
	backoff_until: number | null;
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
	/** JSON usage record. */
	usage: string | null;
	state_id_at_start: string;
	state_id_at_end: string | null;
	provider_session_id: string | null;
	provider_url: string | null;
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
}

export interface RoutingRuleTable {
	id: string;
	user_id: string;
	/** Scope: nullable dimensions with AND semantics; both NULL = global. */
	project_id: string | null;
	workflow_state_id: string | null;
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
	/** 0/1: the kill switch. Off (0) by default for new users. */
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
	updated_at: number;
}

/** Better Auth's user table — only the columns we read. */
export interface UserTable {
	id: string;
	name: string;
	email: string;
}

export interface Database {
	project: ProjectTable;
	workflow: WorkflowTable;
	workflow_state: WorkflowStateTable;
	workflow_transition: WorkflowTransitionTable;
	issue: IssueTable;
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
	routing_rule: RoutingRuleTable;
	supervisor_settings: SupervisorSettingsTable;
	supervisor_sweep_state: SupervisorSweepStateTable;
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
		db = new Kysely<Database>({ dialect: new ConcurrentD1Dialect({ database: env.DB }) });
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
	const chunks: string[][] = [];
	for (let i = 0; i < ids.length; i += IN_LIST_CHUNK) chunks.push(ids.slice(i, i + IN_LIST_CHUNK));
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
