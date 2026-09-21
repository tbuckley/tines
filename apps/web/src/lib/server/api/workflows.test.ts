import { describe, expect, it } from 'vitest';
import { getDb } from '$lib/server/db';
import { USER, addIssue, seedBase } from '../supervisor/test-fixtures';
import type {
	ArtifactRequirement,
	CreateWorkflowRequest,
	WorkflowStateInput,
	WorkflowTransitionInput
} from '@tines/shared';
import { ApiFail, type ActorContext } from './core';
import { createTestDb } from './test-db';
import { TEST_NOOP_DISPATCH_EFFECTS } from './test-dispatch-effects';
import {
	createWorkflow,
	deadEndWarnings,
	deleteWorkflow,
	diffTransitions,
	loadWorkflow,
	loadWorkflowForActor,
	loadWorkflows,
	loadWorkflowsForActor,
	resolveDef,
	updateWorkflow,
	workflowFingerprint
} from './workflows';

const actor: ActorContext = {
	userId: USER,
	userName: 'Alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

const states: WorkflowStateInput[] = [
	{ name: 'Open', category: 'active' },
	{ name: 'Review', category: 'awaiting_human' },
	{ name: 'Closed', category: 'done' }
];
const transitions: WorkflowTransitionInput[] = [
	{ name: 'Submit', from: 'Open', to: 'Review' },
	{ name: 'Send back', from: 'Review', to: 'Open' },
	{ name: 'Approve', from: 'Review', to: 'Closed' }
];

function failCode(fn: () => unknown): string {
	try {
		fn();
	} catch (e) {
		if (e instanceof ApiFail) return e.code;
		throw e;
	}
	throw new Error('expected resolveDef to throw');
}

describe('resolveDef', () => {
	it('resolves a valid definition, assigning ids and positions', () => {
		const def = resolveDef(states, transitions, 'Open', []);
		expect(def.states).toHaveLength(3);
		expect(def.states.map((s) => s.position)).toEqual([0, 1, 2]);
		expect(def.states.every((s) => s.isNew && s.id.startsWith('wfs_'))).toBe(true);
		expect(def.initialStateId).toBe(def.states[0].id);
		expect(def.transitions).toHaveLength(3);
		const byName = new Map(def.states.map((s) => [s.name, s.id]));
		expect(def.transitions[0]).toMatchObject({
			name: 'Submit',
			from_state_id: byName.get('Open'),
			to_state_id: byName.get('Review')
		});
	});

	it('resolves transition and initial refs by existing state id', () => {
		const existing = [{ id: 'wfs_x1', name: 'Open', category: 'active' as const }];
		const def = resolveDef(
			[
				{ id: 'wfs_x1', name: 'Renamed', category: 'active' },
				{ name: 'Done', category: 'done' }
			],
			[{ name: 'Finish', from: 'wfs_x1', to: 'Done' }],
			'wfs_x1',
			existing
		);
		expect(def.initialStateId).toBe('wfs_x1');
		expect(def.states[0]).toMatchObject({ id: 'wfs_x1', name: 'Renamed', isNew: false });
		expect(def.transitions[0].from_state_id).toBe('wfs_x1');
	});

	it('rejects an empty state list', () => {
		expect(failCode(() => resolveDef([], [], 'Open', []))).toBe('no_states');
	});

	it('rejects an invalid category', () => {
		const bad = [{ name: 'Open', category: 'bogus' as never }];
		expect(failCode(() => resolveDef(bad, [], 'Open', []))).toBe('invalid_category');
	});

	it('rejects duplicate state names', () => {
		const dup = [
			{ name: 'Open', category: 'active' as const },
			{ name: 'Open', category: 'done' as const }
		];
		expect(failCode(() => resolveDef(dup, [], 'Open', []))).toBe('duplicate_state_name');
	});

	it('rejects state ids that are not part of the workflow', () => {
		const foreign = [{ id: 'wfs_other', name: 'Open', category: 'active' as const }];
		expect(failCode(() => resolveDef(foreign, [], 'Open', []))).toBe('unknown_state');
	});

	it('rejects an initial state categorized done or awaiting_human', () => {
		const done = [{ name: 'Closed', category: 'done' as const }];
		expect(failCode(() => resolveDef(done, [], 'Closed', []))).toBe('invalid_initial_state');
	});

	it('rejects transitions referencing unknown states', () => {
		expect(
			failCode(() => resolveDef(states, [{ name: 'X', from: 'Open', to: 'Nowhere' }], 'Open', []))
		).toBe('unknown_state');
	});

	it('rejects self-transitions', () => {
		expect(
			failCode(() => resolveDef(states, [{ name: 'Loop', from: 'Open', to: 'Open' }], 'Open', []))
		).toBe('self_transition');
	});

	it('allows distinct actions between the same pair of states', () => {
		const parallel = [
			{ name: 'A', from: 'Open', to: 'Review' },
			{ name: 'B', from: 'Open', to: 'Review' }
		];
		expect(resolveDef(states, parallel, 'Open', []).transitions.map((t) => t.name)).toEqual([
			'A',
			'B'
		]);
	});

	it('rejects two same-named actions out of one state (case-insensitive)', () => {
		const dup = [
			{ name: 'reject', from: 'Review', to: 'Open' },
			{ name: 'Reject', from: 'Review', to: 'Closed' }
		];
		expect(failCode(() => resolveDef(states, dup, 'Open', []))).toBe('duplicate_action');
	});

	// Inheritance (Tines/238): `resolveDef` only does the syntax and the
	// resolution against this request's own states — existence, visibility,
	// cycles and depth are `resolveInheritance`'s DB half.
	it('resolves inherits_from naming a state in the same request', () => {
		const byName = resolveDef(
			[
				{ name: 'Base', category: 'backlog' },
				{ name: 'Child', category: 'active', inherits_from: 'Base' }
			],
			[],
			'Base',
			[]
		);
		expect(byName.states[1].inheritsFrom).toBe(byName.states[0].id);

		const existing = [{ id: 'wfs_b', name: 'Base', category: 'backlog' as const }];
		const byId = resolveDef(
			[
				{ id: 'wfs_b', name: 'Base', category: 'backlog' },
				{ name: 'Child', category: 'active', inherits_from: 'wfs_b' }
			],
			[],
			'Base',
			existing
		);
		expect(byId.states[1].inheritsFrom).toBe('wfs_b');
	});

	it('leaves a base it cannot see locally for the DB half to judge', () => {
		const def = resolveDef(
			[{ name: 'Child', category: 'active', inherits_from: 'wfs_elsewhere' }],
			[],
			'Child',
			[]
		);
		expect(def.states[0].inheritsFrom).toBe('wfs_elsewhere');
	});

	it('distinguishes an absent inherits_from from an explicit null', () => {
		const existing = [{ id: 'wfs_b', name: 'Base', category: 'backlog' as const }];
		const def = resolveDef(
			[
				{ id: 'wfs_b', name: 'Base', category: 'backlog' },
				{ name: 'Fresh', category: 'active' },
				{ id: 'wfs_c', name: 'Cleared', category: 'active', inherits_from: null }
			],
			[],
			'Base',
			[...existing, { id: 'wfs_c', name: 'Cleared', category: 'active' as const }]
		);
		// Absent on an existing state means "keep what is stored"; on a new
		// state, and on an explicit null, it means "no base".
		expect(def.states[0].inheritsFrom).toBeUndefined();
		expect(def.states[1].inheritsFrom).toBeNull();
		expect(def.states[2].inheritsFrom).toBeNull();
	});

	it('rejects a state inheriting from itself, by name or by id', () => {
		expect(
			failCode(() =>
				resolveDef([{ name: 'Solo', category: 'active', inherits_from: 'Solo' }], [], 'Solo', [])
			)
		).toBe('self_inheritance');
		const existing = [{ id: 'wfs_s', name: 'Solo', category: 'active' as const }];
		expect(
			failCode(() =>
				resolveDef(
					[{ id: 'wfs_s', name: 'Solo', category: 'active', inherits_from: 'wfs_s' }],
					[],
					'Solo',
					existing
				)
			)
		).toBe('self_inheritance');
	});

	it('rejects an inherits_from that is neither a string nor null', () => {
		expect(
			failCode(() =>
				resolveDef(
					[{ name: 'Child', category: 'active', inherits_from: 7 as never }],
					[],
					'Child',
					[]
				)
			)
		).toBe('invalid_field');
		expect(
			failCode(() =>
				resolveDef([{ name: 'Child', category: 'active', inherits_from: '  ' }], [], 'Child', [])
			)
		).toBe('invalid_field');
	});

	it('allows the same action name out of two different states', () => {
		const ok = [
			{ name: 'advance', from: 'Open', to: 'Review' },
			{ name: 'advance', from: 'Review', to: 'Closed' }
		];
		expect(() => resolveDef(states, ok, 'Open', [])).not.toThrow();
	});
});

describe('workflow state order persistence', () => {
	it('rewrites contiguous positions without changing references or an occupied state', async () => {
		const t = createTestDb();
		seedBase(t);
		const created = await createWorkflow(t.db, t.env, actor, {
			name: 'Reorder me',
			initial_state: 'Open',
			states,
			transitions: [
				transitions[0],
				{
					...transitions[2],
					requires: [
						{
							artifact: 'approval',
							type: 'text',
							content_type: 'text/markdown',
							description: 'The approval record'
						}
					]
				}
			]
		});
		const byName = new Map(created.states.map((state) => [state.name, state]));
		addIssue(t, {
			id: 'iss_reorder_occupied',
			workflow: created.id,
			state: byName.get('Review')!.id
		});

		const reordered = [byName.get('Closed')!, byName.get('Open')!, byName.get('Review')!];
		const updated = await updateWorkflow(
			t.db,
			t.env,
			actor,
			TEST_NOOP_DISPATCH_EFFECTS,
			created.id,
			{
				initial_state: byName.get('Open')!.id,
				states: reordered.map(({ id, name, category }) => ({ id, name, category })),
				transitions: created.transitions.map((transition) => ({
					name: transition.name,
					from: transition.from_state_id,
					to: transition.to_state_id,
					requires: transition.requires
				}))
			}
		);
		const reloaded = await loadWorkflow(t.db, USER, created.id);

		for (const workflow of [updated, reloaded]) {
			expect(workflow.states.map(({ id, position }) => ({ id, position }))).toEqual(
				reordered.map((state, position) => ({ id: state.id, position }))
			);
			expect(workflow.initial_state_id).toBe(byName.get('Open')!.id);
			expect(workflow.transitions).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						name: 'Submit',
						from_state_id: byName.get('Open')!.id,
						to_state_id: byName.get('Review')!.id
					}),
					expect.objectContaining({
						name: 'Approve',
						from_state_id: byName.get('Review')!.id,
						to_state_id: byName.get('Closed')!.id,
						requires: [
							{
								artifact: 'approval',
								type: 'text',
								content_type: 'text/markdown',
								description: 'The approval record'
							}
						]
					})
				])
			);
		}
		expect(
			t.all('SELECT workflow_id, state_id FROM issue WHERE id = ?', 'iss_reorder_occupied')
		).toEqual([{ workflow_id: created.id, state_id: byName.get('Review')!.id }]);
	});
});

