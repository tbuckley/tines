/**
 * What a context write may say when it is refused or loses a race
 * (Tines/742). A failed write answers through the same disclosure policy as
 * the ordinary read: authority over the item is checked before a stale
 * version can surface it, and a conflict's `current` is the item as this
 * actor's GET returns it. Every case drives the exported handlers.
 */
import { describe, expect, it, vi } from 'vitest';
import { createContextItem } from '$lib/server/api/context';
import { sessionActor, sha256Hex } from '$lib/server/api/core';
import { createTestDb } from '$lib/server/api/test-db';
import { NOW, PROJECT, seedBase, USER } from '$lib/server/supervisor/test-fixtures';
import { GET as LIST, POST as CREATE } from '../+server';
import { GET, PATCH } from './+server';
import { POST as APPEND } from './append/+server';

vi.mock('$lib/server/supervisor/engine', () => ({ queueDispatchPass: vi.fn() }));

type T = ReturnType<typeof createTestDb>;
const BOB = 'u2';
const KEY = 'synthetic-scoped-key';

function fixture() {
	const t = createTestDb();
	seedBase(t);
	t.env.SECRET_ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
	t.sqlite.exec(`INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt)
		VALUES ('${BOB}','Bob','bob@example.com',1,${NOW},${NOW});
		UPDATE project SET shared_at=${NOW},sharing_revision=1 WHERE id='${PROJECT}';
		INSERT INTO project_member (project_id,user_id,revision,joined_at,updated_at)
		VALUES ('${PROJECT}','${BOB}',1,${NOW},${NOW});`);
	return { t, owner: sessionActor({ id: USER, name: 'Alice' }) };
}

/** A named key of the owner's that reaches no project, workspace or control plane. */
async function addScopedKey(t: T) {
	t.sqlite
		.prepare(
			`INSERT INTO api_key (id,user_id,name,key_hash,key_prefix,created_at,permissions) VALUES (?,?,?,?,?,?,?)`
		)
		.run(
			'key_scoped',
			USER,
			'scoped',
			await sha256Hex(KEY),
			'synthetic',
			NOW,
			JSON.stringify({
				projects: { access: 'read', scope: [] },
				workspace: 'none',
				control_plane: 'none'
			})
		);
}

type Caller = { user: string } | { key: string };

async function call(
	t: T,
	handler: typeof GET | typeof PATCH | typeof APPEND | typeof LIST | typeof CREATE,
	caller: Caller,
	/** An item id, or a query string for the collection routes. */
	id: string,
	method: string,
	body?: unknown
) {
	const url = new URL(`http://test/api/v1/context${id.startsWith('?') ? id : `/${id}`}`);
	const headers: Record<string, string> = {};
	if (body !== undefined) headers['content-type'] = 'application/json';
	if ('key' in caller) headers.authorization = `Bearer ${caller.key}`;
	const event = {
		locals: 'user' in caller ? { user: { id: caller.user, name: caller.user } } : {},
		platform: { env: t.env, ctx: { waitUntil: () => {} } },
		params: { id },
		url,
		request: new Request(url, {
			method,
			headers,
			...(body === undefined ? {} : { body: JSON.stringify(body) })
		})
	};
	const res = await (handler as typeof GET)(event as unknown as Parameters<typeof GET>[0]);
	const text = await res.text();
	return { status: res.status, text, json: text ? JSON.parse(text) : null };
}

const stored = (t: T, id: string) => t.all('SELECT * FROM context_item WHERE id=?', id)[0];
const eventIds = (t: T) => t.all('SELECT id FROM event ORDER BY id').map((row) => row.id);

/** Runs `race` once, after the write's reads and immediately before its batch commits. */
function beforeNextBatch(t: T, race: () => void) {
	const batch = t.env.DB.batch.bind(t.env.DB);
	t.env.DB.batch = ((statements: Parameters<typeof batch>[0]) => {
		t.env.DB.batch = batch;
		race();
		return batch(statements);
	}) as typeof t.env.DB.batch;
}

