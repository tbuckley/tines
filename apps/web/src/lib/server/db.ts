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

/** Opaque id with a type prefix, e.g. `iss_h2K9x…` (16 random chars). */
export function newId(prefix: string): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	let out = '';
	for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
	return `${prefix}_${out}`;
}