describe('diffTransitions', () => {
	const submit = {
		name: 'Submit for review',
		from_state_id: 'progress',
		to_state_id: 'review',
		requires: [{ artifact: 'pr', type: 'pr' as const }]
	};
	const noBug = {
		name: 'No bug found',
		from_state_id: 'progress',
		to_state_id: 'review'
	};

	it('distinguishes additions and removals among parallel actions', () => {
		const abandon = { name: 'Abandon', from_state_id: 'progress', to_state_id: 'done' };
		expect(diffTransitions([submit, noBug], [submit, noBug, abandon])).toMatchObject({
			added: 1,
			removed: 0
		});
		expect(diffTransitions([submit, noBug], [submit])).toMatchObject({ added: 0, removed: 1 });
	});

	it('detects a requirement change on either parallel action', () => {
		const gatedNoBug = { ...noBug, requires: [{ artifact: 'explanation', type: 'text' as const }] };
		expect(diffTransitions([submit, noBug], [submit, gatedNoBug]).requirementsChanged).toBe(true);
		expect(diffTransitions([submit, noBug], [submit, noBug]).requirementsChanged).toBe(false);
	});

	it('retains an unambiguous action rename', () => {
		const renamed = { ...noBug, name: 'Nothing suitable found' };
		expect(diffTransitions([submit, noBug], [submit, renamed])).toEqual({
			added: 0,
			removed: 0,
			renamed: [{ from: 'No bug found', to: 'Nothing suitable found' }],
			requirementsChanged: false
		});
	});
});

