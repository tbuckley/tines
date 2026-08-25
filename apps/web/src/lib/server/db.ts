import type { StateCategory } from '@tines/shared';
import { Kysely } from 'kysely';
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

export interface CommentTable {
	id: string;
	issue_id: string;
	body: string;
	actor_user_id: string;
	actor_api_key_id: string | null;
	created_at: number;
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
	created_at: number;
	last_used_at: number | null;
	revoked_at: number | null;
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
	scheduled_task: ScheduledTaskTable;
	comment: CommentTable;
	event: EventTable;
	api_key: ApiKeyTable;
	user: UserTable;
}

let db: Kysely<Database> | undefined;

/** Kysely over D1, memoized per isolate (bindings are isolate-stable). */
export function getDb(env: Env): Kysely<Database> {
	db ??= new Kysely<Database>({ dialect: new D1Dialect({ database: env.DB }) });
	return db;
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
