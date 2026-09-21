import {
	recordDispatchEffects,
	TEST_NOOP_DISPATCH_EFFECTS
} from '$lib/server/api/test-dispatch-effects';
import {
	FULL_API_KEY_PERMISSIONS,
	type ApiKeyPermissions,
	type WorkflowResponse
} from '@tines/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	CLOSED,
	OPEN,
	PROJECT,
	REVIEW,
	USER,
	addLabel,
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
	getIssueDetailForActor,
	listIssues,
	listIssuesForActor,
	loadIssue,
	resumeIssue,
	resolveStateRef,
	transitionIssue,
	updateIssue
} from './issues';
import { createLabel, listLabels } from './labels';
import { listArtifacts } from './artifacts';
import { getArtifactStore } from '$lib/server/artifact-store';
import { runScheduleNow } from './schedules';
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

function scopedActor(permissions: ApiKeyPermissions): ActorContext {
	return {
		userId: USER,
		userName: 'alice',
		apiKeyId: 'key_scoped',
		apiKeyName: 'scoped',
		viaSession: false,
		permissions,
		runRestriction: null
	};
}

describe('scoped issue permissions', () => {
	it('filters collections before pagination and 404s detail outside the selected scope', async () => {
		const t = createTestDb();
		seedBase(t);
		t.sqlite.exec(`
			INSERT INTO project (id, user_id, name, created_at, updated_at)
			VALUES ('prj_2', '${USER}', 'other', 1, 1)
		`);
		const visible = addIssue(t, { project: PROJECT, title: 'visible' });
		const hidden = addIssue(t, { project: 'prj_2', title: 'hidden' });
		const actor = scopedActor({
			version: 1,
			projects: { access: 'read', scope: [PROJECT] },
			workspace: 'none',
			control_plane: 'none'
		});

		await expect(
			listIssuesForActor(t.db, actor, {}, { cursor: null, limit: 1 })
		).resolves.toMatchObject({ items: [{ id: visible }], hasMore: false });
		await expect(getIssueDetailForActor(t.db, actor, { id: hidden })).rejects.toMatchObject({
			status: 404,
			code: 'not_found'
		});
	});

	it('allows content writes but rejects pin fields without control-plane write', async () => {
		const t = createTestDb();
		seedBase(t);
		const issue = addIssue(t, { title: 'original' });
		const runner = addRunner(t);
		t.sqlite.exec(`
			INSERT INTO api_key (id, user_id, name, key_hash, key_prefix, created_at)
			VALUES ('key_scoped', '${USER}', 'scoped', 'hash', 'prefix', 1)
		`);
		const actor = scopedActor({
			version: 1,
			projects: { access: 'write', scope: [PROJECT] },
			workspace: 'read',
			control_plane: 'none'
		});

		await expect(
			updateIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, issue, { title: 'allowed' })
		).resolves.toMatchObject({ title: 'allowed' });
		await expect(
			updateIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, issue, {
				title: 'must not land',
				pinned_runner_id: runner
			})
		).rejects.toMatchObject({
			status: 403,
			code: 'insufficient_permissions',
			details: { operation: 'issue.pin', domain: 'control_plane', access: 'write' }
		});
		expect(await getIssueDetail(t.db, USER, { id: issue })).toMatchObject({
			title: 'allowed',
			pinned_runner_id: null
		});
	});

	it('requires workspace write before an issue create can introduce a label', async () => {
		const t = createTestDb();
		seedBase(t);
		const actor = scopedActor({
			version: 1,
			projects: { access: 'write', scope: [PROJECT] },
			workspace: 'read',
			control_plane: 'none'
		});

		await expect(
			createIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, PROJECT, {
				title: 'must not land',
				labels: ['new-label']
			})
		).rejects.toMatchObject({
			status: 403,
			code: 'insufficient_permissions',
			details: { operation: 'label.create', domain: 'workspace', access: 'write' }
		});
		expect(t.all('SELECT id FROM issue')).toEqual([]);
		expect(t.all('SELECT id FROM label')).toEqual([]);
	});

	it('keeps an over-granted run key from embedding a schedule in issue creation', async () => {
		const t = createTestDb();
		seedBase(t);
		const actor: ActorContext = {
			...scopedActor(FULL_API_KEY_PERMISSIONS),
			agentRunId: 'run_1',
			runRestriction: {
				policy: 'run-v1',
				runId: 'run_1',
				issueId: 'iss_bound',
				projectId: PROJECT,
				launchStateId: OPEN
			}
		};

		await expect(
			createIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, PROJECT, {
				title: 'must not land',
				schedule: { preset: { kind: 'daily', time: '09:00' } }
			})
		).rejects.toMatchObject({
			status: 403,
			code: 'run_key_forbidden',
			details: { operation: 'schedule.create', reason: 'operation_forbidden' }
		});
		expect(t.all('SELECT id FROM issue')).toEqual([]);
		expect(t.all('SELECT id FROM scheduled_task')).toEqual([]);
	});
});

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
			const winner = await transitionIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, id, {
				action: 'Submit for review'
			});
			expect(winner.state.id).toBe(REVIEW);
			winnerStateEnteredAt = winner.state_entered_at;
		});

		const result = await updateIssue(t.db, env, actor, TEST_NOOP_DISPATCH_EFFECTS, id, {
			title: 'Renamed'
		});

		expect(result).toMatchObject({ title: 'Renamed', state: { id: REVIEW } });
		expect(result.state_entered_at).toBe(winnerStateEnteredAt);
		const transitions = t.all(
			`SELECT payload FROM event WHERE issue_id = ? AND type = 'issue.transitioned'`,
			id
		);
		expect(transitions).toHaveLength(1);
		expect(JSON.parse(transitions[0].payload as string)).toMatchObject({
			state_entry_version: 1,
			workflow_id: 'wf_standard',
			workflow_name: 'Standard',
			from_state_id: OPEN,
			to_state_id: REVIEW,
			to_state_category: 'awaiting_human'
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
		const env = beforeBatch(t, () =>
			updateIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, id, concurrent)
		);

		const result = await updateIssue(t.db, env, actor, TEST_NOOP_DISPATCH_EFFECTS, id, outer);

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
				updateIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, id, {
					pinned_runner_id: runnerId,
					pinned_tier: 'smartest'
				}),
			(sql) => {
				updateSql = sql;
			}
		);

		const result = await updateIssue(t.db, env, actor, TEST_NOOP_DISPATCH_EFFECTS, id, {
			title: 'Renamed'
		});

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
			await transitionIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, id, {
				action: 'Submit for review'
			});
			// Keep the event guard's timestamp witness distinct even when both
			// requests happen within the same millisecond in this in-memory test.
			t.sqlite.prepare('UPDATE issue SET updated_at = updated_at + 1 WHERE id = ?').run(id);
		});

		await expect(
			updateIssue(t.db, env, actor, TEST_NOOP_DISPATCH_EFFECTS, id, { state: REVIEW })
		).rejects.toMatchObject({
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

		const moved = await updateIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, id, {
			workflow_id: 'wf_sparse'
		});

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
			state_entry_version: 1,
			changed: ['workflow'],
			workflow_from_id: 'wf_standard',
			workflow_to_id: 'wf_sparse',
			from_state_id: OPEN,
			to_state_id: 'wfs_sparse_start',
			to_state_name: 'Start',
			to_state_category: 'active'
		});
	});

	it('retains pin and tier coupling when explicitly setting and clearing a pin', async () => {
		const t = createTestDb();
		seedBase(t);
		const id = addIssue(t);
		const runnerId = addRunner(t, { id: 'rnr_pin', name: 'pinned' });

		const pinned = await updateIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, id, {
			pinned_runner_id: runnerId,
			pinned_tier: 'cheapest'
		});
		expect(pinned).toMatchObject({
			pinned_runner_id: runnerId,
			pinned_runner_name: 'pinned',
			pinned_tier: 'cheapest'
		});
		const unpinned = await updateIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, id, {
			pinned_runner_id: null
		});
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
		await updateIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, id, {
			pinned_runner_id: runnerId
		});
		const env = beforeBatch(t, () =>
			updateIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, id, {
				pinned_tier: 'smartest'
			})
		);

		const unpinned = await updateIssue(t.db, env, actor, TEST_NOOP_DISPATCH_EFFECTS, id, {
			pinned_runner_id: null
		});

		expect(unpinned).toMatchObject({ pinned_runner_id: null, pinned_tier: null });
	});
});