describe('deadEndWarnings', () => {
	it('warns on non-done states with no way out', () => {
		const def = resolveDef(states, [{ name: 'Submit', from: 'Open', to: 'Review' }], 'Open', []);
		const warnings = deadEndWarnings(def);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('"Review"');
	});

	it('is quiet when every non-done state has an exit', () => {
		const def = resolveDef(states, transitions, 'Open', []);
		expect(deadEndWarnings(def)).toEqual([]);
	});
});

describe('workflowFingerprint', () => {
	/** A two-state shape the identity cases vary one field at a time. */
	const base: CreateWorkflowRequest = {
		name: 'Gate collision',
		initial_state: 'Work',
		states: [
			{ name: 'Work', category: 'active' },
			{ name: 'Done', category: 'done' }
		],
		transitions: [
			{
				name: 'Finish',
				from: 'Work',
				to: 'Done',
				requires: [
					{ artifact: 'pr', type: 'pr', description: 'Ship' },
					{ artifact: 'tests', type: 'text' }
				]
			}
		]
	};

	const fp = workflowFingerprint;
	/** `base` with one field replaced, for the "this field is identity" table. */
	const varied = (patch: Partial<CreateWorkflowRequest>): CreateWorkflowRequest => ({
		...base,
		...patch
	});
	/** Change one field on the first requirement while preserving both gates. */
	const variedRequirement = (
		patch: Partial<ArtifactRequirement>
	): Partial<CreateWorkflowRequest> => ({
		transitions: [
			{
				...base.transitions[0],
				requires: base.transitions[0].requires?.map((requirement, index) =>
					index === 0 ? { ...requirement, ...patch } : { ...requirement }
				)
			}
		]
	});

	it('separates a state list from one whose name spells the old delimiters', () => {
		// Tines/413: `Review:active|Done` used to serialize exactly as the two
		// states "Review" (active) and "Done" (done) did, so the importer
		// skipped a genuinely different graph as identical.
		const incoming: CreateWorkflowRequest = {
			name: 'Collision example',
			initial_state: 'Start',
			states: [
				{ name: 'Start', category: 'backlog' },
				{ name: 'Review', category: 'active' },
				{ name: 'Done', category: 'done' }
			],
			transitions: []
		};
		const existing: CreateWorkflowRequest = {
			...incoming,
			states: [
				{ name: 'Start', category: 'backlog' },
				{ name: 'Review:active|Done', category: 'done' }
			]
		};
		expect(fp(incoming)).not.toBe(fp(existing));
	});

	it('separates two gates from one whose description spells the second', () => {
		// The other half of Tines/413: a description of "Ship,tests:text::"
		// used to absorb the whole second requirement, hiding a gate.
		const existing = varied({
			transitions: [
				{
					name: 'Finish',
					from: 'Work',
					to: 'Done',
					requires: [{ artifact: 'pr', type: 'pr', description: 'Ship,tests:text::' }]
				}
			]
		});
		expect(fp(base)).not.toBe(fp(existing));
	});

	it('ignores the order transitions and requirements arrive in', () => {
		// Free text that would break any delimiter scheme: the separators
		// themselves, quotes, a backslash and a control character.
		const requires = [
			{ artifact: 'pr', type: 'pr' as const, description: 'a"b\\c|d:e,f\u0000g' },
			{ artifact: 'tests', type: 'text' as const, content_type: 'text/markdown' }
		];
		const transitions = [
			{ name: 'Finish', from: 'Work', to: 'Done', requires },
			{
				name: 'Reopen',
				from: 'Done',
				to: 'Work',
				requires: [{ artifact: 'why', type: 'text' as const }]
			}
		];
		const forward = varied({ transitions });
		const reversed = varied({
			transitions: [
				{ ...transitions[1] },
				{ ...transitions[0], requires: [...requires].reverse() }
			].reverse()
		});
		expect(fp(forward)).toBe(fp(reversed));
		// The comparison is read-only: sorting must not reorder the caller's
		// arrays, which are the request the caller is about to act on.
		expect(forward.transitions.map((t) => t.name)).toEqual(['Finish', 'Reopen']);
		expect(forward.transitions[0].requires?.map((r) => r.artifact)).toEqual(['pr', 'tests']);
	});

	it('keeps state order significant', () => {
		const swapped = varied({ states: [...base.states].reverse() });
		expect(fp(base)).not.toBe(fp(swapped));
	});

	const identityFields: [string, Partial<CreateWorkflowRequest>][] = [
		['initial state', { initial_state: 'Done' }],
		[
			'a state name',
			{
				states: [
					{ name: 'Working', category: 'active' },
					{ name: 'Done', category: 'done' }
				]
			}
		],
		[
			'a state category',
			{
				states: [
					{ name: 'Work', category: 'backlog' },
					{ name: 'Done', category: 'done' }
				]
			}
		],
		['a transition name', { transitions: [{ ...base.transitions[0], name: 'Complete' }] }],
		['a transition source', { transitions: [{ ...base.transitions[0], from: 'Done' }] }],
		['a transition destination', { transitions: [{ ...base.transitions[0], to: 'Work' }] }],
		['a requirement slot', variedRequirement({ artifact: 'diff' })],
		['a requirement type', variedRequirement({ type: 'file' })],
		['a requirement content type', variedRequirement({ content_type: 'text/markdown' })],
		['a requirement description', variedRequirement({ description: 'Land it' })],
		['a dropped requirement', { transitions: [{ ...base.transitions[0], requires: [] }] }]
	];

	it.each(identityFields)('changing %s changes identity', (_field, patch) => {
		expect(fp(base)).not.toBe(fp(varied(patch)));
	});

	it('ignores what is edited independently of the shape', () => {
		// Name, description, stage instructions and inheritance are all
		// deliberately outside structural identity — same-name matching lives
		// in the callers, and the importer compares pointers separately.
		const decorated = varied({
			name: 'Something else',
			description: 'A longer explanation',
			states: [
				{ id: 'wfs_abc', name: 'Work', category: 'active', prompt: 'Do the work.' },
				{ name: 'Done', category: 'done', inherits_from: 'Work' }
			]
		});
		expect(fp(base)).toBe(fp(decorated));
	});

	it('reads a missing requirement list as an empty one', () => {
		const missing = varied({ transitions: [{ name: 'Finish', from: 'Work', to: 'Done' }] });
		const empty = varied({
			transitions: [{ name: 'Finish', from: 'Work', to: 'Done', requires: [] }]
		});
		expect(fp(missing)).toBe(fp(empty));
	});

	it('reads an omitted optional requirement field as an empty one', () => {
		const omitted = varied({
			transitions: [{ ...base.transitions[0], requires: [{ artifact: 'pr', type: 'pr' }] }]
		});
		const blank = varied({
			transitions: [
				{
					...base.transitions[0],
					requires: [{ artifact: 'pr', type: 'pr', content_type: '', description: '' }]
				}
			]
		});
		expect(fp(omitted)).toBe(fp(blank));
	});
});

