import { beforeEach, describe, expect, it } from 'vitest';
import { addIssue, PROJECT, seedBase, USER } from '../supervisor/test-fixtures';
import { createIssue } from './issues';
import { createTestDb, type TestDb } from './test-db';
import { recordDispatchEffects, TEST_NOOP_DISPATCH_EFFECTS } from './test-dispatch-effects';
import type { ActorContext } from './core';
import { listArtifacts } from './artifacts';
import { runScheduleNow } from './schedules';

const actor: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

describe('createIssue with initial relationships', () => {
	let t: TestDb;
	let blocker: string;
	let blocked: string;
	let canonical: string;

	beforeEach(() => {
		t = createTestDb();
		seedBase(t);
		blocker = addIssue(t, { id: 'iss_blocker', title: 'Blocker' });
		blocked = addIssue(t, { id: 'iss_blocked', title: 'Blocked' });
		canonical = addIssue(t, { id: 'iss_canonical', title: 'Canonical' });
	});

	it('keeps the no-link query path identical for absent fields and explicit empty arrays', async () => {
		const capture = async (relationships: { blocked_by?: string[]; blocks?: string[] }) => {
			const db = createTestDb();
			seedBase(db);
			const queries = db.spyOnQueries();
			await createIssue(db.db, db.env, actor, TEST_NOOP_DISPATCH_EFFECTS, PROJECT, {
				title: 'Plain',
				...relationships
			});
			return queries();
		};
		expect(await capture({ blocked_by: [], blocks: [] })).toEqual(await capture({}));
	});

	it('atomically creates all orientations, events, response links, and one dispatch', async () => {
		const effects = recordDispatchEffects();
		const created = await createIssue(t.db, t.env, actor, effects, PROJECT, {
			title: 'Linked from birth',
			blocked_by: [blocker],
			blocks: [blocked],
			duplicate_of: canonical
		});

		expect(created.links.blocked_by.map((link) => link.issue_id)).toEqual([blocker]);
		expect(created.links.blocks.map((link) => link.issue_id)).toEqual([blocked]);
		expect(created.links.duplicate_of?.issue_id).toBe(canonical);
		expect(effects.count()).toBe(1);
		expect(
			t.all('SELECT source_issue_id, target_issue_id, kind FROM issue_link ORDER BY created_at, id')
		).toEqual(
			expect.arrayContaining([
				{ source_issue_id: blocker, target_issue_id: created.id, kind: 'blocks' },
				{ source_issue_id: created.id, target_issue_id: blocked, kind: 'blocks' },
				{ source_issue_id: created.id, target_issue_id: canonical, kind: 'duplicate_of' }
			])
		);
		const events = t.all(
			"SELECT issue_id, payload FROM event WHERE type = 'issue.link_added' ORDER BY id"
		);
		expect(events).toHaveLength(6);
		for (const row of events) {
			const payload = JSON.parse(row.payload as string) as Record<string, unknown>;
			expect(payload).toMatchObject({
				link_id: expect.stringMatching(/^lnk_/),
				kind: expect.stringMatching(/^(blocks|duplicate_of)$/),
				role: expect.stringMatching(/^(source|target)$/),
				other_issue_id: expect.any(String),
				other_project_name: 'demo',
				other_number: expect.any(Number),
				other_title: expect.any(String)
			});
		}
	});

	it('rejects a repeated edge and leaves every create-owned row absent', async () => {
		const before = Object.fromEntries(
			['issue', 'issue_address', 'issue_link', 'event'].map((table) => [
				table,
				t.all(`SELECT * FROM ${table}`).length
			])
		);
		await expect(
			createIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, PROJECT, {
				title: 'Rejected duplicate edge',
				blocks: [blocked, blocked]
			})
		).rejects.toMatchObject({ status: 409, code: 'conflict' });
		for (const [table, count] of Object.entries(before)) {
			expect(t.all(`SELECT * FROM ${table}`), table).toHaveLength(count);
		}
	});

	it('rejects a cycle formed only by requested edges and rolls the issue back', async () => {
		await expect(
			createIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, PROJECT, {
				title: 'Rejected cycle',
				blocked_by: [blocker],
				blocks: [blocker]
			})
		).rejects.toMatchObject({ status: 422, code: 'link_cycle' });
		expect(t.all("SELECT id FROM issue WHERE title = 'Rejected cycle'")).toEqual([]);
		expect(t.all('SELECT id FROM issue_link')).toEqual([]);
		expect(
			t.all("SELECT id FROM event WHERE type IN ('issue.created', 'issue.link_added')")
		).toEqual([]);
	});

	it('validates malformed and inaccessible endpoints before the create batch', async () => {
		await expect(
			createIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, PROJECT, {
				title: 'Bad shape',
				blocked_by: null as unknown as string[]
			})
		).rejects.toMatchObject({ status: 422, code: 'invalid_field' });
		await expect(
			createIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, PROJECT, {
				title: 'Unknown endpoint',
				blocks: ['iss_missing']
			})
		).rejects.toMatchObject({ status: 404, code: 'not_found' });
		expect(t.all("SELECT id FROM issue WHERE title IN ('Bad shape', 'Unknown endpoint')")).toEqual(
			[]
		);
	});

	it('composes relationships with recurrence, labels, and initial files without copying links', async () => {
		const created = await createIssue(
			t.db,
			t.env,
			actor,
			TEST_NOOP_DISPATCH_EFFECTS,
			PROJECT,
			{
				title: 'Daily linked context',
				blocked_by: [blocker],
				labels: ['reference'],
				schedule: { preset: { kind: 'daily', time: '09:00' } }
			},
			[
				{
					name: 'notes',
					filename: 'notes.txt',
					contentType: 'text/plain',
					body: new Blob(['context'])
				}
			]
		);
		expect(created.schedule).toBeDefined();
		expect(created.labels.map((label) => label.name)).toEqual(['reference']);
		expect(created.links.blocked_by.map((link) => link.issue_id)).toEqual([blocker]);
		expect(await listArtifacts(t.db, USER, created.id)).toHaveLength(1);

		const nextId = await runScheduleNow(
			t.db,
			t.env,
			actor,
			TEST_NOOP_DISPATCH_EFFECTS,
			created.schedule!.id
		);
		expect(
			t.all(
				'SELECT id FROM issue_link WHERE source_issue_id = ? OR target_issue_id = ?',
				nextId,
				nextId
			)
		).toEqual([]);
	});
});
