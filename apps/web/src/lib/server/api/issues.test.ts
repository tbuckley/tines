import type { WorkflowResponse } from '@tines/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	CLOSED,
	OPEN,
	PROJECT,
	REVIEW,
	USER,
	addIssue,
	addRunner,
	seedBase
} from '../supervisor/test-fixtures';
import { ApiFail, type ActorContext } from './core';
import {
	allowedTransitions,
	assertPinFieldsAllowed,
	countIssuesByCategory,
	countOpenIssuesByWorkflow,
	createIssue,
	getIssueDetail,
	listIssues,
	loadIssue,
	resolveStateRef,
	transitionIssue,
	updateIssue
} from './issues';
import { createLabel, listLabels } from './labels';
import { listArtifacts } from './artifacts';
import { loadWorkflows } from './workflows';
import { createTestDb, type TestDb } from './test-db';

const workflow: WorkflowResponse = {
	id: 'wf_1',
	name: 'Standard',
	description: '',
	is_system: true,
	initial_state_id: 's_open',
	states: [
		{ id: 's_open', name: 'Open', category: 'active', position: 0, inherits_from: null },
		{
			id: 's_review',
			name: 'Review',
			category: 'awaiting_human',
			position: 1,
			inherits_from: null
		},
		{ id: 's_closed', name: 'Closed', category: 'done', position: 2, inherits_from: null }
	],
	transitions: [
		{ id: 't_submit', name: 'Submit', from_state_id: 's_open', to_state_id: 's_review' },
		{ id: 't_back', name: 'Send back', from_state_id: 's_review', to_state_id: 's_open' },
		{ id: 't_approve', name: 'Approve', from_state_id: 's_review', to_state_id: 's_closed' },
		{ id: 't_ghost', name: 'Ghost', from_state_id: 's_open', to_state_id: 's_missing' }
	],
	issue_count: 0,
	created_at: 0,
	updated_at: 0
};

describe('allowedTransitions', () => {
	it('lists only transitions leaving the given state, with target state data', () => {
		const allowed = allowedTransitions(workflow, 's_review');
		expect(allowed.map((t) => t.name).sort()).toEqual(['Approve', 'Send back']);
		const approve = allowed.find((t) => t.name === 'Approve')!;
		expect(approve.transition_id).toBe('t_approve');
		expect(approve.to_state).toMatchObject({ id: 's_closed', category: 'done' });
	});

	it('silently drops transitions whose target state no longer exists', () => {
		const allowed = allowedTransitions(workflow, 's_open');
		expect(allowed.map((t) => t.name)).toEqual(['Submit']);
	});

	it('returns an empty list for terminal states', () => {
		expect(allowedTransitions(workflow, 's_closed')).toEqual([]);
	});
});

describe('resolveStateRef', () => {
	it('resolves by id', () => {
		expect(resolveStateRef(workflow, 's_review').name).toBe('Review');
	});

	it('resolves by name', () => {
		expect(resolveStateRef(workflow, 'Review').id).toBe('s_review');
	});

	it('throws a 422 listing the known states for an unknown reference', () => {
		let caught: unknown;
		try {
			resolveStateRef(workflow, 'Nope');
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ApiFail);
		const fail = caught as ApiFail;
		expect(fail.status).toBe(422);
		expect(fail.code).toBe('unknown_state');
		expect(fail.details?.known_states).toEqual(
			workflow.states.map((s) => ({ id: s.id, name: s.name }))
		);
	});
});