describe('loadWorkflows D1 parameter budget', () => {
	it.each([99, 100, 180])('hydrates %i owned workflows plus Standard', async (ownedCount) => {
		const t = createTestDb();
		seedBase(t);
		const actor = {
			userId: USER,
			userName: 'Alice',
			apiKeyId: null,
			apiKeyName: null,
			viaSession: true
		};
		const created = [];
		for (let i = 0; i < ownedCount; i++) {
			const workflow = await createWorkflow(t.db, t.env, actor, {
				name: `Workflow ${i.toString().padStart(3, '0')}`,
				initial_state: 'Second',
				states: [
					{ name: 'First', category: 'backlog' },
					{ name: 'Second', category: 'active', inherits_from: 'First' },
					{ name: 'Done', category: 'done' }
				],
				transitions: [
					{
						name: 'Finish',
						from: 'Second',
						to: 'Done',
						requires: [{ artifact: 'impl-pr', type: 'pr', description: `PR ${i}` }]
					}
				]
			});
			await t.db
				.updateTable('workflow')
				.set({ created_at: i + 1 })
				.where('id', '=', workflow.id)
				.execute();
			created.push(workflow);
		}

		const workflows = await loadWorkflows(getDb(t.env), USER);
		expect(workflows.map((workflow) => workflow.id)).toEqual([
			'wf_standard',
			...created.map((workflow) => workflow.id)
		]);
		expect(workflows).toHaveLength(ownedCount + 1);
		for (const index of [0, Math.min(89, ownedCount - 1), ownedCount - 1]) {
			if (index < 0) continue;
			const actual = workflows[index + 1];
			const expected = created[index];
			expect(actual.states.map((state) => state.name)).toEqual(['First', 'Second', 'Done']);
			expect(actual.initial_state_id).toBe(expected.initial_state_id);
			expect(actual.states[1].inherits_from).toBe(actual.states[0].id);
			expect(actual.transitions).toEqual(expected.transitions);
		}

		expect(await loadWorkflows(getDb(t.env), USER, created.at(-1)?.id)).toHaveLength(1);
		expect(await loadWorkflows(getDb(t.env), USER, 'wf_missing')).toEqual([]);
	});
});