describe('context writes disclose no more than the ordinary read', () => {
	it.each([
		['PATCH', { expected_version: 0, description: 'edit' }, false],
		// Without a version too: the refusal must not depend on the conflict path.
		['PATCH', { description: 'edit' }, false],
		// A kind mismatch used to answer with the stored kind.
		['PATCH', { kind: 'env' }, false],
		['APPEND', { expected_version: 0, text: 'more' }, false],
		['APPEND', { text: 'more' }, false],
		// An archived project's refusal names the project.
		['PATCH', { description: 'edit' }, true],
		['APPEND', { text: 'more' }, true]
	] as const)(
		'refuses a key with no authority before %s %j reads the row (archived: %s)',
		async (op, body, archived) => {
			const { t, owner } = fixture();
			await addScopedKey(t);
			const item = await createContextItem(t.db, t.env, owner, {
				kind: 'prompt',
				name: 'private',
				project_id: PROJECT,
				body: 'PRIVATE_PROMPT_CANARY'
			});
			if (archived)
				t.sqlite
					.prepare(`UPDATE project SET name='PRIVATE_PROJECT_CANARY', archived_at=? WHERE id=?`)
					.run(NOW, PROJECT);
			const before = { row: stored(t, item.id), events: eventIds(t) };

			const read = await call(t, GET, { key: KEY }, item.id, 'GET');
			expect(read.status).toBe(404);
			expect(read.text).not.toContain('PRIVATE_PROMPT_CANARY');

			const write =
				op === 'PATCH'
					? await call(t, PATCH, { key: KEY }, item.id, 'PATCH', body)
					: await call(t, APPEND, { key: KEY }, item.id, 'POST', body);
			expect(write.status).toBe(403);
			expect(write.json.error.code).toBe('insufficient_permissions');
			expect(write.text).not.toContain('PRIVATE_PROMPT_CANARY');
			expect(write.text).not.toContain('PRIVATE_PROJECT_CANARY');
			expect(write.text).not.toContain('private');
			expect(write.json.error.details).not.toHaveProperty('current');
			// Nothing written, nothing recorded.
			expect(stored(t, item.id)).toEqual(before.row);
			expect(eventIds(t)).toEqual(before.events);
		}
	);

	it.each([
		['non-secret', false],
		['secret', true]
	] as const)(
		"keeps a %s env value out of a member's stale-version conflict",
		async (_label, secret) => {
			const { t, owner } = fixture();
			const item = await createContextItem(t.db, t.env, owner, {
				kind: 'env',
				name: 'OWNER_CONFIG',
				project_id: PROJECT,
				secret,
				value: 'OWNER_VALUE_CANARY'
			});
			const before = { row: stored(t, item.id), events: eventIds(t) };

			const read = await call(t, GET, { user: BOB }, item.id, 'GET');
			expect(read.status).toBe(200);
			expect(read.text).not.toContain('OWNER_VALUE_CANARY');

			const write = await call(t, PATCH, { user: BOB }, item.id, 'PATCH', {
				expected_version: 0,
				hint: 'harmless edit'
			});
			expect(write.status).toBe(409);
			expect(write.json.error.code).toBe('version_conflict');
			expect(write.text).not.toContain('OWNER_VALUE_CANARY');
			// The conflict's item is the member's own read, field for field.
			expect(write.json.error.details.current).toEqual(read.json);
			expect(write.json.error.details.current).not.toHaveProperty('value');
			expect(write.json.error.details.current).toMatchObject({ secret, value_set: true });
			expect(stored(t, item.id)).toEqual(before.row);
			expect(eventIds(t)).toEqual(before.events);
		}
	);

	it('still gives the owner the current item to rebase on', async () => {
		const { t, owner } = fixture();
		const prompt = await createContextItem(t.db, t.env, owner, {
			kind: 'prompt',
			name: 'house',
			project_id: PROJECT,
			body: 'OWNER_BODY'
		});
		const env = await createContextItem(t.db, t.env, owner, {
			kind: 'env',
			name: 'PUBLIC_CONFIG',
			project_id: PROJECT,
			secret: false,
			value: 'OWNER_VALUE'
		});
		const secret = await createContextItem(t.db, t.env, owner, {
			kind: 'env',
			name: 'SECRET_CONFIG',
			project_id: PROJECT,
			secret: true,
			value: 'SECRET_VALUE_CANARY'
		});

		const patched = await call(t, PATCH, { user: USER }, prompt.id, 'PATCH', {
			expected_version: 0,
			body: 'mine'
		});
		expect(patched.status).toBe(409);
		expect(patched.json.error.details.current).toMatchObject({
			id: prompt.id,
			version: prompt.version,
			body: 'OWNER_BODY'
		});
		expect(patched.json.error.message).toContain(`version ${prompt.version}`);

		const appended = await call(t, APPEND, { user: USER }, prompt.id, 'POST', {
			expected_version: 0,
			text: 'mine'
		});
		expect(appended.status).toBe(409);
		expect(appended.json.error.details.current.body).toBe('OWNER_BODY');

		// The owner reads a non-secret value back; a secret's never leaves the row.
		const publicEnv = await call(t, PATCH, { user: USER }, env.id, 'PATCH', {
			expected_version: 0,
			hint: 'x'
		});
		expect(publicEnv.json.error.details.current.value).toBe('OWNER_VALUE');
		const secretEnv = await call(t, PATCH, { user: USER }, secret.id, 'PATCH', {
			expected_version: 0,
			hint: 'x'
		});
		expect(secretEnv.status).toBe(409);
		expect(secretEnv.json.error.details.current).toMatchObject({ secret: true, value_set: true });
		expect(secretEnv.text).not.toContain('SECRET_VALUE_CANARY');
	});

	it("lands an authorized member's edit without echoing the value", async () => {
		const { t, owner } = fixture();
		const item = await createContextItem(t.db, t.env, owner, {
			kind: 'env',
			name: 'OWNER_CONFIG',
			project_id: PROJECT,
			secret: false,
			value: 'OWNER_VALUE_CANARY'
		});
		const write = await call(t, PATCH, { user: BOB }, item.id, 'PATCH', {
			expected_version: item.version,
			hint: 'set by Bob'
		});
		expect(write.status).toBe(200);
		expect(write.text).not.toContain('OWNER_VALUE_CANARY');
		expect(write.json).toMatchObject({ hint: 'set by Bob', version: item.version + 1 });
		expect(stored(t, item.id)).toMatchObject({
			env_hint: 'set by Bob',
			env_value: 'OWNER_VALUE_CANARY'
		});
		expect(
			t.all("SELECT id FROM event WHERE type='context.updated' AND payload LIKE ?", `%${item.id}%`)
		).toHaveLength(1);
	});

	it.each([
		['non-secret', false],
		['secret', true]
	] as const)(
		"keeps a %s env value out of a member's list, no-op edit and create",
		async (_label, secret) => {
			const { t, owner } = fixture();
			const item = await createContextItem(t.db, t.env, owner, {
				kind: 'env',
				name: 'OWNER_CONFIG',
				project_id: PROJECT,
				secret,
				value: 'OWNER_VALUE_CANARY'
			});
			const before = { row: stored(t, item.id), events: eventIds(t) };
			const read = await call(t, GET, { user: BOB }, item.id, 'GET');
			expect(read.status).toBe(200);

			const listed = await call(t, LIST, { user: BOB }, `?project=${PROJECT}`, 'GET');
			expect(listed.status).toBe(200);
			expect(listed.text).not.toContain('OWNER_VALUE_CANARY');
			expect(listed.json.items).toHaveLength(1);
			expect(listed.json.items[0]).toMatchObject({ id: item.id, secret, value_set: true });
			expect(listed.json.items[0]).not.toHaveProperty('value');

			// An edit that changes nothing returns the item, and it is the member's read.
			for (const body of [{}, { expected_version: item.version }, { hint: null }]) {
				const noop = await call(t, PATCH, { user: BOB }, item.id, 'PATCH', body);
				expect(noop.status, JSON.stringify(body)).toBe(200);
				expect(noop.text).not.toContain('OWNER_VALUE_CANARY');
				expect(noop.json).toEqual(read.json);
			}
			expect(stored(t, item.id)).toEqual(before.row);
			expect(eventIds(t)).toEqual(before.events);

			// A value the member sets is stored, and not read back to them either.
			const created = await call(t, CREATE, { user: BOB }, '?', 'POST', {
				kind: 'env',
				name: 'MEMBER_CONFIG',
				project_id: PROJECT,
				secret,
				value: 'MEMBER_VALUE_CANARY'
			});
			expect(created.status).toBe(201);
			expect(created.text).not.toContain('MEMBER_VALUE_CANARY');
			expect(created.json).toMatchObject({ name: 'MEMBER_CONFIG', secret, value_set: true });
			expect(created.json).not.toHaveProperty('value');
			expect(stored(t, created.json.id).name).toBe('MEMBER_CONFIG');

			// The owner still reads a non-secret value back, from the list too.
			const owned = await call(t, LIST, { user: USER }, `?project=${PROJECT}`, 'GET');
			const values = owned.json.items.map((i: { value?: string }) => i.value);
			expect(values.toSorted()).toEqual(
				secret ? [undefined, undefined] : ['MEMBER_VALUE_CANARY', 'OWNER_VALUE_CANARY']
			);
			expect(owned.text.includes('VALUE_CANARY')).toBe(!secret);
		}
	);

	it.each([
		['an explicit version', true, 1],
		// Last-write-wins retries until it gives up; every attempt loses here.
		['exhausted retries', false, 4]
	] as const)(
		'redacts a conflict found at the commit, with %s',
		async (_label, explicit, attempts) => {
			const { t, owner } = fixture();
			const item = await createContextItem(t.db, t.env, owner, {
				kind: 'env',
				name: 'OWNER_CONFIG',
				project_id: PROJECT,
				secret: false,
				value: 'OWNER_VALUE_CANARY'
			});
			// The owner rewrites the value after the member's reads, before each
			// batch. Two versions at a time: the write's event is guarded on
			// "version = mine + 1", which a single competing bump would satisfy.
			let races = 0;
			const batch = t.env.DB.batch.bind(t.env.DB);
			t.env.DB.batch = ((statements: Parameters<typeof batch>[0]) => {
				races++;
				t.sqlite
					.prepare(
						`UPDATE context_item SET version = version + 2, env_value = 'NEWER_VALUE_CANARY' WHERE id = ?`
					)
					.run(item.id);
				return batch(statements);
			}) as typeof t.env.DB.batch;
			const events = eventIds(t);

			const write = await call(t, PATCH, { user: BOB }, item.id, 'PATCH', {
				...(explicit ? { expected_version: item.version } : {}),
				hint: 'late edit'
			});
			t.env.DB.batch = batch;
			expect(races).toBe(attempts);
			expect(write.status).toBe(409);
			expect(write.json.error.code).toBe('version_conflict');
			expect(write.text).not.toContain('VALUE_CANARY');
			expect(write.json.error.details.current).not.toHaveProperty('value');
			expect(write.json.error.details.current.version).toBe(item.version + 2 * attempts);
			expect(stored(t, item.id).env_hint).toBeNull();
			expect(eventIds(t)).toEqual(events);
		}
	);

	it('answers 404, not a conflict, when the item left the shared project mid-write', async () => {
		const { t, owner } = fixture();
		const item = await createContextItem(t.db, t.env, owner, {
			kind: 'prompt',
			name: 'shared-notes',
			project_id: PROJECT,
			body: 'SHARED_BODY'
		});
		// The owner makes it a global item, with new private text, before the batch.
		beforeNextBatch(t, () =>
			t.sqlite
				.prepare(
					`UPDATE context_item SET version = version + 2, project_id = NULL, body = 'NOW_PRIVATE_CANARY' WHERE id = ?`
				)
				.run(item.id)
		);
		const events = eventIds(t);
		const write = await call(t, APPEND, { user: BOB }, item.id, 'POST', {
			expected_version: item.version,
			text: 'late'
		});
		expect(write.status).toBe(404);
		expect(write.text).not.toContain('NOW_PRIVATE_CANARY');
		expect(stored(t, item.id).body).toBe('NOW_PRIVATE_CANARY');
		expect(eventIds(t)).toEqual(events);
	});
});
