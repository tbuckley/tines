import { compareLabelNames, defaultLabelColor, LABEL_COLORS } from '@tines/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { PROJECT, USER, addIssue, seedBase } from '../supervisor/test-fixtures';
import { ApiFail, isControlPlanePath, runAtomic, type ActorContext } from './core';
import { listIssues } from './issues';
import {
	addIssueLabels,
	createLabel,
	issueLabelInserts,
	labelInserts,
	deleteLabel,
	listLabels,
	normalizeLabelName,
	removeIssueLabel,
	resolveOrCreateLabels,
	updateLabel
} from './labels';
import { createTestDb, type TestDb } from './test-db';

const human: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

/**
 * A run key: same user, bound to an agent run — the fenced actor. The key id
 * is left null so events do not need a seeded `api_key` row; every rule under
 * test keys off `agentRunId` alone.
 */
const runKey: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: false,
	agentRunId: 'arun_1'
};

let t: TestDb;
beforeEach(() => {
	t = createTestDb();
	seedBase(t);
});

const names = async () => (await listLabels(t.db, USER)).map((l) => l.name);

describe('normalizeLabelName', () => {
	it('trims and accepts ordinary names', () => {
		expect(normalizeLabelName('  bug  ')).toBe('bug');
		expect(normalizeLabelName('needs design!')).toBe('needs design!');
	});

	it('rejects empty, overlong, control-char, and leading-dash names', () => {
		for (const bad of ['', '   ', 'x'.repeat(51), 'a\nb', '-negated']) {
			expect(() => normalizeLabelName(bad)).toThrowError(ApiFail);
		}
	});

	it('reports the real cap however long the name is', () => {
		for (const long of ['x'.repeat(51), 'x'.repeat(5000)]) {
			expect(() => normalizeLabelName(long)).toThrowError('at most 50 characters');
		}
	});
});

describe('defaultLabelColor', () => {
	it('is deterministic and always a palette key', () => {
		expect(defaultLabelColor('bug')).toBe(defaultLabelColor('bug'));
		// Case-insensitive, so "Bug" and "bug" never disagree visually.
		expect(defaultLabelColor('Bug')).toBe(defaultLabelColor('bug'));
		for (const n of ['bug', 'p1', 'chore', 'infra', 'ux']) {
			expect(LABEL_COLORS).toContain(defaultLabelColor(n));
		}
	});
});

describe('the label library', () => {
	it('creates a label with a derived color and lists it with usage', async () => {
		const label = await createLabel(t.db, t.env, human, { name: 'bug' });
		expect(label.color).toBe(defaultLabelColor('bug'));
		expect(await listLabels(t.db, USER)).toEqual([
			expect.objectContaining({ name: 'bug', issue_count: 0 })
		]);
	});

	it('rejects a duplicate name case-insensitively', async () => {
		await createLabel(t.db, t.env, human, { name: 'bug' });
		await expect(createLabel(t.db, t.env, human, { name: 'BUG' })).rejects.toMatchObject({
			status: 409,
			code: 'conflict'
		});
	});

	it('rejects a color outside the palette', async () => {
		await expect(
			createLabel(t.db, t.env, human, { name: 'bug', color: 'hotpink' as never })
		).rejects.toMatchObject({ status: 422, code: 'invalid_field' });
	});

	it('renames, and allows a pure case change onto itself', async () => {
		const label = await createLabel(t.db, t.env, human, { name: 'bug' });
		const renamed = await updateLabel(t.db, t.env, human, label.id, { name: 'Bug' });
		expect(renamed.name).toBe('Bug');
		expect(await names()).toEqual(['Bug']);
	});

	it('refuses a rename onto another existing label', async () => {
		await createLabel(t.db, t.env, human, { name: 'bug' });
		const chore = await createLabel(t.db, t.env, human, { name: 'chore' });
		await expect(updateLabel(t.db, t.env, human, chore.id, { name: 'bug' })).rejects.toMatchObject({
			status: 409
		});
	});

	it('resolves a label by name as well as by id', async () => {
		const label = await createLabel(t.db, t.env, human, { name: 'bug' });
		const updated = await updateLabel(t.db, t.env, human, 'BUG', { color: 'teal' });
		expect(updated.id).toBe(label.id);
		expect(updated.color).toBe('teal');
	});

	it('deletes an in-use label, detaching it and reporting the count', async () => {
		const issue = addIssue(t, { title: 'a' });
		await addIssueLabels(t.db, t.env, human, issue, ['bug']);
		const res = await deleteLabel(t.db, t.env, human, 'bug');
		expect(res).toEqual({ deleted: true, issue_count: 1 });
		expect(await names()).toEqual([]);
		const { items } = await listIssues(t.db, USER, {}, { cursor: null, limit: 10 });
		expect(items[0].labels).toEqual([]);
	});

	it('404s on an unknown label', async () => {
		await expect(deleteLabel(t.db, t.env, human, 'nope')).rejects.toMatchObject({ status: 404 });
	});
});