describe('assertPinFieldsAllowed', () => {
	const runKey = { agentRunId: 'arun_1' };
	const namedKey = { agentRunId: null };
	const session = {};

	it('403s a run key setting a pin, pointing at the proposal convention', () => {
		try {
			assertPinFieldsAllowed(runKey, { pinned_runner_id: 'rnr_1' });
			throw new Error('expected a 403');
		} catch (e) {
			expect(e).toBeInstanceOf(ApiFail);
			expect((e as ApiFail).status).toBe(403);
			expect((e as ApiFail).code).toBe('run_key_forbidden');
			expect((e as ApiFail).message).toContain('Context change:');
		}
	});

	it('403s a run key clearing a pin or touching only the tier', () => {
		expect(() => assertPinFieldsAllowed(runKey, { pinned_runner_id: null })).toThrowError(ApiFail);
		expect(() => assertPinFieldsAllowed(runKey, { pinned_tier: 'cheapest' })).toThrowError(ApiFail);
		expect(() => assertPinFieldsAllowed(runKey, { pinned_tier: null })).toThrowError(ApiFail);
	});

	it('lets a run key patch non-pin fields', () => {
		expect(() => assertPinFieldsAllowed(runKey, {})).not.toThrow();
	});

	it('leaves named keys and sessions unfenced', () => {
		expect(() => assertPinFieldsAllowed(namedKey, { pinned_runner_id: 'rnr_1' })).not.toThrow();
		expect(() => assertPinFieldsAllowed(namedKey, { pinned_runner_id: null })).not.toThrow();
		expect(() =>
			assertPinFieldsAllowed(session, { pinned_runner_id: 'rnr_1', pinned_tier: 'smartest' })
		).not.toThrow();
	});
});

