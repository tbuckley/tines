import type { WorkflowResponse } from '@tines/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { CLOSED, PROJECT, USER, addIssue, seedBase } from '../supervisor/test-fixtures';
import { ApiFail } from './core';
import {
	allowedTransitions,
	assertPinFieldsAllowed,
	getIssueDetail,
	listIssues,
	loadIssue,
	resolveStateRef
} from './issues';
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
		{ id: 's_open', name: 'Open', category: 'active', position: 0 },
		{ id: 's_review', name: 'Review', category: 'awaiting_human', position: 1 },
		{ id: 's_closed', name: 'Closed', category: 'done', position: 2 }
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
		expect(() => assertPinFieldsAllowed(session, { pinned_runner_id: 'rnr_1', pinned_tier: 'smartest' })).not.toThrow();
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
		await expect(getIssueDetail(t.db, USER, { projectName: 'nope', number })).rejects.toThrow(ApiFail);
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
		const detail = await getIssueDetail(t.db, USER, { id }, { workflows: loadWorkflows(t.db, USER) });
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