describe('label order', () => {
	// The client sorts optimistic chips itself; it may only do that if its
	// comparator agrees with what SQLite's `COLLATE NOCASE` actually returns.
	it('matches what the server reads back for accented and mixed-case names', async () => {
		const inputs = ['zeta', 'éclair', 'Bug', 'apple'];
		for (const name of inputs) await createLabel(t.db, t.env, human, { name });
		expect(await names()).toEqual([...inputs].sort(compareLabelNames));
	});
});

describe('applying labels to an issue', () => {
	it('creates unknown labels for a human and attaches them', async () => {
		const issue = addIssue(t, { title: 'a' });
		const res = await addIssueLabels(t.db, t.env, human, issue, ['bug', 'p1']);
		expect(res.added.map((l) => l.name)).toEqual(['bug', 'p1']);
		expect(res.created.map((l) => l.name)).toEqual(['bug', 'p1']);
		expect(res.labels.map((l) => l.name)).toEqual(['bug', 'p1']);
	});

	it('is idempotent: re-adding attaches nothing and does not error', async () => {
		const issue = addIssue(t, { title: 'a' });
		await addIssueLabels(t.db, t.env, human, issue, ['bug']);
		const again = await addIssueLabels(t.db, t.env, human, issue, ['BUG']);
		expect(again.added).toEqual([]);
		expect(again.created).toEqual([]);
		expect(again.labels.map((l) => l.name)).toEqual(['bug']);
	});

	it('dedupes within one request', async () => {
		const issue = addIssue(t, { title: 'a' });
		const res = await addIssueLabels(t.db, t.env, human, issue, ['bug', 'Bug']);
		expect(res.added).toHaveLength(1);
	});

	it('accepts a Project/N reference as well as an id', async () => {
		const id = addIssue(t, { title: 'a' });
		const { number } = t.sqlite.prepare('SELECT number FROM issue WHERE id = ?').get(id) as {
			number: number;
		};
		const res = await addIssueLabels(t.db, t.env, human, `demo/${number}`, ['bug']);
		expect(res.labels.map((l) => l.name)).toEqual(['bug']);
	});

	it('404s on an unknown issue', async () => {
		await expect(addIssueLabels(t.db, t.env, human, 'iss_nope', ['bug'])).rejects.toMatchObject({
			status: 404
		});
	});

	it('removes a label by name, and 404s when it is not attached', async () => {
		const issue = addIssue(t, { title: 'a' });
		await addIssueLabels(t.db, t.env, human, issue, ['bug', 'p1']);
		await removeIssueLabel(t.db, t.env, human, issue, 'BUG');
		const { items } = await listIssues(t.db, USER, {}, { cursor: null, limit: 10 });
		expect(items[0].labels.map((l) => l.name)).toEqual(['p1']);
		await expect(removeIssueLabel(t.db, t.env, human, issue, 'bug')).rejects.toMatchObject({
			status: 404,
			code: 'label_not_on_issue'
		});
	});
});

describe('the run-key vocabulary fence', () => {
	it('lets a run key apply a label that already exists', async () => {
		const issue = addIssue(t, { title: 'a' });
		await createLabel(t.db, t.env, human, { name: 'bug' });
		const res = await addIssueLabels(t.db, t.env, runKey, issue, ['BUG']);
		expect(res.added.map((l) => l.name)).toEqual(['bug']);
		expect(res.created).toEqual([]);
	});

	it('422s on an unknown label, listing it and the known vocabulary', async () => {
		const issue = addIssue(t, { title: 'a' });
		await createLabel(t.db, t.env, human, { name: 'bug' });
		await expect(
			addIssueLabels(t.db, t.env, runKey, issue, ['bug', 'invented'])
		).rejects.toMatchObject({
			status: 422,
			code: 'unknown_label',
			details: { unknown: ['invented'], known_labels: [{ name: 'bug' }] }
		});
	});

	it('applies nothing at all when any name is unknown', async () => {
		const issue = addIssue(t, { title: 'a' });
		await createLabel(t.db, t.env, human, { name: 'bug' });
		await addIssueLabels(t.db, t.env, runKey, issue, ['invented']).catch(() => {});
		const { items } = await listIssues(t.db, USER, {}, { cursor: null, limit: 10 });
		expect(items[0].labels).toEqual([]);
		expect(await names()).toEqual(['bug']);
	});

	it('does not create labels for a run key even when resolving alone', async () => {
		await expect(resolveOrCreateLabels(t.db, runKey, ['fresh'])).rejects.toMatchObject({
			status: 422,
			code: 'unknown_label'
		});
		expect(await names()).toEqual([]);
	});

	it('fences the library but not label application', () => {
		expect(isControlPlanePath('/api/v1/labels')).toBe(true);
		expect(isControlPlanePath('/api/v1/labels/lbl_1')).toBe(true);
		expect(isControlPlanePath('/api/v1/issues/iss_1/labels')).toBe(false);
		expect(isControlPlanePath('/api/v1/issues/iss_1/labels/bug')).toBe(false);
	});
});