describe('updateIssue sparse patch concurrency', () => {
	const actor: ActorContext = {
		userId: USER,
		userName: 'alice',
		apiKeyId: null,
		apiKeyName: null,
		viaSession: true
	};

	function beforeBatch(
		t: TestDb,
		interleave: () => Promise<unknown>,
		inspectUpdate?: (sql: string) => void
	): Env {
		const batch = t.env.DB.batch.bind(t.env.DB);
		return {
			...t.env,
			DB: {
				...t.env.DB,
				batch: async (statements: Parameters<typeof batch>[0]) => {
					inspectUpdate?.((statements[0] as unknown as { sqlText: string }).sqlText);
					await interleave();
					return batch(statements);
				}
			}
		} as Env;
	}

	it('preserves a concurrent transition during a title-only patch', async () => {
		const t = createTestDb();
		seedBase(t);
		const id = addIssue(t, { title: 'Original', description: 'Original description' });
		let winnerStateEnteredAt = 0;
		const env = beforeBatch(t, async () => {
			const winner = await transitionIssue(t.db, t.env, actor, id, {
				action: 'Submit for review'
			});
			expect(winner.state.id).toBe(REVIEW);
			winnerStateEnteredAt = winner.state_entered_at;
		});

		const result = await updateIssue(t.db, env, actor, id, { title: 'Renamed' });

		expect(result).toMatchObject({ title: 'Renamed', state: { id: REVIEW } });
		expect(result.state_entered_at).toBe(winnerStateEnteredAt);
		const transitions = t.all(
			`SELECT payload FROM event WHERE issue_id = ? AND type = 'issue.transitioned'`,
			id
		);
		expect(transitions).toHaveLength(1);
		expect(JSON.parse(transitions[0].payload as string)).toMatchObject({
			from_state_id: OPEN,
			to_state_id: REVIEW
		});
	});

	it.each([
		{
			name: 'title patch commits last',
			outer: { title: 'Renamed' },
			concurrent: { description: 'New instructions' }
		},
		{
			name: 'description patch commits last',
			outer: { description: 'New instructions' },
			concurrent: { title: 'Renamed' }
		}
	])('preserves distinct concurrent text changes when $name', async ({ outer, concurrent }) => {
		const t = createTestDb();
		seedBase(t);
		const id = addIssue(t, { title: 'Original', description: 'Original description' });
		const env = beforeBatch(t, () => updateIssue(t.db, t.env, actor, id, concurrent));

		const result = await updateIssue(t.db, env, actor, id, outer);

		expect(result).toMatchObject({ title: 'Renamed', description: 'New instructions' });
	});

	it('preserves a concurrent pin and omits unrelated columns from a text update', async () => {
		const t = createTestDb();
		seedBase(t);
		const id = addIssue(t, { title: 'Original', description: 'Original description' });
		const runnerId = addRunner(t, { id: 'rnr_sparse', name: 'sparse' });
		let updateSql = '';
		const env = beforeBatch(
			t,
			() =>
				updateIssue(t.db, t.env, actor, id, {
					pinned_runner_id: runnerId,
					pinned_tier: 'smartest'
				}),
			(sql) => {
				updateSql = sql;
			}
		);

		const result = await updateIssue(t.db, env, actor, id, { title: 'Renamed' });

		expect(result).toMatchObject({
			title: 'Renamed',
			pinned_runner_id: runnerId,
			pinned_tier: 'smartest'
		});
		const assignments = updateSql.slice(0, updateSql.indexOf(' where '));
		expect(assignments).toContain('"title"');
		expect(assignments).toContain('"updated_at"');
		expect(assignments).not.toMatch(
			/"description"|"workflow_id"|"state_id"|"pinned_runner_id"|"pinned_tier"/
		);
	});

	it('keeps state CAS conflict handling and guarded events for explicit moves', async () => {
		const t = createTestDb();
		seedBase(t);
		const id = addIssue(t);
		const env = beforeBatch(t, async () => {
			await transitionIssue(t.db, t.env, actor, id, { action: 'Submit for review' });
			// Keep the event guard's timestamp witness distinct even when both
			// requests happen within the same millisecond in this in-memory test.
			t.sqlite.prepare('UPDATE issue SET updated_at = updated_at + 1 WHERE id = ?').run(id);
		});

		await expect(updateIssue(t.db, env, actor, id, { state: REVIEW })).rejects.toMatchObject({
			status: 409,
			code: 'conflict'
		});
		expect((await getIssueDetail(t.db, USER, { id })).state.id).toBe(REVIEW);
		expect(
			t.all(`SELECT id FROM event WHERE issue_id = ? AND type = 'issue.transitioned'`, id)
		).toHaveLength(1);
	});

	it('keeps workflow moves coupled to their initial state and manual-move reset', async () => {
		const t = createTestDb();
		seedBase(t);
		const id = addIssue(t);
		t.sqlite.exec(`
			INSERT INTO workflow (id, user_id, name, description, initial_state_id, created_at, updated_at)
				VALUES ('wf_sparse', '${USER}', 'Sparse', '', 'wfs_sparse_start', 0, 0);
			INSERT INTO workflow_state (id, workflow_id, name, category, position, created_at)
				VALUES ('wfs_sparse_start', 'wf_sparse', 'Start', 'active', 0, 0);
			UPDATE issue SET attempt_count = 2, needs_attention = 1 WHERE id = '${id}';
		`);

		const moved = await updateIssue(t.db, t.env, actor, id, { workflow_id: 'wf_sparse' });

		expect(moved).toMatchObject({
			workflow: { id: 'wf_sparse' },
			state: { id: 'wfs_sparse_start' },
			attempt_count: 0,
			needs_attention: false
		});
		expect(moved.state_entered_at).toBeGreaterThan(0);
		const updates = t.all(
			`SELECT payload FROM event WHERE issue_id = ? AND type = 'issue.updated'`,
			id
		);
		expect(updates).toHaveLength(1);
		expect(JSON.parse(updates[0].payload as string)).toMatchObject({
			changed: ['workflow'],
			workflow_from_id: 'wf_standard',
			workflow_to_id: 'wf_sparse',
			to_state_name: 'Start'
		});
	});

	it('retains pin and tier coupling when explicitly setting and clearing a pin', async () => {
		const t = createTestDb();
		seedBase(t);
		const id = addIssue(t);
		const runnerId = addRunner(t, { id: 'rnr_pin', name: 'pinned' });

		const pinned = await updateIssue(t.db, t.env, actor, id, {
			pinned_runner_id: runnerId,
			pinned_tier: 'cheapest'
		});
		expect(pinned).toMatchObject({
			pinned_runner_id: runnerId,
			pinned_runner_name: 'pinned',
			pinned_tier: 'cheapest'
		});
		const unpinned = await updateIssue(t.db, t.env, actor, id, { pinned_runner_id: null });
		expect(unpinned).toMatchObject({ pinned_runner_id: null, pinned_tier: null });
		const pinEvents = t
			.all(`SELECT payload FROM event WHERE issue_id = ? AND type = 'issue.updated'`, id)
			.map((row) => JSON.parse(row.payload as string))
			.filter((payload) => payload.changed.includes('pin'));
		expect(pinEvents).toHaveLength(2);
		expect(pinEvents.at(-1)).toMatchObject({ pinned_runner_id: null, pinned_tier: null });
	});

	it('keeps pin fields coupled when an unpin races a tier update', async () => {
		const t = createTestDb();
		seedBase(t);
		const id = addIssue(t);
		const runnerId = addRunner(t, { id: 'rnr_pin_race', name: 'pin race' });
		await updateIssue(t.db, t.env, actor, id, { pinned_runner_id: runnerId });
		const env = beforeBatch(t, () =>
			updateIssue(t.db, t.env, actor, id, { pinned_tier: 'smartest' })
		);

		const unpinned = await updateIssue(t.db, env, actor, id, { pinned_runner_id: null });

		expect(unpinned).toMatchObject({ pinned_runner_id: null, pinned_tier: null });
	});
});

