/**
 * The write half of state inheritance (Tines/238): `resolveInheritance`'s
 * validation, and the batch ordering `createWorkflow` / `updateWorkflow` /
 * `deleteWorkflow` need because the pointer is a self-FK with no `ON DELETE`
 * action — pointers are written in a second pass after every insert, and every
 * pointer onto a state about to vanish is nulled before the delete. Those
 * orderings are invisible in a green suite until they fail as a raw
 * `FOREIGN KEY constraint failed`, so they are exercised here against the real
 * schema (`createTestDb`, actual migrations, foreign keys ON).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkflowStateInput } from '@tines/shared';
import { NOW, USER, addIssue, eventsOfType, seedBase } from '../supervisor/test-fixtures';
import { ApiFail, type ActorContext } from './core';
import { createWorkflow, deleteWorkflow, updateWorkflow } from './workflows';
import { createTestDb, type TestDb } from './test-db';

const session: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

/** The standard workflow's `Open`, the one state every user can see but not own. */
const STD_OPEN = 'wfs_std_open';

let t: TestDb;

beforeEach(() => {
	t = createTestDb();
	seedBase(t);
});

/** The stored pointer, read raw: `loadWorkflow` is not the thing under test. */
function storedPointer(stateId: string): string | null {
	const row = t.all('SELECT inherits_from_state_id AS p FROM workflow_state WHERE id = ?', stateId);
	return (row[0]?.p as string | null) ?? null;
}

function stateNamed(wf: { states: { id: string; name: string }[] }, name: string): string {
	const s = wf.states.find((x) => x.name === name);
	if (!s) throw new Error(`no state named ${name}`);
	return s.id;
}

/** A workflow of single-state stages, `Root` first, each free of transitions. */
async function makeWorkflow(name: string, states: string[]) {
	return createWorkflow(t.db, t.env, session, {
		name,
		initial_state: states[0],
		states: states.map((s) => ({ name: s, category: 'backlog' as const })),
		transitions: []
	});
}

async function failure(fn: () => Promise<unknown>): Promise<ApiFail> {
	try {
		await fn();
	} catch (e) {
		if (e instanceof ApiFail) return e;
		throw e;
	}
	throw new Error('expected an ApiFail');
}

/** A second user with a workflow of their own — the visibility boundary. */
function addOtherUsersState(): string {
	t.sqlite.exec(`
		INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
			VALUES ('u2', 'bob', 'b@example.com', 1, ${NOW}, ${NOW});
		INSERT INTO workflow (id, user_id, name, initial_state_id, created_at, updated_at)
			VALUES ('wf_bob', 'u2', 'Bob stages', 'wfs_bob_a', ${NOW}, ${NOW});
		INSERT INTO workflow_state (id, workflow_id, name, category, position, created_at)
			VALUES ('wfs_bob_a', 'wf_bob', 'Bob A', 'backlog', 0, ${NOW});
	`);
	return 'wfs_bob_a';
}