describe('reading and filtering by label', () => {
	let ids: Record<string, string>;
	beforeEach(async () => {
		ids = {
			both: addIssue(t, { title: 'both' }),
			bugOnly: addIssue(t, { title: 'bug only' }),
			none: addIssue(t, { title: 'none' })
		};
		await addIssueLabels(t.db, t.env, human, ids.both, ['bug', 'p1']);
		await addIssueLabels(t.db, t.env, human, ids.bugOnly, ['bug']);
	});

	const search = async (labels?: string[]) =>
		(await listIssues(t.db, USER, { labels }, { cursor: null, limit: 50 })).items;

	it('rides along on every read, ordered by name', async () => {
		const items = await search();
		const both = items.find((i) => i.id === ids.both)!;
		expect(both.labels.map((l) => l.name)).toEqual(['bug', 'p1']);
		expect(items.find((i) => i.id === ids.none)!.labels).toEqual([]);
	});

	it('narrows on one label', async () => {
		expect((await search(['bug'])).map((i) => i.id).sort()).toEqual([ids.both, ids.bugOnly].sort());
	});

	it('ANDs repeated labels rather than widening', async () => {
		expect((await search(['bug', 'p1'])).map((i) => i.id)).toEqual([ids.both]);
	});

	it('matches label names case-insensitively', async () => {
		expect((await search(['BUG'])).map((i) => i.id).sort()).toEqual([ids.both, ids.bugOnly].sort());
	});

	it('returns nothing (not an error) for an unknown label', async () => {
		expect(await search(['nonexistent'])).toEqual([]);
	});

	it('matches by label id too', async () => {
		const bug = (await listLabels(t.db, USER)).find((l) => l.name === 'bug')!;
		expect((await search([bug.id])).map((i) => i.id).sort()).toEqual(
			[ids.both, ids.bugOnly].sort()
		);
	});
});

/**
 * Two requests can both miss the resolve for a brand-new name and both mint an
 * id. Driven through the exported pieces because the interleaving cannot be
 * produced through a single public call.
 */
describe('losing a get-or-create race', () => {
	it('attaches the winner’s label instead of failing on the unique index', async () => {
		const issue = addIssue(t, { title: 'a' });
		// Request A resolves first: "bug" does not exist, so an id is minted.
		const mine = await resolveOrCreateLabels(t.db, human, ['bug']);
		// Request B lands in between and creates "bug" with a different id.
		const winner = await createLabel(t.db, t.env, human, { name: 'bug' });
		expect(mine.toCreate[0].id).not.toBe(winner.id);

		// Now A's batch runs. Before, its label insert hit `label_user_name_uq`
		// and surfaced as a 500; now it is ignored and the attach binds by name.
		await runAtomic(t.env, [
			...labelInserts(t.db, human, mine.toCreate),
			...issueLabelInserts(t.db, human, { id: issue, project_id: PROJECT }, mine.labels, 1)
		]);

		// One label in the library, used once, and the attach points at it.
		expect((await listLabels(t.db, USER)).map((l) => `${l.name}:${l.issue_count}`)).toEqual([
			'bug:1'
		]);
		const { items } = await listIssues(
			t.db,
			USER,
			{ labels: ['bug'] },
			{ cursor: null, limit: 50 }
		);
		expect(items.map((i) => i.labels.map((l) => l.id))).toEqual([[winner.id]]);
	});
});

describe('label reads are scoped to the owner', () => {
	/**
	 * Defence in depth: no write path can attach another user's label, but the
	 * read SQL should not be the only thing standing on that being true.
	 */
	it('ignores a cross-user issue_label row on both the read and the filter', async () => {
		const issue = addIssue(t, { title: 'a' });
		await addIssueLabels(t.db, t.env, human, issue, ['bug']);
		t.sqlite.exec(`
			INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
				VALUES ('u2', 'bob', 'b@example.com', 1, 0, 0);
			INSERT INTO label (id, user_id, name, color, description, created_at, updated_at)
				VALUES ('lbl_foreign', 'u2', 'secret', 'red', '', 0, 0);
			INSERT INTO issue_label (issue_id, label_id, created_at)
				VALUES ('${issue}', 'lbl_foreign', 0);
		`);
		const page = { cursor: null, limit: 50 };
		const all = await listIssues(t.db, USER, {}, page);
		expect(all.items[0].labels.map((l) => l.name)).toEqual(['bug']);
		expect((await listIssues(t.db, USER, { labels: ['secret'] }, page)).items).toEqual([]);
		expect((await listIssues(t.db, USER, { labels: ['lbl_foreign'] }, page)).items).toEqual([]);
	});
});
