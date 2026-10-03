/**
 * Route-level filter wiring. `listContextItems` supports every dimension,
 * but the only thing joining `tines context list --label` to it is the
 * `params.get(…)` list in this handler — a filter left out of that list is
 * silently ignored (the list comes back unfiltered), and no unit test of the
 * query function can see it.
 */
import { describe, expect, it, vi } from 'vitest';
import { createContextItem, listContextItems } from '$lib/server/api/context';
import type { ActorContext } from '$lib/server/api/core';
import { createTestDb } from '$lib/server/api/test-db';
import { actorForProject } from '$lib/server/api/project-access';
import {
	addIssue,
	addLabel,
	NOW,
	OPEN,
	PROJECT,
	seedBase,
	USER
} from '$lib/server/supervisor/test-fixtures';

// Lets a test land a write after a delegated member list has read its rows
// and before the membership re-check that decides whether they are returned.
const hooks = vi.hoisted(() => ({ afterMemberList: null as null | (() => void) }));
vi.mock('$lib/server/api/context', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/api/context')>();
	return {
		...real,
		listContextItems: async (...args: Parameters<typeof real.listContextItems>) => {
			const result = await real.listContextItems(...args);
			if (typeof args[1] !== 'string' && args[1].member) hooks.afterMemberList?.();
			return result;
		}
	};
});

import { GET } from './+server';

const actor: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

type Listed = { id: string; name: string; kind: string; value?: string; value_set?: boolean };

async function get(
	t: ReturnType<typeof createTestDb>,
	query: string,
	user: { id: string; name: string } = { id: USER, name: 'alice' }
) {
	const url = new URL(`http://test/api/v1/context${query}`);
	const event = {
		locals: { user },
		platform: { env: t.env, ctx: { waitUntil: () => {} } },
		request: new Request(url, { method: 'GET' }),
		url
	};
	return GET(event as unknown as Parameters<typeof GET>[0]);
}

async function list(...args: Parameters<typeof get>) {
	const res = await get(...args);
	return (await res.json()) as { items: Listed[]; next_cursor: string | null };
}

const BOB = { id: 'u2', name: 'Bob' };
const bob: ActorContext = { ...actor, userId: 'u2', userName: 'Bob' };

/**
 * Alice shares PROJECT with Bob. Alice's account holds the shared project's
 * own items plus three that are never a member's to see (a global prompt, a
 * state-only prompt and a prompt in her unshared project); Bob holds one
 * global prompt of his own and one he created in the shared project.
 * `updated_at` interleaves the two accounts so a merged order is visible.
 */
async function sharedSetup() {
	const t = createTestDb();
	seedBase(t);
	t.sqlite.exec(`
		INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt)
		VALUES ('u2','Bob','bob@example.com',1,${NOW},${NOW});
		UPDATE project SET shared_at = ${NOW}, sharing_revision = 1 WHERE id = '${PROJECT}';
		INSERT INTO project_member (project_id,user_id,revision,joined_at,updated_at)
		VALUES ('${PROJECT}','u2',1,${NOW},${NOW});
		INSERT INTO project (id, user_id, name, created_at, updated_at)
		VALUES ('prj_private', '${USER}', 'private', ${NOW}, ${NOW});
	`);
	const issueId = addIssue(t, {});
	const prompt = (name: string, scope: Record<string, string> = {}) => ({
		kind: 'prompt' as const,
		name,
		body: `${name} body`,
		...scope
	});
	await createContextItem(t.db, t.env, actor, prompt('GLOBAL_CANARY'));
	await createContextItem(t.db, t.env, actor, prompt('STATE_CANARY', { workflow_state_id: OPEN }));
	await createContextItem(
		t.db,
		t.env,
		actor,
		prompt('PRIVATE_CANARY', { project_id: 'prj_private' })
	);
	await createContextItem(t.db, t.env, actor, prompt('owner-project', { project_id: PROJECT }));
	await createContextItem(t.db, t.env, actor, prompt('owner-issue', { issue_id: issueId }));
	await createContextItem(t.db, t.env, actor, {
		kind: 'env',
		name: 'SHARED_ENV',
		value: 'ENV_VALUE_CANARY',
		project_id: PROJECT
	});
	await createContextItem(t.db, t.env, bob, prompt('bob-own'));
	const delegated = await actorForProject(t.db, bob, PROJECT);
	await createContextItem(t.db, t.env, delegated, prompt('bob-shared', { project_id: PROJECT }));
	const order = ['owner-issue', 'bob-own', 'SHARED_ENV', 'bob-shared', 'owner-project'];
	const stamp = t.sqlite.prepare(`UPDATE context_item SET updated_at = ? WHERE name = ?`);
	order.forEach((name, i) => stamp.run(NOW + (order.length - i) * 1000, name));
	return { t, order };
}

