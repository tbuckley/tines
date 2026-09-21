import {
	FULL_API_KEY_PERMISSIONS,
	apiKeyPermissionsSubset,
	intersectApiKeyPermissions,
	parseApiKeyPermissions,
	serializeApiKeyPermissions,
	type ApiKey,
	type ApiKeyCreated,
	type ApiKeyAuthority,
	type ApiKeyPermissions,
	type RunKeyCounts,
	type RunKeyFilter
} from '@tines/shared';
import { sql, type Kysely } from 'kysely';
import { newId, randomString, type Database } from '$lib/server/db';
import { ApiFail, notFound, requireString, runAtomic, sha256Hex, type ActorContext } from './core';
import { actorRunOf, eventInsert } from './events';
import { requireAccess } from './permissions';

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
	permissions: string;
	expires_at?: number | null;
	agent_run_id?: string | null;
	run_status?: string | null;
	run_api_key_id?: string | null;
	run_issue_id?: string | null;
	run_project_id?: string | null;
	run_launch_state_id?: string | null;
	runner_name?: string | null;
	run_workflow_name?: string | null;
	run_state_name?: string | null;
	run_project_name?: string | null;
	run_issue_number?: number | null;
}

function serialize(row: ApiKeyRow): ApiKey {
	let permissions: ApiKeyPermissions;
	try {
		permissions = parseApiKeyPermissions(JSON.parse(row.permissions));
	} catch {
		throw new ApiFail(
			500,
			'invalid_key_permissions',
			`API key "${row.id}" has invalid permissions`,
			{
				api_key_id: row.id
			}
		);
	}
	const runRestriction =
		row.agent_run_id && row.run_issue_id && row.run_project_id && row.run_launch_state_id
			? {
					policy: 'run-v1' as const,
					run_id: row.agent_run_id,
					issue_id: row.run_issue_id,
					project_id: row.run_project_id,
					launch_state_id: row.run_launch_state_id
				}
			: null;
	const effectivePermissions = runRestriction
		? intersectApiKeyPermissions(permissions, {
				version: 1,
				projects: { access: 'delete', scope: [runRestriction.project_id] },
				workspace: 'write',
				control_plane: 'read'
			})
		: permissions;
	const key: ApiKey = {
		id: row.id,
		name: row.name,
		key_prefix: row.key_prefix,
		created_at: row.created_at,
		last_used_at: row.last_used_at,
		revoked_at: row.revoked_at,
		permissions,
		effective_permissions: effectivePermissions,
		run_restrictions: runRestriction,
		usable:
			row.revoked_at === null &&
			(row.expires_at == null || row.expires_at > Date.now()) &&
			(row.agent_run_id == null ||
				((row.run_status === 'launching' || row.run_status === 'running') &&
					row.run_api_key_id === row.id))
	};
	// Only run keys carry provenance; a user key's wire shape is unchanged.
	if (row.agent_run_id) {
		key.run = actorRunOf({
			run_id: row.agent_run_id,
			runner_name: row.runner_name ?? null,
			run_workflow_name: row.run_workflow_name ?? null,
			run_state_name: row.run_state_name ?? null,
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
			'api_key.permissions',
			'api_key.agent_run_id',
			'api_key.expires_at',
			'api_key.run_workflow_name',
			'api_key.run_state_name',
			'run.status as run_status',
			'run.api_key_id as run_api_key_id',
			'run.issue_id as run_issue_id',
			'run.state_id_at_start as run_launch_state_id',
			'run_project.id as run_project_id',
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
	actor: ActorContext,
	opts: ListApiKeysOptions = {}
): Promise<ApiKey[]> {
	requireAccess(actor, [{ domain: 'control_plane', access: 'read' }], 'api_key.list');
	const userId = actor.userId;
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
	name: string,
	permissionsInput: unknown = FULL_API_KEY_PERMISSIONS
): Promise<ApiKeyCreated> {
	const keyName = requireString(name, 'name', { max: 100 }).trim();
	let permissions: ApiKeyPermissions;
	try {
		permissions = parseApiKeyPermissions(permissionsInput);
	} catch (error) {
		if (error instanceof Error && 'field' in error) {
			throw new ApiFail(422, 'invalid_field', error.message, {
				field: (error as { field: string }).field
			});
		}
		throw error;
	}
	requireAccess(actor, [{ domain: 'control_plane', access: 'write' }], 'api_key.create');
	if (!apiKeyPermissionsSubset(permissions, effectivePermissions(actor))) {
		throw new ApiFail(
			403,
			'permission_delegation_forbidden',
			'Cannot delegate more authority than the acting credential'
		);
	}
	await validateIntroducedProjectIds(db, actor.userId, permissions, null);
	const secret = generateSecret();
	const now = Date.now();
	const row = {
		id: newId('key'),
		user_id: actor.userId,
		name: keyName,
		key_hash: await sha256Hex(secret),
		key_prefix: secret.slice(0, 14),
		permissions: serializeApiKeyPermissions(permissions),
		created_at: now,
		last_used_at: null,
		revoked_at: null
	};
	await runAtomic(env, [
		db.insertInto('api_key').values(row).compile(),
		eventInsert(db, actor, {
			type: 'api_key.created',
			payload: { api_key_id: row.id, name: keyName, key_prefix: row.key_prefix, permissions }
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
	requireAccess(actor, [{ domain: 'control_plane', access: 'delete' }], 'api_key.revoke');
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

function effectivePermissions(actor: ActorContext): ApiKeyPermissions {
	const stored = actor.permissions ?? FULL_API_KEY_PERMISSIONS;
	if (!actor.runRestriction) return stored;
	return intersectApiKeyPermissions(stored, {
		version: 1,
		projects: { access: 'delete', scope: [actor.runRestriction.projectId] },
		workspace: 'write',
		control_plane: 'read'
	});
}

async function validateIntroducedProjectIds(
	db: Kysely<Database>,
	userId: string,
	permissions: ApiKeyPermissions,
	previous: ApiKeyPermissions | null
): Promise<void> {
	if (permissions.projects.scope === 'all') return;
	const old = previous?.projects.scope === 'all' ? [] : (previous?.projects.scope ?? []);
	const introduced = permissions.projects.scope.filter((id) => !old.includes(id));
	if (introduced.length === 0) return;
	const rows = await db
		.selectFrom('project')
		.select('id')
		.where('user_id', '=', userId)
		.where(sql<boolean>`id IN (SELECT value FROM json_each(${JSON.stringify(introduced)}))`)
		.execute();
	if (rows.length !== introduced.length) {
		throw new ApiFail(
			422,
			'invalid_field',
			'Project permission scope contains an unknown project ID',
			{ field: 'permissions.projects.scope' }
		);
	}
}

export async function getApiKey(
	db: Kysely<Database>,
	actor: ActorContext,
	id: string
): Promise<ApiKey> {
	requireAccess(actor, [{ domain: 'control_plane', access: 'read' }], 'api_key.read');
	const row = await keyQuery(db, actor.userId).where('api_key.id', '=', id).executeTakeFirst();
	if (!row) throw notFound();
	return serialize(row);
}

export function currentApiKeyAuthority(actor: ActorContext): {
	key: null | { id: string; name: string };
	authority: ApiKeyAuthority;
} {
	const stored = actor.permissions ?? FULL_API_KEY_PERMISSIONS;
	return {
		key: actor.apiKeyId ? { id: actor.apiKeyId, name: actor.apiKeyName ?? '' } : null,
		authority: {
			stored_permissions: stored,
			effective_permissions: effectivePermissions(actor),
			run_restrictions: actor.runRestriction
				? {
						policy: 'run-v1',
						run_id: actor.runRestriction.runId,
						issue_id: actor.runRestriction.issueId,
						project_id: actor.runRestriction.projectId,
						launch_state_id: actor.runRestriction.launchStateId
					}
				: null,
			usable: true
		}
	};
}

function parseInputPermissions(input: unknown): ApiKeyPermissions {
	try {
		return parseApiKeyPermissions(input);
	} catch (error) {
		if (error instanceof Error && 'field' in error) {
			throw new ApiFail(422, 'invalid_field', error.message, {
				field: (error as { field: string }).field
			});
		}
		throw error;
	}
}

export async function updateApiKeyPermissions(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	id: string,
	permissionsInput: unknown,
	expectedInput: unknown
): Promise<ApiKey> {
	requireAccess(actor, [{ domain: 'control_plane', access: 'write' }], 'api_key.update');
	const permissions = parseInputPermissions(permissionsInput);
	const expected = parseInputPermissions(expectedInput);
	if (!apiKeyPermissionsSubset(permissions, effectivePermissions(actor))) {
		throw new ApiFail(
			403,
			'permission_delegation_forbidden',
			'Cannot delegate more authority than the acting credential'
		);
	}
	const before = await keyQuery(db, actor.userId).where('api_key.id', '=', id).executeTakeFirst();
	if (!before) throw notFound();
	if (before.revoked_at !== null) {
		throw new ApiFail(422, 'already_revoked', 'Revoked API key permissions cannot change');
	}
	const current = parseApiKeyPermissions(JSON.parse(before.permissions));
	const currentJson = serializeApiKeyPermissions(current);
	const expectedJson = serializeApiKeyPermissions(expected);
	if (currentJson !== expectedJson) {
		throw new ApiFail(409, 'permissions_conflict', 'API key permissions changed; reload and retry');
	}
	const nextJson = serializeApiKeyPermissions(permissions);
	if (nextJson === currentJson) return serialize(before);
	await validateIntroducedProjectIds(db, actor.userId, permissions, current);

	const eventId = newId('evt');
	const now = Date.now();
	const payload = JSON.stringify({
		api_key_id: id,
		name: before.name,
		before: current,
		after: permissions
	});
	const actorWitness = actor.apiKeyId
		? sql`AND EXISTS (
			SELECT 1 FROM api_key manager
			WHERE manager.id = ${actor.apiKeyId} AND manager.user_id = ${actor.userId}
				AND manager.permissions = ${serializeApiKeyPermissions(actor.permissions!)}
				AND manager.revoked_at IS NULL
				AND (manager.expires_at IS NULL OR manager.expires_at > ${now})
		)`
		: sql``;
	const admission = sql`
		INSERT INTO event (id, user_id, type, actor_user_id, actor_api_key_id, payload, created_at)
		SELECT ${eventId}, ${actor.userId}, 'api_key.permissions_updated', ${actor.userId}, ${actor.apiKeyId}, ${payload}, ${now}
		WHERE EXISTS (
			SELECT 1 FROM api_key target
			WHERE target.id = ${id} AND target.user_id = ${actor.userId}
				AND target.permissions = ${expectedJson} AND target.revoked_at IS NULL
		) ${actorWitness}
	`.compile(db);
	const update = sql`
		UPDATE api_key SET permissions = ${nextJson}
		WHERE id = ${id} AND user_id = ${actor.userId}
			AND EXISTS (SELECT 1 FROM event WHERE id = ${eventId})
	`.compile(db);
	const [admitted, changed] = await runAtomic(env, [admission, update]);
	if (admitted.meta.changes !== 1 || changed.meta.changes !== 1) {
		throw new ApiFail(409, 'permissions_conflict', 'API key permissions changed; reload and retry');
	}
	return getApiKey(db, actor, id);
}
