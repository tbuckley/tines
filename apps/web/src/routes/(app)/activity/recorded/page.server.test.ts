import type { TinesEvent } from '@tines/shared';
import { expect, it } from 'vitest';
import { createTestDb } from '$lib/server/api/test-db';
import { getPreferences } from '$lib/server/api/preferences';
import { NOW, PROJECT, USER, seedBase } from '$lib/server/supervisor/test-fixtures';
import { load } from './+page.server';
import { load as activity } from '../+page.server';

function fixture() {
	const t = createTestDb();
	seedBase(t);
	t.sqlite.exec(`
		INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
		VALUES ('foreign', 'bob', 'bob@test', 1, ${NOW}, ${NOW});
		INSERT INTO project (id, user_id, name, created_at, updated_at)
		VALUES ('other', '${USER}', 'Other', ${NOW}, ${NOW});
		INSERT INTO user_preference (user_id, focused_project_id, last_project_id, updated_at)
		VALUES ('${USER}', '${PROJECT}', '${PROJECT}', ${NOW});
	`);
	const insert = t.sqlite.prepare(`INSERT INTO event
		(id, user_id, actor_user_id, type, project_id, payload, created_at)
		VALUES (?, ?, ?, 'settings.updated', ?, '{}', ?)`);
	insert.run('global', USER, USER, null, NOW);
	insert.run('other-project', USER, USER, 'other', NOW);
	insert.run('focused', USER, USER, PROJECT, NOW);
	insert.run('foreign', 'foreign', 'foreign', null, NOW);
	return { t, insert };
}

function event(t: ReturnType<typeof createTestDb>, query: string) {
	return {
		locals: { user: { id: USER } },
		platform: { env: t.env },
		url: new URL(`http://test/activity/recorded${query}`),
		depends: () => {}
	} as unknown as Parameters<typeof load>[0];
}

it('shows only owned selected events across focus, without consuming project or changing preferences', async () => {
	const { t } = fixture();
	const before = await getPreferences(t.db, USER);
	const result = await load(
		event(t, '?event=global&event=other-project&event=foreign&event=missing&project=other')
	);
	expect(result!.events.map((e: TinesEvent) => e.id)).toEqual(['other-project', 'global']);
	expect(await getPreferences(t.db, USER)).toEqual(before);
	const ordinary = await activity(event(t, '') as unknown as Parameters<typeof activity>[0]);
	expect(ordinary!.events.map((e: TinesEvent) => e.id)).toEqual(['focused']);
	expect((await load(event(t, '')))!.events).toEqual([]);
});

it('paginates a large marker without losing IDs or widening its scope', async () => {
	const { t, insert } = fixture();
	const ids = Array.from({ length: 120 }, (_, i) => `selected-${i}`);
	for (const [i, id] of ids.entries()) insert.run(id, USER, USER, null, NOW + i);
	let query = `?${new URLSearchParams(ids.map((id) => ['event', id]))}`;
	const found: string[] = [];
	for (;;) {
		const result = (await load(event(t, query)))!;
		found.push(...result.events.map((e: TinesEvent) => e.id));
		if (!result.nextHref) break;
		query = new URL(result.nextHref, 'http://test').search;
	}
	expect(found).toEqual([...ids].reverse());
});