const CANARIES = ['GLOBAL_CANARY', 'STATE_CANARY', 'PRIVATE_CANARY', 'ENV_VALUE_CANARY'];
function expectNoCanary(body: unknown) {
	for (const canary of CANARIES) expect(JSON.stringify(body)).not.toContain(canary);
}

describe('GET /api/v1/context', () => {
	it('narrows by label, by id and by name', async () => {
		const t = createTestDb();
		seedBase(t);
		const docs = addLabel(t, 'docs');
		const scoped = await createContextItem(t.db, t.env, actor, {
			kind: 'prompt',
			name: 'docs-checklist',
			label_id: docs,
			body: 'Check the docs.'
		});
		await createContextItem(t.db, t.env, actor, {
			kind: 'prompt',
			name: 'house',
			body: 'House rules.'
		});
		// Both exist, so a filter that returns both is doing nothing.
		expect(
			(await listContextItems(t.db, USER, {}, { cursor: null, limit: 50 })).items
		).toHaveLength(2);

		for (const ref of [docs, 'docs']) {
			const { items } = await list(t, `?label=${encodeURIComponent(ref)}`);
			expect(
				items.map((i) => i.id),
				`label=${ref}`
			).toEqual([scoped.id]);
		}
		// No filter: the unscoped item is still reachable.
		expect((await list(t, '')).items).toHaveLength(2);
	});
});

