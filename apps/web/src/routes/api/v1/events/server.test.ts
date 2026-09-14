import { describe, expect, it } from 'vitest';
import { createTestDb } from '$lib/server/api/test-db';
import {
	addIssue,
	addTransitionEvent,
	NOW,
	OPEN,
	REVIEW,
	seedBase,
	USER
} from '$lib/server/supervisor/test-fixtures';
import { GET } from './+server';

async function list(t: ReturnType<typeof createTestDb>, query: string) {
	const url = new URL(`http://test/api/v1/events${query}`);
	const event = {
		locals: { user: { id: USER, name: 'alice' } },
		platform: { env: t.env, ctx: { waitUntil: () => {} } },
		request: new Request(url, { method: 'GET' }),
		url
	};
	const response = await GET(event as unknown as Parameters<typeof GET>[0]);
	expect(response.status).toBe(200);
	return (await response.json()) as {
		items: { id: string; created_at: number }[];
		next_cursor: string | null;
	};
}

async function walk(t: ReturnType<typeof createTestDb>, query: URLSearchParams) {
	const ids: string[] = [];
	const cursors: (string | null)[] = [];
	let cursor: string | null = null;
	do {
		const pageQuery = new URLSearchParams(query);
		if (cursor) pageQuery.set('cursor', cursor);
		const page = await list(t, `?${pageQuery}`);
		ids.push(...page.items.map((item) => item.id));
		cursor = page.next_cursor;
		cursors.push(cursor);
	} while (cursor);
	return { ids, cursors };
}

describe('GET /api/v1/events window filters', () => {
	it('combines inclusive since, exclusive until and payload state', async () => {
		const t = createTestDb();
		seedBase(t);
		const issue = addIssue(t);
		addTransitionEvent(t, {
			issueId: issue,
			apiKeyId: null,
			at: NOW - 3000,
			from: OPEN,
			to: REVIEW
		});
		addTransitionEvent(t, {
			issueId: issue,
			apiKeyId: null,
			at: NOW - 2000,
			from: REVIEW,
			to: OPEN
		});
		addTransitionEvent(t, {
			issueId: issue,
			apiKeyId: null,
			at: NOW - 1000,
			from: REVIEW,
			to: OPEN
		});

		addTransitionEvent(t, { issueId: issue, apiKeyId: null, at: NOW - 1500, from: OPEN, to: OPEN });
		const { items } = await list(
			t,
			`?since=${NOW - 2000}&until=${NOW - 1000}&state=${encodeURIComponent(REVIEW)}&type=issue.transitioned,issue.created`
		);
		expect(items.map((item) => item.created_at)).toEqual([NOW - 2000]);
	});
});

describe('GET /api/v1/events scoped pagination', () => {
	it('filters before paging across a global table above 10000 rows', async () => {
		const t = createTestDb();
		seedBase(t);
		t.sqlite.exec(`
			INSERT INTO project (id, user_id, name, created_at, updated_at)
			VALUES
				('prj_selected', '${USER}', 'selected', ${NOW}, ${NOW}),
				('prj_other', '${USER}', 'other', ${NOW}, ${NOW});
			INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
			VALUES ('u2', 'bob', 'b@example.com', 1, ${NOW}, ${NOW});
			INSERT INTO project (id, user_id, name, created_at, updated_at)
			VALUES ('prj_foreign', 'u2', 'selected', ${NOW}, ${NOW});
		`);
		const selectedIssue = addIssue(t, { id: 'iss_selected', project: 'prj_selected' });
		const otherIssue = addIssue(t, { id: 'iss_other', project: 'prj_other' });
		const foreignIssue = addIssue(t, { id: 'iss_foreign', project: 'prj_foreign' });
		const insert = t.sqlite.prepare(`
			INSERT INTO event
				(id, user_id, type, actor_user_id, actor_api_key_id, issue_id, project_id, payload, created_at)
			VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)
		`);

		t.sqlite.exec('BEGIN');
		try {
			for (let i = 0; i < 10_001; i++) {
				insert.run(
					`evt_bulk_${String(i).padStart(5, '0')}`,
					USER,
					'bulk',
					USER,
					otherIssue,
					'prj_other',
					'{}',
					NOW
				);
			}
			for (let i = 0; i < 7; i++) {
				insert.run(
					`evt_selected_0${i}`,
					USER,
					i % 2 === 0 ? 'chosen' : 'other-type',
					USER,
					i < 4 ? selectedIssue : null,
					'prj_selected',
					JSON.stringify({ state_id: i % 2 === 0 ? REVIEW : OPEN }),
					NOW
				);
			}
			insert.run(
				'evt_foreign',
				'u2',
				'chosen',
				'u2',
				foreignIssue,
				'prj_foreign',
				JSON.stringify({ state_id: REVIEW }),
				NOW
			);
			t.sqlite.exec('COMMIT');
		} catch (error) {
			t.sqlite.exec('ROLLBACK');
			throw error;
		}

		expect(t.all('SELECT id FROM event')).toHaveLength(10_009);
		const expected = Array.from({ length: 7 }, (_, i) => `evt_selected_0${6 - i}`);
		for (const project of ['selected', 'prj_selected']) {
			const result = await walk(t, new URLSearchParams({ project, limit: '3' }));
			expect(result.ids).toEqual(expected);
			expect(new Set(result.ids).size).toBe(expected.length);
			expect(result.cursors.slice(0, -1).every(Boolean)).toBe(true);
			expect(result.cursors.at(-1)).toBeNull();
		}

		const issueOnly = await walk(t, new URLSearchParams({ issue: selectedIssue, limit: '2' }));
		expect(issueOnly.ids).toEqual(expected.slice(3));
		expect(issueOnly.cursors).toHaveLength(2);

		const combined = await walk(
			t,
			new URLSearchParams({ issue: selectedIssue, project: 'selected', limit: '2' })
		);
		expect(combined.ids).toEqual(expected.slice(3));
		const mismatch = await list(t, `?issue=${selectedIssue}&project=prj_other&limit=2`);
		expect(mismatch).toEqual({ items: [], next_cursor: null });

		const composed = await walk(
			t,
			new URLSearchParams({
				project: 'selected',
				type: 'chosen',
				state: REVIEW,
				limit: '2'
			})
		);
		expect(composed.ids).toEqual([
			'evt_selected_06',
			'evt_selected_04',
			'evt_selected_02',
			'evt_selected_00'
		]);
		expect(composed.cursors).toHaveLength(2);

		expect((await list(t, '?project=prj_foreign&limit=2')).items).toEqual([]);
		expect((await list(t, `?issue=${foreignIssue}&limit=2`)).items).toEqual([]);
	});
});
