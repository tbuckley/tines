import type { ApiKey, ApiKeyCreated } from '@tines/shared';
import type { Kysely } from 'kysely';
import { newId, type Database } from '$lib/server/db';
import { ApiFail, notFound, requireString, runAtomic, sha256Hex, type ActorContext } from './core';
import { eventInsert } from './events';

const SECRET_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function generateSecret(): string {
	const bytes = new Uint8Array(40);
	crypto.getRandomValues(bytes);
	let out = '';
	for (const b of bytes) out += SECRET_ALPHABET[b % SECRET_ALPHABET.length];
	return `tines_${out}`;
}

function serialize(row: {
	id: string;
	name: string;
	key_prefix: string;
	created_at: number;
	last_used_at: number | null;
	revoked_at: number | null;
}): ApiKey {
	return {
		id: row.id,
		name: row.name,
		key_prefix: row.key_prefix,
		created_at: row.created_at,
		last_used_at: row.last_used_at,
		revoked_at: row.revoked_at
	};
}

export async function listApiKeys(db: Kysely<Database>, userId: string): Promise<ApiKey[]> {
	const rows = await db
		.selectFrom('api_key')
		.selectAll()
		.where('user_id', '=', userId)
		.orderBy('created_at desc')
		.execute();
	return rows.map(serialize);
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