describe('GET /api/v1/context for a member of a shared project', () => {
	it('lists the member own items and the shared project items together, newest first', async () => {
		const { t, order } = await sharedSetup();
		const body = await list(t, '', BOB);
		expect(body.items.map((i) => i.name)).toEqual(order);
		expectNoCanary(body);
		const env = body.items.find((i) => i.kind === 'env')!;
		expect(env.value_set).toBe(true);
		expect(env).not.toHaveProperty('value');
	});

	it('pages the merged list with next_cursor, with no gaps or repeats', async () => {
		const { t, order } = await sharedSetup();
		const names: string[] = [];
		let query = '?limit=2';
		for (let pages = 0; pages < 5; pages++) {
			const body = await list(t, query, BOB);
			names.push(...body.items.map((i) => i.name));
			expectNoCanary(body);
			if (!body.next_cursor) break;
			expect(body.items).toHaveLength(2);
			query = `?limit=2&cursor=${encodeURIComponent(body.next_cursor)}`;
		}
		expect(names).toEqual(order);
	});

	// Own rows and shared rows each fit one page; only their sum overflows it,
	// so neither source reports more and the merge alone must.
	it('pages on when only the merged total exceeds the limit', async () => {
		const { t, order } = await sharedSetup();
		const first = await list(t, '?limit=4', BOB);
		expect(first.items.map((i) => i.name)).toEqual(order.slice(0, 4));
		expect(first.next_cursor).not.toBeNull();
		const rest = await list(t, `?limit=4&cursor=${encodeURIComponent(first.next_cursor!)}`, BOB);
		expect(rest.items.map((i) => i.name)).toEqual(order.slice(4));
		expect(rest.next_cursor).toBeNull();
	});

	it('narrows the shared project items by kind', async () => {
		const { t, order } = await sharedSetup();
		const body = await list(t, '?kind=prompt', BOB);
		expect(body.items.map((i) => i.name)).toEqual(order.filter((name) => name !== 'SHARED_ENV'));
	});

	it('narrows the shared project items by q', async () => {
		const { t } = await sharedSetup();
		const body = await list(t, '?q=owner-proj', BOB);
		expect(body.items.map((i) => i.name)).toEqual(['owner-project']);
	});

	it('lists an archived shared project only under archived=true', async () => {
		const { t, order } = await sharedSetup();
		t.sqlite.exec(`UPDATE project SET archived_at = ${NOW} WHERE id = '${PROJECT}'`);
		expect((await list(t, '', BOB)).items.map((i) => i.name)).toEqual(['bob-own']);
		const archived = await list(t, '?archived=true', BOB);
		expect(archived.items.map((i) => i.name)).toEqual(order.filter((name) => name !== 'bob-own'));
		expectNoCanary(archived);
	});

	it('keeps issue=<id> to that issue own items', async () => {
		const { t } = await sharedSetup();
		const { issue_id } = t.sqlite
			.prepare(`SELECT issue_id FROM context_item WHERE name = 'owner-issue'`)
			.get() as { issue_id: string };
		const body = await list(t, `?issue=${issue_id}`, BOB);
		expect(body.items.map((i) => i.name)).toEqual(['owner-issue']);
	});

	it('answers 409 ambiguous_project when a name matches an own and a shared project', async () => {
		const { t } = await sharedSetup();
		t.sqlite.exec(`
			INSERT INTO project (id, user_id, name, created_at, updated_at)
			SELECT 'prj_bob', 'u2', name, ${NOW}, ${NOW} FROM project WHERE id = '${PROJECT}';
		`);
		const res = await get(t, '?project=demo', BOB);
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ error: { code: 'ambiguous_project' } });
		// The immutable id still names exactly one of them.
		const byId = await list(t, `?project=${PROJECT}`, BOB);
		expect(byId.items.map((i) => i.name)).toEqual(['SHARED_ENV', 'bob-shared', 'owner-project']);
	});

	it('keeps exact=true to the member own global items', async () => {
		const { t } = await sharedSetup();
		const body = await list(t, '?exact=true', BOB);
		expect(body.items.map((i) => i.name)).toEqual(['bob-own']);
	});

	it('resolves a shared project named by name or by id', async () => {
		const { t } = await sharedSetup();
		const name = (
			t.sqlite.prepare(`SELECT name FROM project WHERE id = ?`).get(PROJECT) as {
				name: string;
			}
		).name;
		for (const ref of [name, PROJECT]) {
			const body = await list(t, `?project=${encodeURIComponent(ref)}`, BOB);
			expect(
				body.items.map((i) => i.name),
				`project=${ref}`
			).toEqual(['SHARED_ENV', 'bob-shared', 'owner-project']);
			expectNoCanary(body);
		}
		// The owner's unshared project stays out of reach by either ref.
		for (const ref of ['private', 'prj_private'])
			expect((await list(t, `?project=${ref}`, BOB)).items, `project=${ref}`).toEqual([]);
	});

	it('returns only own items once the membership is revoked', async () => {
		const { t } = await sharedSetup();
		t.sqlite.exec(`UPDATE project_member SET revoked_at = ${NOW} WHERE user_id = 'u2'`);
		const body = await list(t, '', BOB);
		expect(body.items.map((i) => i.name)).toEqual(['bob-own']);
	});

	it('drops a shared project whose membership is removed while its list is read', async () => {
		const { t } = await sharedSetup();
		let removed = 0;
		hooks.afterMemberList = () => {
			removed += 1;
			t.sqlite.exec(`UPDATE project_member SET revoked_at = ${NOW} WHERE user_id = 'u2'`);
		};
		try {
			const body = await list(t, '', BOB);
			expect(body.items.map((i) => i.name)).toEqual(['bob-own']);
		} finally {
			hooks.afterMemberList = null;
		}
		// The rows were read (the hook ran) and then discarded.
		expect(removed).toBe(1);
	});

	it('leaves the owner list as it was: the whole account, nothing added', async () => {
		const { t } = await sharedSetup();
		const body = await list(t, '');
		expect(body.items.map((i) => i.name).sort()).toEqual(
			[
				'GLOBAL_CANARY',
				'PRIVATE_CANARY',
				'SHARED_ENV',
				'STATE_CANARY',
				'bob-shared',
				'owner-issue',
				'owner-project'
			].sort()
		);
	});
});