describe('listIssues search', () => {
	const PROJECT2 = 'prj_2';
	let t: TestDb;
	let ids: Record<string, string>;

	/** Titles/descriptions chosen so each case isolates one matching column. */
	beforeEach(() => {
		t = createTestDb();
		seedBase(t);
		t.sqlite.exec(
			`INSERT INTO project (id, user_id, name, created_at, updated_at)
				VALUES ('${PROJECT2}', '${USER}', 'other', 0, 0)`
		);
		ids = {
			byTitle: addIssue(t, { title: '[idea] pagination' }),
			byDescription: addIssue(t, { title: 'Plain', description: 'mentions pagination' }),
			neither: addIssue(t, { title: 'Other' }),
			done: addIssue(t, { title: '[idea] done', state: CLOSED }),
			elsewhere: addIssue(t, { title: '[idea] elsewhere', project: PROJECT2 })
		};
	});

	const search = async (filters: Parameters<typeof listIssues>[2], limit = 50) =>
		listIssues(t.db, USER, filters, { cursor: null, limit });

	it('matches on title and on description', async () => {
		const { items } = await search({ q: 'pagination' });
		expect(items.map((i) => i.id).sort()).toEqual([ids.byTitle, ids.byDescription].sort());
	});

	it('treats brackets literally — SQLite LIKE has no character classes', async () => {
		const { items } = await search({ q: '[idea]' });
		expect(items.map((i) => i.id).sort()).toEqual([ids.byTitle, ids.done, ids.elsewhere].sort());
	});

	it('is case-insensitive for ASCII', async () => {
		const { items } = await search({ q: 'IDEA' });
		expect(items.map((i) => i.id).sort()).toEqual([ids.byTitle, ids.done, ids.elsewhere].sort());
	});

	it('returns nothing when no issue matches', async () => {
		expect((await search({ q: 'zzz' })).items).toEqual([]);
	});

	it('composes with project and hide_done', async () => {
		const { items } = await search({ q: '[idea]', project: PROJECT, hideDone: true });
		expect(items.map((i) => i.id)).toEqual([ids.byTitle]);
	});

	it('filters before paginating, so hasMore reflects the matches only', async () => {
		expect(await search({ q: 'pagination' }, 1)).toMatchObject({ hasMore: true });
		expect(await search({ q: '[idea]', project: PROJECT, hideDone: true }, 1)).toMatchObject({
			hasMore: false
		});
	});

	it('returns every issue when q is absent', async () => {
		expect((await search({})).items).toHaveLength(5);
	});
});

/**
 * The category tabs' counts: the same population as the list under every
 * filter but the tab itself, so a tab's number is what clicking it shows.
 */