describe('createWorkflow', () => {
	it('stores an intra-workflow pointer in the second pass', async () => {
		// The base is *after* its child in the state list on purpose: a self-FK
		// cannot be satisfied by an insert whose target comes later in the same
		// batch, which is what the second pass exists for.
		const wf = await createWorkflow(t.db, t.env, session, {
			name: 'Engineering',
			initial_state: 'Child',
			states: [
				{ name: 'Child', category: 'backlog', inherits_from: 'Base' },
				{ name: 'Base', category: 'backlog' }
			],
			transitions: []
		});
		const child = stateNamed(wf, 'Child');
		const base = stateNamed(wf, 'Base');
		expect(storedPointer(child)).toBe(base);
		expect(wf.states.find((s) => s.name === 'Child')?.inherits_from).toBe(base);
		expect(wf.states.find((s) => s.name === 'Base')?.inherits_from).toBeNull();
	});

	it('reports the new pointers on the created event', async () => {
		await createWorkflow(t.db, t.env, session, {
			name: 'Engineering',
			initial_state: 'Child',
			states: [
				{ name: 'Child', category: 'backlog', inherits_from: 'Base' },
				{ name: 'Base', category: 'backlog' }
			],
			transitions: []
		});
		expect(eventsOfType(t, 'workflow.created')[0].payload.inheritance_changed).toEqual([
			{ workflow: 'Engineering', state: 'Child', from: null, to: 'Engineering / Base' }
		]);
	});

	it('leaves the payload key off a workflow with no pointers', async () => {
		await makeWorkflow('Plain', ['Root']);
		expect(eventsOfType(t, 'workflow.created')[0].payload.inheritance_changed).toBeUndefined();
	});

	it('accepts a state of the shared standard workflow as a base', async () => {
		const wf = await createWorkflow(t.db, t.env, session, {
			name: 'Engineering',
			initial_state: 'Child',
			states: [{ name: 'Child', category: 'backlog', inherits_from: STD_OPEN }],
			transitions: []
		});
		expect(storedPointer(stateNamed(wf, 'Child'))).toBe(STD_OPEN);
	});

	it('refuses a base that does not exist', async () => {
		const fail = await failure(() =>
			createWorkflow(t.db, t.env, session, {
				name: 'Engineering',
				initial_state: 'Child',
				states: [{ name: 'Child', category: 'backlog', inherits_from: 'wfs_nope' }],
				transitions: []
			})
		);
		expect(fail.status).toBe(422);
		expect(fail.code).toBe('unknown_state');
		expect(fail.message).toContain('wfs_nope');
	});

	it("refuses another user's state as a base", async () => {
		const bob = addOtherUsersState();
		const fail = await failure(() =>
			createWorkflow(t.db, t.env, session, {
				name: 'Engineering',
				initial_state: 'Child',
				states: [{ name: 'Child', category: 'backlog', inherits_from: bob }],
				transitions: []
			})
		);
		expect(fail.code).toBe('unknown_state');
	});

	it('refuses a state that inherits from itself', async () => {
		const fail = await failure(() =>
			createWorkflow(t.db, t.env, session, {
				name: 'Engineering',
				initial_state: 'Solo',
				states: [{ name: 'Solo', category: 'backlog', inherits_from: 'Solo' }],
				transitions: []
			})
		);
		expect(fail.code).toBe('self_inheritance');
		expect(fail.message).toContain('Solo');
	});

	it('accepts a three-state chain and refuses a four-state one', async () => {
		const ok = await createWorkflow(t.db, t.env, session, {
			name: 'Three',
			initial_state: 'Leaf',
			states: [
				{ name: 'Leaf', category: 'backlog', inherits_from: 'Middle' },
				{ name: 'Middle', category: 'backlog', inherits_from: 'Root' },
				{ name: 'Root', category: 'backlog' }
			],
			transitions: []
		});
		expect(storedPointer(stateNamed(ok, 'Leaf'))).toBe(stateNamed(ok, 'Middle'));
		expect(storedPointer(stateNamed(ok, 'Middle'))).toBe(stateNamed(ok, 'Root'));

		const fail = await failure(() =>
			createWorkflow(t.db, t.env, session, {
				name: 'Four',
				initial_state: 'Leaf',
				states: [
					{ name: 'Leaf', category: 'backlog', inherits_from: 'Middle' },
					{ name: 'Middle', category: 'backlog', inherits_from: 'Upper' },
					{ name: 'Upper', category: 'backlog', inherits_from: 'Root' },
					{ name: 'Root', category: 'backlog' }
				],
				transitions: []
			})
		);
		expect(fail.status).toBe(422);
		expect(fail.code).toBe('inheritance_too_deep');
		expect(fail.message).toContain('4 states long');
	});
});

