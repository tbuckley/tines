/**
 * Tines/608: revision-checked workflow saves. Every interleaving here is made
 * by wrapping `env.DB.batch` so a competing `updateWorkflow` commits after the
 * delayed request's reads and before its batch — the window the save
 * precondition exists to close.
 */
import { describe, expect, it } from 'vitest';
import type { UpdateWorkflowRequest, WorkflowResponse } from '@tines/shared';
import { USER, addIssue, seedBase } from '../supervisor/test-fixtures';
import type { ActorContext } from './core';
import { createTestDb, type TestDb } from './test-db';
import {
	TEST_NOOP_DISPATCH_EFFECTS as effects,
	recordDispatchEffects
} from './test-dispatch-effects';
import {
	createWorkflow,
	deleteWorkflow,
	loadWorkflow,
	setStateRunScope,
	updateWorkflow,
	workflowAsRequest,
	workflowConflict,
	workflowFingerprint
} from './workflows';

const actor: ActorContext = {
	userId: USER,
	userName: 'Alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

/** An env whose first batch waits for `competing` to commit, and records what it then sends. */
function delayedBy(t: TestDb, competing: () => Promise<unknown>) {
	const env = { ...t.env, DB: Object.create(t.env.DB) } as Env;
	const sent: string[] = [];
	let injected = false;
	env.DB.batch = async <T = unknown>(statements: Parameters<Env['DB']['batch']>[0]) => {
		if (!injected) {
			injected = true;
			await competing();
		}
		for (const s of statements as unknown as { sqlText: string }[]) sent.push(s.sqlText);
		return t.env.DB.batch<T>(statements);
	};
	return { env, sent };
}

/** The full definition as an editor would send it back. */
const input = (w: WorkflowResponse): UpdateWorkflowRequest => ({
	name: w.name,
	description: w.description,
	initial_state: w.initial_state_id,
	states: w.states.map((s) => ({ id: s.id, name: s.name, category: s.category })),
	transitions: w.transitions.map((t) => ({
		name: t.name,
		from: t.from_state_id,
		to: t.to_state_id,
		...(t.requires ? { requires: t.requires } : {})
	}))
});

async function setup() {
	const t = createTestDb();
	seedBase(t);
	const w = await createWorkflow(t.db, t.env, actor, {
		name: 'Example',
		initial_state: 'Open',
		states: [
			{ name: 'Open', category: 'active' },
			{ name: 'Triage', category: 'backlog' },
			{ name: 'Done', category: 'done' }
		],
		transitions: [
			{ name: 'Start', from: 'Triage', to: 'Open' },
			{ name: 'Finish', from: 'Open', to: 'Done' }
		]
	});
	return { t, w };
}

const TABLES = [
	'workflow',
	'workflow_state',
	'workflow_transition',
	'context_item',
	'event',
	'scheduled_task',
	'issue'
];
const snapshot = (t: TestDb) =>
	Object.fromEntries(
		TABLES.map((table) => [table, t.all(`SELECT * FROM ${table} ORDER BY rowid`)])
	);
const updatedEvents = (t: TestDb) =>
	t
		.all(`SELECT payload FROM event WHERE type = 'workflow.updated' ORDER BY rowid`)
		.map((e) => JSON.parse(e.payload as string) as Record<string, unknown>);

/**
 * Run `stale` against a definition `competing` changes underneath it, and
 * assert the refusal wrote nothing at all.
 */
async function refused(
	t: TestDb,
	w: WorkflowResponse,
	competing: UpdateWorkflowRequest,
	stale: UpdateWorkflowRequest
) {
	let afterCompeting: ReturnType<typeof snapshot> | undefined;
	const dispatch = recordDispatchEffects();
	const delayed = delayedBy(t, async () => {
		await updateWorkflow(t.db, t.env, actor, effects, w.id, competing);
		afterCompeting = snapshot(t);
	});
	await expect(
		updateWorkflow(t.db, delayed.env, actor, dispatch, w.id, stale)
	).rejects.toMatchObject({
		status: 409,
		code: 'workflow_conflict',
		details: {
			committed: false,
			expected_revision: stale.expected_revision ?? w.revision,
			current_revision: w.revision + 1,
			remedy: 'reload_workflow'
		}
	});
	expect(snapshot(t)).toEqual(afterCompeting);
	expect(dispatch.count()).toBe(0);
	expect(updatedEvents(t)).toHaveLength(1);
	return loadWorkflow(t.db, USER, w.id);
}

describe('workflow revision', () => {
	it('starts at 1, advances by exactly one per committed save, and names both ends in the event', async () => {
		const { t, w } = await setup();
		expect(w.revision).toBe(1);
		const described = await updateWorkflow(t.db, t.env, actor, effects, w.id, {
			description: 'x'
		});
		expect(described.revision).toBe(2);
		// A save with no differences still commits, emits an event and advances.
		const same = await updateWorkflow(t.db, t.env, actor, effects, w.id, input(described));
		expect(same.revision).toBe(3);
		expect(updatedEvents(t).map((e) => [e.base_revision, e.revision])).toEqual([
			[1, 2],
			[2, 3]
		]);
		// The graph revision is separate and only moves on a semantic change.
		expect(t.all('SELECT decision_revision FROM workflow WHERE id = ?', w.id)).toEqual([
			{ decision_revision: 0 }
		]);
	});

	it('is not advanced by a run-scope change', async () => {
		const { t, w } = await setup();
		const scoped = await setStateRunScope(t.db, t.env, actor, w.id, w.states[0].id, {
			run_scope: 'project'
		});
		expect(scoped.states[0].run_scope).toBe('project');
		expect(scoped.revision).toBe(1);
	});

	it('refuses any step other than one at the schema level', async () => {
		const { t, w } = await setup();
		for (const step of ['definition_revision + 2', 'definition_revision', '7']) {
			expect(() =>
				t.sqlite.prepare(`UPDATE workflow SET definition_revision = ${step} WHERE id = ?`).run(w.id)
			).toThrow(/workflow_definition_conflict/);
		}
		t.sqlite
			.prepare('UPDATE workflow SET definition_revision = definition_revision + 1 WHERE id = ?')
			.run(w.id);
		expect((await loadWorkflow(t.db, USER, w.id)).revision).toBe(2);
	});

	it('stays out of the fingerprint and the export request', async () => {
		const { t, w } = await setup();
		const request = workflowAsRequest(w);
		expect(request).not.toHaveProperty('revision');
		const before = workflowFingerprint(request);
		const later = await updateWorkflow(t.db, t.env, actor, effects, w.id, { description: 'x' });
		expect(later.revision).toBe(2);
		expect(workflowFingerprint(workflowAsRequest(later))).toBe(before);
	});
});

describe('expected_revision', () => {
	it('refuses a stale value before reading or writing anything else', async () => {
		const { t, w } = await setup();
		await updateWorkflow(t.db, t.env, actor, effects, w.id, {
			transitions: [
				...input(w).transitions!.filter((x) => x.name !== 'Finish'),
				{
					name: 'Finish',
					from: 'Open',
					to: 'Done',
					requires: [{ artifact: 'review', type: 'text' }]
				}
			]
		});
		const before = snapshot(t);
		const dispatch = recordDispatchEffects();
		// The third original reproduction: a full editor payload built from the
		// definition as it stood before the gate was added.
		const delayed = delayedBy(t, async () => {});
		await expect(
			updateWorkflow(t.db, delayed.env, actor, dispatch, w.id, {
				...input(w),
				expected_revision: w.revision
			})
		).rejects.toMatchObject({
			status: 409,
			code: 'workflow_conflict',
			details: { committed: false, expected_revision: 1, current_revision: 2 }
		});
		expect(delayed.sent).toEqual([]);
		expect(snapshot(t)).toEqual(before);
		expect(dispatch.count()).toBe(0);
		const kept = await loadWorkflow(t.db, USER, w.id);
		expect(kept.transitions.find((x) => x.name === 'Finish')?.requires).toEqual([
			{ artifact: 'review', type: 'text' }
		]);
	});

	it('commits when it matches the current revision', async () => {
		const { t, w } = await setup();
		const saved = await updateWorkflow(t.db, t.env, actor, effects, w.id, {
			name: 'Renamed',
			expected_revision: 1
		});
		expect(saved).toMatchObject({ name: 'Renamed', revision: 2 });
	});

	it('must be a positive integer', async () => {
		const { t, w } = await setup();
		for (const bad of [0, -1, 1.5, '1', null]) {
			await expect(
				updateWorkflow(t.db, t.env, actor, effects, w.id, {
					name: 'x',
					expected_revision: bad as unknown as number
				})
			).rejects.toMatchObject({
				status: 422,
				code: 'invalid_field',
				details: { field: 'expected_revision' }
			});
		}
		expect((await loadWorkflow(t.db, USER, w.id)).revision).toBe(1);
	});

	it('builds the conflict the route returns', () => {
		expect(workflowConflict(3, 5)).toMatchObject({
			status: 409,
			code: 'workflow_conflict',
			message:
				'This workflow changed after you read it. Reload it, review the changes, then save again.',
			details: {
				committed: false,
				expected_revision: 3,
				current_revision: 5,
				remedy: 'reload_workflow'
			}
		});
	});
});

describe('a save that lost the race is refused whole', () => {
	it('keeps a competing review gate against a delayed description-only PATCH', async () => {
		const { t, w } = await setup();
		const competing = input(w);
		competing.transitions![1].requires = [{ artifact: 'review', type: 'text' }];
		const kept = await refused(t, w, competing, { description: 'A edits description' });
		expect(kept.description).toBe('');
		expect(kept.transitions.find((x) => x.name === 'Finish')?.requires).toEqual([
			{ artifact: 'review', type: 'text' }
		]);
	});

	it('keeps a competing Review state and its actions against a delayed description-only PATCH', async () => {
		const { t, w } = await setup();
		const competing = input(w);
		competing.states!.splice(1, 0, { name: 'Review', category: 'awaiting_human' });
		competing.transitions = [
			{ name: 'Start', from: 'Triage', to: 'Open' },
			{ name: 'Submit', from: 'Open', to: 'Review' },
			{ name: 'Approve', from: 'Review', to: 'Done' }
		];
		const kept = await refused(t, w, competing, { description: 'A edits description' });
		expect(kept.states.map((s) => s.name)).toEqual(['Open', 'Review', 'Triage', 'Done']);
		expect(kept.transitions.map((x) => x.name).sort()).toEqual(['Approve', 'Start', 'Submit']);
	});

	it('keeps a competing rename, category and initial-state change', async () => {
		const { t, w } = await setup();
		const competing = input(w);
		competing.name = 'Renamed by B';
		competing.states![0].name = 'In progress';
		competing.states![1].category = 'active';
		competing.initial_state = w.states[1].id;
		const kept = await refused(t, w, competing, { description: 'A edits description' });
		expect(kept).toMatchObject({
			name: 'Renamed by B',
			description: '',
			initial_state_id: w.states[1].id
		});
		expect(kept.states.map((s) => `${s.name}:${s.category}`)).toEqual([
			'In progress:active',
			'Triage:active',
			'Done:done'
		]);
	});

	it('keeps a competing reorder with a new state, with no duplicate position', async () => {
		const { t, w } = await setup();
		const competing = input(w);
		competing.states = [
			competing.states![1],
			competing.states![0],
			{ name: 'Review', category: 'awaiting_human' },
			competing.states![2]
		];
		const kept = await refused(t, w, competing, { description: 'A edits description' });
		expect(kept.states.map((s) => `${s.position}:${s.name}`)).toEqual([
			'0:Triage',
			'1:Open',
			'2:Review',
			'3:Done'
		]);
	});

	it('answers a transitions-only PATCH racing a state removal with a conflict, not a 500', async () => {
		const { t, w } = await setup();
		const competing = input(w);
		competing.states = competing.states!.filter((s) => s.name !== 'Triage');
		competing.transitions = competing.transitions!.filter((x) => x.name !== 'Start');
		const kept = await refused(t, w, competing, {
			transitions: [
				...input(w).transitions!,
				{ name: 'Reopen', from: w.states[2].id, to: w.states[0].id }
			]
		});
		expect(kept.states.map((s) => s.name)).toEqual(['Open', 'Done']);
		expect(kept.transitions.map((x) => x.name)).toEqual(['Finish']);
	});

	it('refuses a state removal racing a state addition', async () => {
		const { t, w } = await setup();
		const competing = input(w);
		competing.states!.push({ name: 'Archive', category: 'done' });
		const stale = input(w);
		stale.states = stale.states!.filter((s) => s.name !== 'Triage');
		stale.transitions = stale.transitions!.filter((x) => x.name !== 'Start');
		const kept = await refused(t, w, competing, stale);
		expect(kept.states.map((s) => s.name)).toEqual(['Open', 'Triage', 'Done', 'Archive']);
		expect(kept.transitions.map((x) => x.name).sort()).toEqual(['Finish', 'Start']);
	});

	it('refuses a transition addition racing a transition removal', async () => {
		const { t, w } = await setup();
		const competing = input(w);
		competing.transitions = competing.transitions!.filter((x) => x.name !== 'Start');
		const stale = input(w);
		stale.transitions!.push({ name: 'Reopen', from: w.states[2].id, to: w.states[0].id });
		const kept = await refused(t, w, competing, stale);
		expect(kept.transitions.map((x) => x.name)).toEqual(['Finish']);
	});

	it('refuses a gate change racing a different gate change', async () => {
		const { t, w } = await setup();
		const competing = input(w);
		competing.transitions![1].requires = [{ artifact: 'review', type: 'text' }];
		const stale = input(w);
		stale.transitions![0].requires = [{ artifact: 'plan', type: 'text' }];
		const kept = await refused(t, w, competing, stale);
		expect(kept.transitions.map((x) => [x.name, x.requires?.[0].artifact]).sort()).toEqual([
			['Finish', 'review'],
			['Start', undefined]
		]);
	});

	it('refuses a metadata-only save racing another metadata-only save', async () => {
		const { t, w } = await setup();
		const kept = await refused(t, w, { name: 'Renamed by B' }, { description: 'A' });
		expect(kept).toMatchObject({ name: 'Renamed by B', description: '' });
	});

	it('refuses the { states }-only save the library import steps send', async () => {
		const { t, w } = await setup();
		const competing = input(w);
		competing.transitions![1].requires = [{ artifact: 'review', type: 'text' }];
		await refused(t, w, competing, { states: input(w).states });
	});

	it('writes nothing from a refused save that would sweep context, release work and signal dispatch', async () => {
		const { t, w } = await setup();
		const triage = w.states[1].id;
		t.sqlite
			.prepare(
				`INSERT INTO context_item(id,user_id,kind,name,description,workflow_state_id,position,version,created_at,updated_at)
				 VALUES('ctx_attached',?,'prompt','Attached','',?,0,1,1,1)`
			)
			.run(USER, triage);
		addIssue(t, { workflow: w.id, state: w.states[0].id });
		// The loser removes Triage (forcing its context away) and turns Done
		// active, which would signal dispatch had it committed.
		const stale = input(w);
		stale.states = stale.states!.filter((s) => s.id !== triage);
		stale.states[1].category = 'active';
		stale.transitions = [{ name: 'Finish', from: 'Open', to: w.states[2].id }];
		stale.force_delete_context = true;
		await refused(t, w, { name: 'Renamed by B' }, stale);
		expect(t.all('SELECT id FROM context_item')).toEqual([{ id: 'ctx_attached' }]);
		expect(t.all(`SELECT id FROM event WHERE type = 'context.deleted'`)).toEqual([]);
	});
});

describe('diff-only writes', () => {
	it('sends no state, transition or unchanged-column write for a description-only PATCH', async () => {
		const { t, w } = await setup();
		const recorded = delayedBy(t, async () => {});
		await updateWorkflow(t.db, recorded.env, actor, effects, w.id, { description: 'x' });
		expect(recorded.sent[0]).toMatch(
			/^UPDATE workflow SET definition_revision = \? WHERE id = \?$/
		);
		expect(recorded.sent.filter((s) => /workflow_state|workflow_transition/.test(s))).toEqual([]);
		const update = recorded.sent.find((s) => s.startsWith('update "workflow"'))!;
		expect(update).toContain('"description" = ?');
		expect(update).toContain('"updated_at" = ?');
		expect(update).not.toMatch(/"name"|"initial_state_id"|revision/);
	});

	it('updates only the kept states that differ from the base', async () => {
		const { t, w } = await setup();
		const renamed = input(w);
		renamed.states![2].name = 'Closed';
		const recorded = delayedBy(t, async () => {});
		const saved = await updateWorkflow(t.db, recorded.env, actor, effects, w.id, renamed);
		expect(recorded.sent.filter((s) => s.startsWith('update "workflow_state"'))).toHaveLength(1);
		expect(saved.states.map((s) => s.name)).toEqual(['Open', 'Triage', 'Closed']);
		expect(saved.transitions.map((x) => x.id)).toEqual(w.transitions.map((x) => x.id));
	});
});

describe('cross-table races', () => {
	it('answers 404 and records no event when the workflow is deleted mid-save', async () => {
		const { t, w } = await setup();
		const delayed = delayedBy(t, () => deleteWorkflow(t.db, t.env, actor, w.id));
		await expect(
			updateWorkflow(t.db, delayed.env, actor, effects, w.id, { description: 'x' })
		).rejects.toMatchObject({ status: 404 });
		expect(updatedEvents(t)).toEqual([]);
		const adding = await setup();
		const added = input(adding.w);
		added.states!.push({ name: 'Archive', category: 'done' });
		const racing = delayedBy(adding.t, () =>
			deleteWorkflow(adding.t.db, adding.t.env, actor, adding.w.id)
		);
		await expect(
			updateWorkflow(adding.t.db, racing.env, actor, effects, adding.w.id, added)
		).rejects.toMatchObject({ status: 404 });
		expect(updatedEvents(adding.t)).toEqual([]);
	});

	it('answers 409 conflict when an issue enters a state the save removes', async () => {
		const { t, w } = await setup();
		const stale = input(w);
		stale.states = stale.states!.filter((s) => s.name !== 'Triage');
		stale.transitions = stale.transitions!.filter((x) => x.name !== 'Start');
		const delayed = delayedBy(t, async () => {
			addIssue(t, { workflow: w.id, state: w.states[1].id });
		});
		const before = updatedEvents(t).length;
		await expect(
			updateWorkflow(t.db, delayed.env, actor, effects, w.id, stale)
		).rejects.toMatchObject({
			status: 409,
			code: 'conflict',
			message: 'The workflow or its issues changed while saving; reload and try again'
		});
		const kept = await loadWorkflow(t.db, USER, w.id);
		expect(kept.revision).toBe(1);
		expect(kept.states.map((s) => s.name)).toEqual(['Open', 'Triage', 'Done']);
		expect(updatedEvents(t)).toHaveLength(before);
	});
});