describe('countIssuesByCategory', () => {
	const PROJECT2 = 'prj_2';
	let t: TestDb;

	beforeEach(() => {
		t = createTestDb();
		seedBase(t);
		t.sqlite.exec(
			`INSERT INTO project (id, user_id, name, created_at, updated_at)
				VALUES ('${PROJECT2}', '${USER}', 'other', 0, 0)`
		);
		addIssue(t, { title: 'open one' });
		addIssue(t, { title: 'open two' });
		addIssue(t, { title: 'closed', state: CLOSED });
		addIssue(t, { title: 'elsewhere', project: PROJECT2 });
	});

	it('counts every category, zeroes included', async () => {
		expect(await countIssuesByCategory(t.db, USER, {})).toEqual({
			backlog: 0,
			active: 3,
			awaiting_human: 0,
			done: 1
		});
	});

	it('follows the scope filters but never the category ones', async () => {
		expect(await countIssuesByCategory(t.db, USER, { project: PROJECT })).toMatchObject({
			active: 2,
			done: 1
		});
		expect(await countIssuesByCategory(t.db, USER, { q: 'open' })).toMatchObject({
			active: 2,
			done: 0
		});
		// Ready implies not-done, so the Done tab reads 0 while it is on.
		expect(await countIssuesByCategory(t.db, USER, { ready: true })).toMatchObject({
			active: 3,
			done: 0
		});
		// The tab's own filters are ignored: the counts are what each tab would list.
		expect(
			await countIssuesByCategory(t.db, USER, { category: 'done', hideDone: true })
		).toMatchObject({ active: 3, done: 1 });
	});
});

describe('countOpenIssuesByWorkflow', () => {
	it('counts open issues in the selected project and excludes done and other projects', async () => {
		const t = createTestDb();
		seedBase(t);
		t.sqlite.exec(`INSERT INTO project (id, user_id, name, created_at, updated_at)
			VALUES ('prj_2', '${USER}', 'other', 0, 0)`);
		addIssue(t);
		addIssue(t);
		addIssue(t, { state: CLOSED });
		addIssue(t, { project: 'prj_2' });
		expect(await countOpenIssuesByWorkflow(t.db, USER, PROJECT)).toEqual({ wf_standard: 2 });
	});
});

/**
 * The create path resolves labels *before* the issue insert and appends the
 * label writes to the same atomic batch, so label ids exist in memory before
 * their rows do. These cases pin both halves of that: what a successful
 * create leaves behind, and that a rejected one leaves nothing at all.
 */
describe('createIssue with labels', () => {
	let t: TestDb;
	beforeEach(() => {
		t = createTestDb();
		seedBase(t);
	});

	const human: ActorContext = {
		userId: USER,
		userName: 'alice',
		apiKeyId: null,
		apiKeyName: null,
		viaSession: true
	};
	/** A run key — fenced to the existing vocabulary. Key id null: see labels.test.ts. */
	const runKey: ActorContext = { ...human, viaSession: false, agentRunId: 'arun_1' };

	const create = (actor: ActorContext, labels: string[]) =>
		createIssue(t.db, t.env, actor, PROJECT, { title: 'Labelled', labels });
	const issueCount = () =>
		Number((t.sqlite.prepare('SELECT COUNT(*) AS n FROM issue').get() as { n: number }).n);

	it('creates unknown labels on the fly for a human and attaches them', async () => {
		const issue = await create(human, ['bug', 'p1']);
		expect(issue.labels.map((l) => l.name)).toEqual(['bug', 'p1']);
		// They land in the library too, each used exactly once.
		expect((await listLabels(t.db, USER)).map((l) => `${l.name}:${l.issue_count}`)).toEqual([
			'bug:1',
			'p1:1'
		]);
	});

	it('rejects a run key naming an unknown label without creating the issue', async () => {
		expect(issueCount()).toBe(0);
		let caught: unknown;
		try {
			await create(runKey, ['bug']);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ApiFail);
		expect((caught as ApiFail).code).toBe('unknown_label');
		// The whole point of resolving before the batch: no half-created issue.
		expect(issueCount()).toBe(0);
		expect(await listLabels(t.db, USER)).toEqual([]);
	});

	it('lets a run key attach an existing label, matched case-insensitively', async () => {
		await createLabel(t.db, t.env, human, { name: 'bug' });
		const issue = await create(runKey, ['BUG']);
		expect(issue.labels.map((l) => l.name)).toEqual(['bug']);
		expect(await listLabels(t.db, USER)).toHaveLength(1);
	});

	it('dedupes names that differ only by case within one create', async () => {
		const issue = await create(human, ['bug', 'Bug']);
		expect(issue.labels.map((l) => l.name)).toEqual(['bug']);
		expect(await listLabels(t.db, USER)).toHaveLength(1);
	});

	it('filters on a label applied at creation time', async () => {
		const labelled = await create(human, ['bug']);
		await createIssue(t.db, t.env, human, PROJECT, { title: 'Plain' });
		const { items } = await listIssues(
			t.db,
			USER,
			{ labels: ['bug'] },
			{ cursor: null, limit: 50 }
		);
		expect(items.map((i) => i.id)).toEqual([labelled.id]);
	});
});