describe('updateWorkflow pointers', () => {
	let wfId: string;
	let child: string;
	let base: string;
	let spare: string;

	beforeEach(async () => {
		const wf = await makeWorkflow('Engineering', ['Base', 'Child', 'Spare']);
		wfId = wf.id;
		base = stateNamed(wf, 'Base');
		child = stateNamed(wf, 'Child');
		spare = stateNamed(wf, 'Spare');
		await updateWorkflow(t.db, t.env, session, wfId, {
			states: [
				{ id: base, name: 'Base', category: 'backlog' },
				{ id: child, name: 'Child', category: 'backlog', inherits_from: base },
				{ id: spare, name: 'Spare', category: 'backlog' }
			]
		});
	});

	/**
	 * Every `inheritance_changed` payload emitted so far. Two events written in
	 * the same millisecond order arbitrarily (`ORDER BY created_at, id`, random
	 * ids), so tests assert over the set rather than over "the last one".
	 */
	const updateChanges = () =>
		eventsOfType(t, 'workflow.updated').map((e) => e.payload.inheritance_changed);

	/** The state array the workflow editor round-trips: no `inherits_from` key. */
	const editorShaped = (): WorkflowStateInput[] => [
		{ id: base, name: 'Base', category: 'backlog' },
		{ id: child, name: 'Child', category: 'backlog' },
		{ id: spare, name: 'Spare', category: 'backlog' }
	];

	it('sets a pointer on an existing state', async () => {
		expect(storedPointer(child)).toBe(base);
		expect(updateChanges()).toEqual([
			[{ workflow: 'Engineering', state: 'Child', from: null, to: 'Engineering / Base' }]
		]);
	});

	it('keeps the pointer through a PATCH that only renames the workflow', async () => {
		await updateWorkflow(t.db, t.env, session, wfId, { name: 'Eng' });
		expect(storedPointer(child)).toBe(base);
	});

	it('keeps the pointer through an editor-shaped state round-trip', async () => {
		// Absent means unchanged: three callers rebuild the array as
		// `{id, name, category}`, and replace semantics would silently wipe
		// every pointer on the first unrelated save.
		await updateWorkflow(t.db, t.env, session, wfId, { states: editorShaped() });
		expect(storedPointer(child)).toBe(base);
		// Only the setup's event carries a change; this one moved nothing.
		expect(updateChanges().filter((c) => c !== undefined)).toHaveLength(1);
	});

	it('clears the pointer on an explicit null', async () => {
		const states = editorShaped();
		states[1].inherits_from = null;
		await updateWorkflow(t.db, t.env, session, wfId, { states });
		expect(storedPointer(child)).toBeNull();
		expect(updateChanges()).toContainEqual([
			{ workflow: 'Engineering', state: 'Child', from: 'Engineering / Base', to: null }
		]);
	});

	it('re-points the pointer at another state', async () => {
		const states = editorShaped();
		states[1].inherits_from = spare;
		await updateWorkflow(t.db, t.env, session, wfId, { states });
		expect(storedPointer(child)).toBe(spare);
		expect(updateChanges()).toContainEqual([
			{
				workflow: 'Engineering',
				state: 'Child',
				from: 'Engineering / Base',
				to: 'Engineering / Spare'
			}
		]);
	});

	it('refuses a cycle across workflows', async () => {
		const other = await makeWorkflow('Other', ['Far']);
		const far = stateNamed(other, 'Far');
		// Far → Child is fine; Base → Far then closes Base → Far → Child → Base.
		await updateWorkflow(t.db, t.env, session, other.id, {
			states: [{ id: far, name: 'Far', category: 'backlog', inherits_from: child }]
		});
		const states = editorShaped();
		states[0].inherits_from = far;
		const fail = await failure(() => updateWorkflow(t.db, t.env, session, wfId, { states }));
		expect(fail.status).toBe(422);
		expect(fail.code).toBe('inheritance_cycle');
		expect(fail.message).toContain('Engineering / Base');
		expect(storedPointer(base)).toBeNull();
	});

	it('refuses a chain that a descendant elsewhere would push past the cap', async () => {
		// Child already inherits Base. Hang two more states off Child, then try
		// to give Base a parent: the request's own walk is fine, the descendants'
		// is not.
		const below = await makeWorkflow('Below', ['L1', 'L2']);
		const l1 = stateNamed(below, 'L1');
		const l2 = stateNamed(below, 'L2');
		await updateWorkflow(t.db, t.env, session, below.id, {
			states: [
				{ id: l1, name: 'L1', category: 'backlog', inherits_from: child },
				{ id: l2, name: 'L2', category: 'backlog' }
			]
		});
		const states = editorShaped();
		states[0].inherits_from = spare;
		const fail = await failure(() => updateWorkflow(t.db, t.env, session, wfId, { states }));
		expect(fail.code).toBe('inheritance_too_deep');
		expect(fail.message).toContain('Below / L1');
		expect(storedPointer(base)).toBeNull();
	});

	it('refuses to remove a state other states inherit from, then clears on force', async () => {
		const fail = await failure(() =>
			updateWorkflow(t.db, t.env, session, wfId, {
				states: [
					{ id: child, name: 'Child', category: 'backlog' },
					{ id: spare, name: 'Spare', category: 'backlog' }
				],
				initial_state: child
			})
		);
		expect(fail.status).toBe(422);
		expect(fail.code).toBe('state_inherited');
		// Singular reads as a sentence, and the child is named in full.
		expect(fail.message).toContain('1 state inherits context from it: Engineering / Child');
		expect(storedPointer(child)).toBe(base);

		const forced = await updateWorkflow(t.db, t.env, session, wfId, {
			states: [
				{ id: child, name: 'Child', category: 'backlog' },
				{ id: spare, name: 'Spare', category: 'backlog' }
			],
			initial_state: child,
			force_clear_inheritance: true
		});
		expect(storedPointer(child)).toBeNull();
		expect(t.all('SELECT id FROM workflow_state WHERE id = ?', base)).toHaveLength(0);
		expect(forced.cleared_inheritance).toEqual([
			{
				state_id: child,
				state_name: 'Child',
				workflow_id: wfId,
				workflow_name: 'Engineering',
				was: 'Engineering / Base'
			}
		]);
		expect(updateChanges()).toContainEqual([
			{ workflow: 'Engineering', state: 'Child', from: 'Engineering / Base', to: null }
		]);
	});

	it('needs no force when the same PATCH re-points the child away', async () => {
		await updateWorkflow(t.db, t.env, session, wfId, {
			states: [
				{ id: child, name: 'Child', category: 'backlog', inherits_from: null },
				{ id: spare, name: 'Spare', category: 'backlog' }
			],
			initial_state: child
		});
		expect(storedPointer(child)).toBeNull();
		expect(t.all('SELECT id FROM workflow_state WHERE id = ?', base)).toHaveLength(0);
	});

	it('refuses re-pointing a kept state at a state the same PATCH removes', async () => {
		// The doomed base is still stored when validation runs, so without an
		// explicit check this reaches the batch and dies on the FK as a 500.
		const fail = await failure(() =>
			updateWorkflow(t.db, t.env, session, wfId, {
				states: [
					{ id: base, name: 'Base', category: 'backlog' },
					{ id: child, name: 'Child', category: 'backlog', inherits_from: spare }
				],
				initial_state: base
			})
		);
		expect(fail.status).toBe(422);
		expect(fail.code).toBe('inheritance_target_removed');
		expect(fail.message).toContain('Spare');
		expect(storedPointer(child)).toBe(base);
		expect(t.all('SELECT id FROM workflow_state WHERE id = ?', spare)).toHaveLength(1);
	});
});

