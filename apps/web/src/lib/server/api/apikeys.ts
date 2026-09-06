import type { ApiKey, ApiKeyCreated, RunKeyCounts, RunKeyFilter } from '@tines/shared';
import { sql, type Kysely } from 'kysely';
import { newId, randomString, type Database } from '$lib/server/db';
import { ApiFail, notFound, requireString, runAtomic, sha256Hex, type ActorContext } from './core';
import { actorRunOf, eventInsert } from './events';

/**
 * How many *revoked* run keys a listing carries at most, newest first. They
 * carry no action, so the list is a recent-history window rather than a
 * complete record — the Activity feed holds the rest. Without a bound the
 * page grows by one row per run forever (~50/day on a busy instance).
 */
export const REVOKED_RUN_KEY_LIMIT = 50;

export interface ListApiKeysOptions {
	/** Which run keys to return alongside the user's own keys. Default 'active'. */
	runKeys?: RunKeyFilter;
	/** With 'all': cap on revoked run keys, newest first. Default REVOKED_RUN_KEY_LIMIT. */
	revokedRunKeyLimit?: number;
}

function generateSecret(): string {
	return `tines_${randomString(40)}`;
}

interface ApiKeyRow {
	id: string;
	name: string;
	key_prefix: string;
	created_at: number;
	last_used_at: number | null;
	revoked_at: number | null;
	agent_run_id?: string | null;
	runner_name?: string | null;
	run_project_name?: string | null;
	run_issue_number?: number | null;
}

function serialize(row: ApiKeyRow): ApiKey {
	const key: ApiKey = {
		id: row.id,
		name: row.name,
		key_prefix: row.key_prefix,
		created_at: row.created_at,
		last_used_at: row.last_used_at,
		revoked_at: row.revoked_at
	};
	// Only run keys carry provenance; a user key's wire shape is unchanged.
	if (row.agent_run_id) {
		key.run = actorRunOf({
			run_id: row.agent_run_id,
			runner_name: row.runner_name ?? null,
			run_project_name: row.run_project_name ?? null,
			run_issue_number: row.run_issue_number ?? null
		});
	}
	return key;
}

/**
 * Base listing query: the key plus, for run keys, the runner and the issue the
 * run was working — the same `agent_run → runner → issue → project` resolution
 * the event feed does for run-key attribution.
 */
function keyQuery(db: Kysely<Database>, userId: string) {
	return db
		.selectFrom('api_key')
		.leftJoin('agent_run as run', 'run.id', 'api_key.agent_run_id')
		.leftJoin('runner', 'runner.id', 'run.runner_id')
		.leftJoin('issue as run_issue', 'run_issue.id', 'run.issue_id')
		.leftJoin('project as run_project', 'run_project.id', 'run_issue.project_id')
		.select([
			'api_key.id',
			'api_key.name',
			'api_key.key_prefix',
			'api_key.created_at',
			'api_key.last_used_at',
			'api_key.revoked_at',
			'api_key.agent_run_id',
			'runner.name as runner_name',
			'run_project.name as run_project_name',
			'run_issue.number as run_issue_number'
		])
		.where('api_key.user_id', '=', userId)
		.orderBy('api_key.created_at desc');
}

/**
 * The user's keys, newest first. Run keys are minted one per agent run and
 * never deleted (comments and events reference them for attribution), so the
 * caller says how many of them it wants: none, the ones that can still act
 * (default), or those plus a capped window of recently revoked ones.
 */
export async function listApiKeys(
	db: Kysely<Database>,
	userId: string,
	opts: ListApiKeysOptions = {}
): Promise<ApiKey[]> {
	const runKeys = opts.runKeys ?? 'active';
	let base = keyQuery(db, userId);
	if (runKeys === 'none') base = base.where('api_key.agent_run_id', 'is', null);
	// 'active'/'all' both start from every user key plus every unrevoked run
	// key: a live run key exists only while its run does, so that set is
	// bounded by runner concurrency.
	else
		base = base.where((eb) =>
			eb.or([eb('api_key.agent_run_id', 'is', null), eb('api_key.revoked_at', 'is', null)])
		);
	const rows = await base.execute();
	if (runKeys !== 'all') return rows.map(serialize);

	// Revoked run keys come from a second bounded query rather than a UNION
	// with a per-branch limit, which Kysely cannot express against D1. The
	// page sorts within each population, so no merge is needed.
	const revoked = await keyQuery(db, userId)
		.where('api_key.agent_run_id', 'is not', null)
		.where('api_key.revoked_at', 'is not', null)
		.limit(opts.revokedRunKeyLimit ?? REVOKED_RUN_KEY_LIMIT)
		.execute();
	return [...rows, ...revoked].map(serialize);
}

/** How many run keys the user has, split by whether they can still act. */
export async function countRunKeys(db: Kysely<Database>, userId: string): Promise<RunKeyCounts> {
	const row = await db
		.selectFrom('api_key')
		.select([
			sql<number | null>`sum(revoked_at is null)`.as('active'),
			sql<number | null>`sum(revoked_at is not null)`.as('revoked')
		])
		.where('user_id', '=', userId)
		.where('agent_run_id', 'is not', null)
		.executeTakeFirst();
	// SUM over no rows is NULL: a user with no run keys counts zero of each.
	return { active: Number(row?.active ?? 0), revoked: Number(row?.revoked ?? 0) };
}

export async function createApiKey(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	name: string
): Promise<ApiKeyCreated> {
	const keyName = requireString(name, 'name', { max: 100 }).trim();
	const secret = generateSecret();
	const now = Date.now();
	const row = {
		id: newId('key'),
		user_id: actor.userId,
		name: keyName,
		key_hash: await sha256Hex(secret),
		key_prefix: secret.slice(0, 14),
		created_at: now,
		last_used_at: null,
		revoked_at: null
	};
	await runAtomic(env, [
		db.insertInto('api_key').values(row).compile(),
		eventInsert(db, actor, {
			type: 'api_key.created',
			payload: { api_key_id: row.id, name: keyName, key_prefix: row.key_prefix }
		})
	]);
	return { ...serialize(row), key: secret };
}

export async function revokeApiKey(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	id: string
): Promise<void> {
	const row = await db
		.selectFrom('api_key')
		.selectAll()
		.where('id', '=', id)
		.where('user_id', '=', actor.userId)
		.executeTakeFirst();
	if (!row) throw notFound();
	if (row.revoked_at !== null) {
		throw new ApiFail(422, 'already_revoked', `API key "${row.name}" is already revoked`);
	}
	await runAtomic(env, [
		db.updateTable('api_key').set({ revoked_at: Date.now() }).where('id', '=', id).compile(),
		eventInsert(db, actor, { type: 'api_key.revoked', payload: { api_key_id: id, name: row.name } })
	]);
}