// --- brief: the token-saving list shape (Tines/90) ---------------------------

describe('listIssues brief', () => {
	let t: TestDb;

	beforeEach(() => {
		t = createTestDb();
		seedBase(t);
		addIssue(t, { title: 'Documented', description: 'a long description body' });
		addIssue(t, { title: 'Bare' });
	});

	const list = async (filters: Parameters<typeof listIssues>[2]) =>
		(await listIssues(t.db, USER, filters, { cursor: null, limit: 50 })).items;

	it('omits the description key entirely — including for an empty one', async () => {
		const items = await list({ brief: true });
		expect(items).toHaveLength(2);
		for (const item of items) expect(Object.hasOwn(item, 'description')).toBe(false);
	});

	it('changes nothing else about an item', async () => {
		const full = (await list({})).find((i) => i.title === 'Documented')!;
		const brief = (await list({ brief: true })).find((i) => i.title === 'Documented')!;
		expect(full.description).toBe('a long description body');
		const { description: _description, ...rest } = full;
		expect(brief).toEqual(rest);
	});

	it('keeps descriptions without the flag, and with a falsy one', async () => {
		for (const filters of [{}, { brief: false }]) {
			const byTitle = Object.fromEntries(
				(await list(filters)).map((i) => [i.title, i.description])
			);
			expect(byTitle).toEqual({ Documented: 'a long description body', Bare: '' });
		}
	});
});

describe('listIssues bidirectional pagination', () => {
	it('walks 205 rows forward and back without gaps or duplicates', async () => {
		const t = createTestDb();
		seedBase(t);
		for (let n = 1; n <= 205; n += 1) {
			const id = `iss_page_${String(n).padStart(3, '0')}`;
			addIssue(t, { id });
			t.sqlite.prepare('UPDATE issue SET created_at = ? WHERE id = ?').run(n, id);
		}
		const first = await listIssues(t.db, USER, { brief: true }, { cursor: null, limit: 100 });
		const second = await listIssues(
			t.db,
			USER,
			{ brief: true },
			{
				cursor: {
					createdAt: first.items.at(-1)!.created_at,
					id: first.items.at(-1)!.id
				},
				limit: 100,
				direction: 'after'
			}
		);
		const third = await listIssues(
			t.db,
			USER,
			{},
			{
				cursor: {
					createdAt: second.items.at(-1)!.created_at,
					id: second.items.at(-1)!.id
				},
				limit: 100,
				direction: 'after'
			}
		);
		expect([first.items.length, second.items.length, third.items.length]).toEqual([100, 100, 5]);
		expect([first.hasMore, second.hasMore, third.hasMore]).toEqual([true, true, false]);
		const ids = [...first.items, ...second.items, ...third.items].map((issue) => issue.id);
		expect(new Set(ids).size).toBe(205);
		expect(ids[0]).toBe('iss_page_205');
		expect(ids.at(-1)).toBe('iss_page_001');

		const back = await listIssues(
			t.db,
			USER,
			{},
			{
				cursor: { createdAt: third.items[0].created_at, id: third.items[0].id },
				limit: 100,
				direction: 'before'
			}
		);
		expect(back.items.map((issue) => issue.id)).toEqual(second.items.map((issue) => issue.id));
		expect(back.hasMore).toBe(true);
	});

	it('uses id as the stable reverse tie-breaker without looking up the boundary row', async () => {
		const t = createTestDb();
		seedBase(t);
		for (const id of ['iss_tie_a', 'iss_tie_b', 'iss_tie_c']) {
			addIssue(t, { id });
			t.sqlite.prepare('UPDATE issue SET created_at = 10 WHERE id = ?').run(id);
		}
		// Permanent addresses intentionally outlive issue mutability. This test
		// removes a synthetic boundary row, so remove its test-only reservation too.
		t.sqlite.prepare("DELETE FROM issue_address WHERE issue_id = 'iss_tie_b'").run();
		t.sqlite.prepare("DELETE FROM issue WHERE id = 'iss_tie_b'").run();
		const older = await listIssues(
			t.db,
			USER,
			{},
			{ cursor: { createdAt: 10, id: 'iss_tie_b' }, limit: 10, direction: 'after' }
		);
		const newer = await listIssues(
			t.db,
			USER,
			{},
			{ cursor: { createdAt: 10, id: 'iss_tie_b' }, limit: 10, direction: 'before' }
		);
		expect(older.items.map((issue) => issue.id)).toEqual(['iss_tie_a']);
		expect(newer.items.map((issue) => issue.id)).toEqual(['iss_tie_c']);
	});
});