describe('deleteWorkflow', () => {
	it('deletes a workflow whose pointers are all internal', async () => {
		const wf = await createWorkflow(t.db, t.env, session, {
			name: 'Engineering',
			initial_state: 'Child',
			states: [
				{ name: 'Child', category: 'backlog', inherits_from: 'Base' },
				{ name: 'Base', category: 'backlog' }
			],
			transitions: []
		});
		const res = await deleteWorkflow(t.db, t.env, session, wf.id);
		expect(res.cleared_inheritance).toEqual([]);
		expect(t.all('SELECT id FROM workflow WHERE id = ?', wf.id)).toHaveLength(0);
	});

	it('refuses a workflow another workflow inherits from, then clears on force', async () => {
		const baseWf = await makeWorkflow('Shared stages', ['Merging']);
		const merging = stateNamed(baseWf, 'Merging');
		const childWf = await makeWorkflow('Engineering', ['Review']);
		const review = stateNamed(childWf, 'Review');
		await updateWorkflow(t.db, t.env, session, childWf.id, {
			states: [{ id: review, name: 'Review', category: 'backlog', inherits_from: merging }]
		});

		const fail = await failure(() => deleteWorkflow(t.db, t.env, session, baseWf.id));
		expect(fail.status).toBe(422);
		expect(fail.code).toBe('workflow_inherited');
		expect(fail.message).toContain('1 state in another workflow inherits context from it');
		expect(fail.message).toContain('Engineering / Review');
		expect(storedPointer(review)).toBe(merging);

		const res = await deleteWorkflow(t.db, t.env, session, baseWf.id, {
			forceClearInheritance: true
		});
		expect(res.cleared_inheritance).toEqual([
			{
				state_id: review,
				state_name: 'Review',
				workflow_id: childWf.id,
				workflow_name: 'Engineering',
				was: 'Shared stages / Merging'
			}
		]);
		expect(storedPointer(review)).toBeNull();
		expect(t.all('SELECT id FROM workflow WHERE id = ?', baseWf.id)).toHaveLength(0);
		expect(eventsOfType(t, 'workflow.deleted').at(-1)!.payload.inheritance_changed).toEqual([
			{ workflow: 'Engineering', state: 'Review', from: 'Shared stages / Merging', to: null }
		]);
	});

	it('still refuses a workflow with issues before it looks at inheritance', async () => {
		const wf = await makeWorkflow('Engineering', ['Open']);
		addIssue(t, { workflow: wf.id, state: stateNamed(wf, 'Open') });
		const fail = await failure(() => deleteWorkflow(t.db, t.env, session, wf.id));
		expect(fail.code).toBe('workflow_in_use');
	});
});
