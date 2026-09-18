/**
 * Route-level filter wiring. `listContextItems` supports every dimension,
 * but the only thing joining `tines context list --label` to it is the
 * `params.get(…)` list in this handler — a filter left out of that list is
 * silently ignored (the list comes back unfiltered), and no unit test of the
 * query function can see it.
 */
import { describe, expect, it } from 'vitest';
import { createContextItem, listContextItems } from '$lib/server/api/context';
import type { ActorContext } from '$lib/server/api/core';
import { createTestDb } from '$lib/server/api/test-db';
import { addLabel, seedBase, USER } from '$lib/server/supervisor/test-fixtures';
import { GET } from './+server';

const actor: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

async function list(t: ReturnType<typeof createTestDb>, query: string) {
	const url = new URL(`http://test/api/v1/context${query}`);
	const event = {
		locals: { user: { id: USER, name: 'alice' } },
		platform: { env: t.env, ctx: { waitUntil: () => {} } },
		request: new Request(url, { method: 'GET' }),
		url
	};
	const res = await GET(event as unknown as Parameters<typeof GET>[0]);
	return (await res.json()) as { items: { id: string; name: string }[] };
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