// --- getIssueDetail: the page load's dedupe contract (Tines/32) --------------
// The issue page resolves the issue row once and hands what it already has to
// getIssueDetail. These lock in that the shortcuts produce the same answer as
// the long way round, and that they really skip the queries.

describe('getIssueDetail lookups and preloading', () => {
	let t: TestDb;
	let id: string;
	let number: number;

	beforeEach(() => {
		t = createTestDb();
		seedBase(t);
		id = addIssue(t, { title: 'Detail me' });
		number = (t.all('SELECT number FROM issue WHERE id = ?', id)[0] as { number: number }).number;
	});

	it('resolves by project name — the URL shape — in one statement', async () => {
		const byName = await getIssueDetail(t.db, USER, { projectName: 'demo', number });
		expect(byName.id).toBe(id);
		const byId = await getIssueDetail(t.db, USER, { id });
		expect(byName).toEqual(byId);
	});

	it('404s on an unknown project name', async () => {
		await expect(getIssueDetail(t.db, USER, { projectName: 'nope', number })).rejects.toThrow(
			ApiFail
		);
	});

	it('takes an already-loaded issue instead of re-reading the row', async () => {
		const issue = await loadIssue(t.db, USER, { id });
		const spy = t.spyOnQueries();
		const detail = await getIssueDetail(t.db, USER, issue);
		expect(detail.id).toBe(id);
		expect(spy().some((sql) => sql.includes('dup_chain'))).toBe(false);
	});

	it('uses preloaded workflows instead of querying for them', async () => {
		const workflows = await loadWorkflows(t.db, USER);
		const plain = await getIssueDetail(t.db, USER, { id });
		const spy = t.spyOnQueries();
		const preloaded = await getIssueDetail(t.db, USER, { id }, { workflows });
		expect(preloaded.workflow).toEqual(plain.workflow);
		expect(preloaded.allowed_transitions).toEqual(plain.allowed_transitions);
		expect(spy().some((sql) => sql.includes('workflow_transition'))).toBe(false);
	});

	it('accepts a still-in-flight workflows promise', async () => {
		const detail = await getIssueDetail(
			t.db,
			USER,
			{ id },
			{ workflows: loadWorkflows(t.db, USER) }
		);
		expect(detail.workflow.id).toBe(detail.workflow_id);
	});

	it('404s when the preloaded workflows do not contain the issue’s workflow', async () => {
		await expect(getIssueDetail(t.db, USER, { id }, { workflows: [] })).rejects.toThrow(ApiFail);
	});

	it('returns artifacts only when asked, and reads them exactly once', async () => {
		expect((await getIssueDetail(t.db, USER, { id })).artifacts).toBeUndefined();

		const baseline = t.spyOnQueries();
		await listArtifacts(t.db, USER, id);
		const oneRead = baseline().length;

		const spy = t.spyOnQueries();
		const withArtifacts = await getIssueDetail(t.db, USER, { id }, { artifacts: true });
		expect(withArtifacts.artifacts).toEqual([]);
		// The requirement pre-flight reuses the list the caller asked for rather
		// than fetching a second copy.
		const artifactReads = spy().filter((sql) => sql.includes('context_item')).length;
		expect(artifactReads).toBe(oneRead);
	});
});