describe('dispatch effects: issue mutation owners', () => {
	it('records successful changes and approved no-ops, but not rejected lookups', async () => {
		const t = createTestDb();
		seedBase(t);
		const actor: ActorContext = {
			userId: USER,
			userName: 'alice',
			apiKeyId: null,
			apiKeyName: null,
			viaSession: true
		};
		const effects = recordDispatchEffects();
		const issue = addIssue(t, { title: 'Original' });

		await updateIssue(t.db, t.env, actor, effects, issue, { title: 'Changed' });
		await updateIssue(t.db, t.env, actor, effects, issue, { title: 'Changed' });
		expect(effects.count()).toBe(2);

		await transitionIssue(t.db, t.env, actor, effects, issue, { action: 'Submit for review' });
		expect(effects.count()).toBe(3);

		const parked = addIssue(t, { needsAttention: true, attemptCount: 3 });
		await resumeIssue(t.db, t.env, actor, effects, parked);
		await resumeIssue(t.db, t.env, actor, effects, parked);
		expect(effects.count()).toBe(5);

		await expect(resumeIssue(t.db, t.env, actor, effects, 'iss_missing')).rejects.toMatchObject({
			status: 404
		});
		expect(effects.count()).toBe(5);
	});

	it.each(['update', 'transition', 'resume'] as const)(
		'keeps %s silent when its durable batch rejects',
		async (owner) => {
			const t = createTestDb();
			seedBase(t);
			const actor: ActorContext = {
				userId: USER,
				userName: 'alice',
				apiKeyId: null,
				apiKeyName: null,
				viaSession: true
			};
			const issue = addIssue(t, {
				title: 'Original',
				...(owner === 'resume' ? { needsAttention: true, attemptCount: 3 } : {})
			});
			const effects = recordDispatchEffects();
			t.env.DB.batch = async () => {
				throw new Error(`injected ${owner} batch failure`);
			};
			const call =
				owner === 'update'
					? updateIssue(t.db, t.env, actor, effects, issue, { title: 'Changed' })
					: owner === 'transition'
						? transitionIssue(t.db, t.env, actor, effects, issue, {
								action: 'Submit for review'
							})
						: resumeIssue(t.db, t.env, actor, effects, issue);
			await expect(call).rejects.toThrow(`injected ${owner} batch failure`);
			expect(effects.count()).toBe(0);
			expect(
				t.all('SELECT title, state_id, needs_attention FROM issue WHERE id = ?', issue)
			).toEqual([
				{ title: 'Original', state_id: OPEN, needs_attention: owner === 'resume' ? 1 : 0 }
			]);
		}
	);
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

	it('matches complete long and multibyte substrings without truncating or chunking', async () => {
		const long = 'a'.repeat(49) + 'needle' + 'b'.repeat(145);
		const japanese = 'あ'.repeat(49);
		const longTitle = addIssue(t, { title: `prefix ${long} suffix` });
		const longDescription = addIssue(t, { title: 'Long description', description: long });
		const multibyte = addIssue(t, { title: japanese });
		addIssue(t, { title: `${long.slice(0, 48)}x${long.slice(49)}` });
		addIssue(t, { title: `${long.slice(100)} -- ${long.slice(0, 100)}` });

		expect((await search({ q: long })).items.map((i) => i.id).sort()).toEqual(
			[longTitle, longDescription].sort()
		);
		expect((await search({ q: japanese })).items.map((i) => i.id)).toEqual([multibyte]);
	});

	it('treats LIKE and SQL syntax characters literally', async () => {
		const literal = addIssue(t, { title: `literal % _ \\ [x] O'Reilly -- drop table` });
		addIssue(t, { title: 'ordinary wildcard decoy' });
		for (const term of ['%', '_', '\\', '[x]', "O'Reilly -- drop table"]) {
			expect(
				(await search({ q: term })).items.map((i) => i.id),
				term
			).toEqual([literal]);
		}
	});

	it('keeps SQLite ASCII-only case folding and treats empty q as absent', async () => {
		const upperUnicode = addIssue(t, { title: 'Ärger' });
		const lowerUnicode = addIssue(t, { title: 'ärger' });
		expect((await search({ q: 'ÄRGER' })).items.map((i) => i.id)).toEqual([upperUnicode]);
		expect((await search({ q: 'ärger' })).items.map((i) => i.id)).toEqual([lowerUnicode]);
		expect((await search({ q: '' })).items).toHaveLength(7);
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

describe('listIssues duplicate visibility', () => {
	const PROJECT2 = 'prj_duplicates_other';
	let t: TestDb;
	let ordinary: string;
	let canonical: string;
	let duplicate: string;
	let chain: string;

	beforeEach(() => {
		t = createTestDb();
		seedBase(t);
		t.sqlite.exec(
			`INSERT INTO project (id, user_id, name, created_at, updated_at)
			 VALUES ('${PROJECT2}', '${USER}', 'duplicate targets', 0, 0)`
		);
		ordinary = addIssue(t, { title: 'Ordinary' });
		canonical = addIssue(t, { title: 'Canonical', project: PROJECT2 });
		duplicate = addIssue(t, { title: 'Duplicate' });
		chain = addIssue(t, { title: 'Chain source' });
		t.sqlite
			.prepare(
				`INSERT INTO issue_link (id, source_issue_id, target_issue_id, kind, created_at)
				 VALUES (?, ?, ?, 'duplicate_of', 0), (?, ?, ?, 'duplicate_of', 0)`
			)
			.run('lnk_duplicate', duplicate, canonical, 'lnk_chain', chain, duplicate);
	});

	const list = async (filters: Parameters<typeof listIssues>[2] = {}, limit = 50) =>
		listIssues(t.db, USER, filters, { cursor: null, limit });

	it('hides every duplicate source by default and includes them only when requested', async () => {
		expect((await list({ projectId: PROJECT })).items.map((item) => item.id)).toEqual([ordinary]);
		expect(
			(await list({ projectId: PROJECT, hideDuplicates: true })).items.map((item) => item.id)
		).toEqual([ordinary]);
		expect(
			(await list({ projectId: PROJECT, hideDuplicates: false })).items
				.map((item) => item.id)
				.sort()
		).toEqual([ordinary, duplicate, chain].sort());
		// An incoming duplicate link does not hide the canonical target.
		expect((await list({ projectId: PROJECT2 })).items.map((item) => item.id)).toEqual([canonical]);
	});

	it('restores an issue when its outgoing duplicate link is removed', async () => {
		t.sqlite.prepare('DELETE FROM issue_link WHERE source_issue_id = ?').run(duplicate);
		expect((await list({ projectId: PROJECT })).items.map((item) => item.id).sort()).toEqual(
			[ordinary, duplicate].sort()
		);
	});

	it('keeps counts, workflow counts, Ready, and brief rows on the same population', async () => {
		expect(await countIssuesByCategory(t.db, USER, { projectId: PROJECT })).toMatchObject({
			active: 1
		});
		expect(
			await countIssuesByCategory(t.db, USER, { projectId: PROJECT, hideDuplicates: false })
		).toMatchObject({ active: 3 });
		expect(await countOpenIssuesByWorkflow(t.db, USER, PROJECT)).toEqual({ wf_standard: 1 });
		expect(
			(await list({ projectId: PROJECT, hideDuplicates: false, ready: true })).items.map(
				(item) => item.id
			)
		).toEqual([ordinary]);
		const shown = await list({ projectId: PROJECT, hideDuplicates: false, brief: true });
		expect(shown.items.find((item) => item.id === duplicate)?.duplicate_of).toMatchObject({
			project_name: 'duplicate targets'
		});
		expect(shown.items.every((item) => !Object.hasOwn(item, 'description'))).toBe(true);
	});

	it('filters duplicates before cursor pagination', async () => {
		for (const [id, createdAt] of [
			[ordinary, 50],
			[duplicate, 40],
			[canonical, 30],
			[chain, 20]
		] as const) {
			t.sqlite.prepare('UPDATE issue SET created_at = ? WHERE id = ?').run(createdAt, id);
		}
		const first = await list({}, 1);
		expect(first.items.map((item) => item.id)).toEqual([ordinary]);
		expect(first.hasMore).toBe(true);
		const second = await listIssues(
			t.db,
			USER,
			{},
			{
				cursor: { createdAt: first.items[0].created_at, id: first.items[0].id },
				direction: 'after',
				limit: 1
			}
		);
		expect(second.items.map((item) => item.id)).toEqual([canonical]);
		expect(second.hasMore).toBe(false);
	});
});

describe('listIssues workflow filtering', () => {
	let t: TestDb;
	let ids: Record<string, string>;
	let label: string;

	beforeEach(() => {
		t = createTestDb();
		seedBase(t);
		t.sqlite.exec(`
			INSERT INTO workflow (id, user_id, name, initial_state_id, created_at, updated_at) VALUES
				('wf_alpha', '${USER}', 'Shared workflow', 's_alpha_review', 0, 0),
				('wf_beta', '${USER}', 'Shared workflow', 's_beta_review', 0, 0);
			INSERT INTO workflow_state (id, workflow_id, name, category, position, created_at) VALUES
				('s_alpha_review', 'wf_alpha', 'Review', 'awaiting_human', 0, 0),
				('s_alpha_done', 'wf_alpha', 'Done', 'done', 1, 0),
				('s_beta_review', 'wf_beta', 'Review', 'active', 0, 0);
		`);
		label = addLabel(t, 'workflow-test');
		ids = {
			alphaReview: addIssue(t, {
				title: 'Needle alpha review',
				workflow: 'wf_alpha',
				state: 's_alpha_review',
				labels: [label]
			}),
			alphaDone: addIssue(t, {
				title: 'Alpha done',
				workflow: 'wf_alpha',
				state: 's_alpha_done'
			}),
			betaReview: addIssue(t, {
				title: 'Beta review',
				workflow: 'wf_beta',
				state: 's_beta_review'
			}),
			alphaDuplicate: addIssue(t, {
				title: 'Alpha duplicate',
				workflow: 'wf_alpha',
				state: 's_alpha_review'
			})
		};
		t.sqlite
			.prepare(
				`INSERT INTO issue_link (id, source_issue_id, target_issue_id, kind, created_at)
				 VALUES ('lnk_workflow', ?, ?, 'duplicate_of', 0)`
			)
			.run(ids.alphaDuplicate, ids.betaReview);
	});

	const list = async (filters: Parameters<typeof listIssues>[2]) =>
		(
			await listIssues(t.db, USER, { projectId: PROJECT, ...filters }, { cursor: null, limit: 50 })
		).items.map((item) => item.id);

	it('matches workflow and state by id or exact name, including duplicate semantics', async () => {
		expect((await list({ workflow: 'wf_alpha', hideDuplicates: false })).sort()).toEqual(
			[ids.alphaReview, ids.alphaDone, ids.alphaDuplicate].sort()
		);
		expect((await list({ workflow: 'Shared workflow', hideDuplicates: false })).sort()).toEqual(
			Object.values(ids).sort()
		);
		expect(await list({ workflow: 'wf_alpha', state: 's_alpha_review' })).toEqual([
			ids.alphaReview
		]);
		expect(
			await list({ workflow: 'wf_alpha', state: 's_beta_review', hideDuplicates: false })
		).toEqual([ids.alphaDuplicate]);
		expect(
			(await list({ workflow: 'Shared workflow', state: 'Review', hideDuplicates: false })).sort()
		).toEqual([ids.alphaReview, ids.betaReview, ids.alphaDuplicate].sort());
		expect(await list({ workflow: 'WF_ALPHA' })).toEqual([]);
	});

	it('composes workflow with ready, label, and search and keeps user isolation', async () => {
		expect(await list({ workflow: 'wf_alpha', ready: true, labels: [label], q: 'needle' })).toEqual(
			[ids.alphaReview]
		);
		expect(
			(
				await listIssues(
					t.db,
					'another-user',
					{ workflow: 'Shared workflow' },
					{ cursor: null, limit: 50 }
				)
			).items
		).toEqual([]);
	});

	it('counts within workflow/state scope while ignoring category and hide-done', async () => {
		expect(
			await countIssuesByCategory(t.db, USER, {
				projectId: PROJECT,
				workflow: 'wf_alpha',
				state: 'Review',
				category: 'done',
				hideDone: true,
				hideDuplicates: false
			})
		).toEqual({ backlog: 0, active: 1, awaiting_human: 1, done: 0 });
		expect(
			await countIssuesByCategory(t.db, USER, { projectId: PROJECT, workflow: 'missing' })
		).toEqual({ backlog: 0, active: 0, awaiting_human: 0, done: 0 });
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

	it('uses literal long search semantics for category counts', async () => {
		const term = `%_${'x'.repeat(60)}`;
		addIssue(t, { title: term });
		addIssue(t, { title: term, state: CLOSED });
		expect(await countIssuesByCategory(t.db, USER, { q: term })).toMatchObject({
			active: 1,
			done: 1
		});
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
	const runKey: ActorContext = {
		...human,
		viaSession: false,
		agentRunId: 'arun_1',
		permissions: FULL_API_KEY_PERMISSIONS,
		runRestriction: null
	};

	const create = (actor: ActorContext, labels: string[]) =>
		createIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, PROJECT, {
			title: 'Labelled',
			labels
		});
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
		const event = t.all(
			`SELECT payload FROM event WHERE issue_id = ? AND type = 'issue.created'`,
			issue.id
		);
		expect(JSON.parse(event[0].payload as string)).toMatchObject({
			state_entry_version: 1,
			workflow_id: 'wf_standard',
			workflow_name: 'Standard',
			state_id: OPEN,
			state_name: 'Open',
			state_category: 'active'
		});
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

	it('dispatch effects: createIssue stays silent when the durable batch rejects', async () => {
		const effects = recordDispatchEffects();
		const realBatch = t.env.DB.batch.bind(t.env.DB);
		t.env.DB.batch = async () => {
			throw new Error('injected issue batch failure');
		};
		await expect(
			createIssue(t.db, t.env, human, effects, PROJECT, { title: 'Rejected at commit' })
		).rejects.toThrow('injected issue batch failure');
		t.env.DB.batch = realBatch;
		expect(effects.count()).toBe(0);
		expect(issueCount()).toBe(0);
		expect(t.all("SELECT id FROM event WHERE type = 'issue.created'")).toEqual([]);
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
		await createIssue(t.db, t.env, human, TEST_NOOP_DISPATCH_EFFECTS, PROJECT, { title: 'Plain' });
		const { items } = await listIssues(
			t.db,
			USER,
			{ labels: ['bug'] },
			{ cursor: null, limit: 50 }
		);
		expect(items.map((i) => i.id)).toEqual([labelled.id]);
	});
});

describe('createIssue with initial files', () => {
	const human: ActorContext = {
		userId: USER,
		userName: 'alice',
		apiKeyId: null,
		apiKeyName: null,
		viaSession: true
	};
	const file = (name: string, body = name) => ({
		name,
		filename: `${name}.txt`,
		contentType: 'text/plain',
		body: new Blob([body], { type: 'text/plain' })
	});

	it('publishes file rows, bytes, and canonical scope before signaling dispatch', async () => {
		const t = createTestDb();
		seedBase(t);
		let visibleAtSignal: unknown[] = [];
		const issue = await createIssue(
			t.db,
			t.env,
			human,
			{
				signalDispatch() {
					visibleAtSignal = t.all("SELECT name FROM context_item WHERE kind = 'artifact'");
				}
			},
			PROJECT,
			{ title: 'With files', labels: ['reference'] },
			[
				{
					name: 'screen',
					filename: 'Screen.png',
					contentType: 'image/png',
					body: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
				},
				{
					name: 'notes',
					filename: 'notes.txt',
					contentType: 'text/plain',
					body: new Blob(['hello'], { type: 'text/plain' })
				}
			]
		);
		expect(visibleAtSignal).toHaveLength(2);
		const artifacts = await listArtifacts(t.db, USER, issue.id);
		expect(
			artifacts
				.map((artifact) => [artifact.name, artifact.artifact_type])
				.sort(([a], [b]) => a.localeCompare(b))
		).toEqual([
			['notes', 'file'],
			['screen', 'file']
		]);
		const versions = t.all(
			'SELECT filename, content_type, size_bytes, r2_key FROM artifact_version ORDER BY filename'
		) as { filename: string; content_type: string; size_bytes: number; r2_key: string }[];
		expect(
			versions.map((version) => [version.filename, version.content_type, version.size_bytes])
		).toEqual([
			['Screen.png', 'image/png', 3],
			['notes.txt', 'text/plain', 5]
		]);
		expect(await getArtifactStore(t.env).get(versions[0].r2_key)).toEqual(
			new Uint8Array([1, 2, 3])
		);
		const payloads = t.all("SELECT payload FROM event WHERE type = 'context.created'") as {
			payload: string;
		}[];
		expect(payloads.map((row) => JSON.parse(row.payload).scope.label)).toEqual([
			`issue ${issue.project_name}/${issue.number}`,
			`issue ${issue.project_name}/${issue.number}`
		]);
	});

	it('rejects duplicate names before creating an issue or writing bytes', async () => {
		const t = createTestDb();
		seedBase(t);
		const file = (name: string) => ({
			name,
			filename: `${name}.txt`,
			contentType: 'text/plain',
			body: new Blob(['x'])
		});
		await expect(
			createIssue(t.db, t.env, human, TEST_NOOP_DISPATCH_EFFECTS, PROJECT, { title: 'Nope' }, [
				file('same'),
				file('same')
			])
		).rejects.toMatchObject({ code: 'duplicate_artifact_name' });
		expect(t.all('SELECT id FROM issue')).toEqual([]);
		expect(t.all("SELECT id FROM context_item WHERE kind = 'artifact'")).toEqual([]);
	});

	it('leaves no database rows or dispatch when a later object put fails', async () => {
		const t = createTestDb();
		seedBase(t);
		let puts = 0;
		t.env.ARTIFACTS = {
			put: async () => {
				puts++;
				if (puts === 2) throw new Error('injected second object failure');
			}
		} as unknown as NonNullable<Env['ARTIFACTS']>;
		const effects = recordDispatchEffects();
		await expect(
			createIssue(t.db, t.env, human, effects, PROJECT, { title: 'No partial publish' }, [
				file('first'),
				file('second')
			])
		).rejects.toThrow('injected second object failure');
		expect(puts).toBe(2);
		expect(effects.count()).toBe(0);
		for (const table of [
			'issue',
			'issue_address',
			'scheduled_task',
			'label',
			'context_item',
			'artifact_version',
			'event'
		]) {
			expect(t.all(`SELECT * FROM ${table}`), table).toEqual([]);
		}
	});

	it('rolls back every composed row and stays silent on a late batch failure', async () => {
		const t = createTestDb();
		seedBase(t);
		const effects = recordDispatchEffects();
		const realBatch = t.env.DB.batch.bind(t.env.DB);
		const lateFailure = t.env.DB.prepare(
			'INSERT INTO project (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
		).bind(PROJECT, USER, 'duplicate', 0, 0);
		t.env.DB.batch = (statements) => realBatch([...statements, lateFailure]);
		await expect(
			createIssue(
				t.db,
				t.env,
				human,
				effects,
				PROJECT,
				{
					title: 'Composed create',
					labels: ['new-label'],
					schedule: { preset: { kind: 'daily', time: '09:00' } }
				},
				[file('reference')]
			)
		).rejects.toThrow();
		expect(effects.count()).toBe(0);
		for (const table of [
			'issue',
			'issue_address',
			'scheduled_task',
			'label',
			'context_item',
			'artifact_version',
			'event'
		]) {
			expect(t.all(`SELECT * FROM ${table}`), table).toEqual([]);
		}
	});

	it('signals once after files are readable and keeps the commit when response reads fail', async () => {
		const t = createTestDb();
		seedBase(t);
		let signals = 0;
		const reads: Promise<Uint8Array | null>[] = [];
		await expect(
			createIssue(
				t.db,
				t.env,
				human,
				{
					signalDispatch() {
						signals++;
						const versions = t.all('SELECT r2_key FROM artifact_version') as {
							r2_key: string;
						}[];
						expect(versions).toHaveLength(2);
						for (const { r2_key } of versions) {
							reads.push(getArtifactStore(t.env).get(r2_key));
						}
						t.sqlite.exec('DROP TABLE comment');
					}
				},
				PROJECT,
				{ title: 'Committed despite response failure' },
				[file('one'), file('two')]
			)
		).rejects.toThrow();
		expect(signals).toBe(1);
		expect(await Promise.all(reads)).toEqual([
			new TextEncoder().encode('one'),
			new TextEncoder().encode('two')
		]);
		expect(t.all('SELECT id FROM issue')).toHaveLength(1);
		expect(t.all("SELECT id FROM context_item WHERE kind = 'artifact'")).toHaveLength(2);
	});

	it('composes labels and recurrence while later instances do not copy files', async () => {
		const t = createTestDb();
		seedBase(t);
		const created = await createIssue(
			t.db,
			t.env,
			human,
			TEST_NOOP_DISPATCH_EFFECTS,
			PROJECT,
			{
				title: 'Daily references',
				labels: ['new-label'],
				schedule: { preset: { kind: 'daily', time: '09:00' } }
			},
			[file('reference')]
		);
		expect(created.labels.map((label) => label.name)).toEqual(['new-label']);
		expect(created.schedule).toBeDefined();
		expect(t.all("SELECT id FROM event WHERE type = 'label.created'")).toHaveLength(1);
		expect(await listArtifacts(t.db, USER, created.id)).toHaveLength(1);
		const nextId = await runScheduleNow(
			t.db,
			t.env,
			human,
			TEST_NOOP_DISPATCH_EFFECTS,
			created.schedule!.id
		);
		expect(await listArtifacts(t.db, USER, nextId)).toEqual([]);
	});

	it('derives each event scope from its own concurrently allocated issue number', async () => {
		const t = createTestDb();
		seedBase(t);
		const [first, second] = await Promise.all([
			createIssue(t.db, t.env, human, TEST_NOOP_DISPATCH_EFFECTS, PROJECT, { title: 'A' }, [
				file('a')
			]),
			createIssue(t.db, t.env, human, TEST_NOOP_DISPATCH_EFFECTS, PROJECT, { title: 'B' }, [
				file('b')
			])
		]);
		expect(first.number).not.toBe(second.number);
		const payloads = t.all(
			"SELECT issue_id, payload FROM event WHERE type = 'context.created'"
		) as { issue_id: string; payload: string }[];
		const labels = new Map(
			payloads.map((row) => [row.issue_id, JSON.parse(row.payload).scope.label as string])
		);
		expect(labels.get(first.id)).toBe(`issue ${first.project_name}/${first.number}`);
		expect(labels.get(second.id)).toBe(`issue ${second.project_name}/${second.number}`);
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