describe('workflow permissions', () => {
	function scopedActor(access: 'read' | 'write' | 'delete'): ActorContext {
		return {
			...actor,
			apiKeyId: 'key_workflow',
			apiKeyName: 'workflow key',
			viaSession: false,
			permissions: {
				version: 1,
				projects: { access: 'read', scope: [] },
				workspace: access,
				control_plane: 'none'
			}
		};
	}

	function setup() {
		const t = createTestDb();
		seedBase(t);
		t.sqlite.exec(
			`INSERT INTO api_key (id, user_id, name, key_hash, key_prefix, created_at)
			 VALUES ('key_workflow', '${USER}', 'workflow key', 'hash_workflow', 'tines_workflow', 1)`
		);
		return t;
	}

	it('requires workspace read at request-facing loaders and write to create', async () => {
		const t = setup();
		const reader = scopedActor('read');
		addIssue(t);
		expect((await loadWorkflowsForActor(t.db, reader)).map((w) => w.id)).toContain('wf_standard');
		await expect(loadWorkflowForActor(t.db, reader, 'wf_standard')).resolves.toMatchObject({
			id: 'wf_standard',
			issue_count: 0
		});
		await expect(
			createWorkflow(t.db, t.env, reader, {
				name: 'Denied',
				states,
				transitions,
				initial_state: 'Open'
			})
		).rejects.toMatchObject({ status: 403, code: 'insufficient_permissions' });
		expect(t.all("SELECT id FROM workflow WHERE name = 'Denied'")).toEqual([]);
	});

	it('requires delete authority for destructive PATCH fields and workflow deletion', async () => {
		const t = setup();
		const workflow = await createWorkflow(t.db, t.env, actor, {
			name: 'Guarded',
			states,
			transitions,
			initial_state: 'Open'
		});
		const writer = scopedActor('write');

		await expect(
			updateWorkflow(t.db, t.env, writer, TEST_NOOP_DISPATCH_EFFECTS, workflow.id, {
				transitions: []
			})
		).rejects.toMatchObject({ status: 403, code: 'insufficient_permissions' });
		expect(
			t.all('SELECT id FROM workflow_transition WHERE workflow_id = ?', workflow.id)
		).toHaveLength(transitions.length);
		await expect(deleteWorkflow(t.db, t.env, writer, workflow.id)).rejects.toMatchObject({
			status: 403,
			code: 'insufficient_permissions'
		});
		expect(t.all('SELECT id FROM workflow WHERE id = ?', workflow.id)).toHaveLength(1);
	});

	it('requires project write before clearing default-workflow pointers', async () => {
		const t = setup();
		const workflow = await createWorkflow(t.db, t.env, actor, {
			name: 'Default',
			states,
			transitions,
			initial_state: 'Open'
		});
		t.sqlite.exec(`UPDATE project SET default_workflow_id = '${workflow.id}' WHERE id = 'prj_1'`);

		await expect(
			deleteWorkflow(t.db, t.env, scopedActor('delete'), workflow.id)
		).rejects.toMatchObject({ status: 403, code: 'insufficient_permissions' });
		expect(t.all('SELECT default_workflow_id FROM project WHERE id = ?', 'prj_1')[0]).toEqual({
			default_workflow_id: workflow.id
		});
	});
});
