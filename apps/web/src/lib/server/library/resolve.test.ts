import { describe, expect, it } from 'vitest';
import { withLibraryDocumentDigest, type WorkflowPackageChoices } from '@tines/shared';
import {
	inheritedPackage,
	automatedPackage
} from '../../../../../../packages/shared/src/library/fixtures';
import { createTestDb } from '../api/test-db';
import { USER, PROJECT, seedBase, addRunner } from '../supervisor/test-fixtures';
import { readPackageDestinationInternal, selectPackageDestination } from './destination';
import { allocatePackageObjects, resolvePackageDestination, resolvePackageNames } from './resolve';

async function fixture(scheduled = false) {
	const t = createTestDb();
	seedBase(t);
	const doc = await withLibraryDocumentDigest(scheduled ? automatedPackage() : inheritedPackage());
	const allocation = allocatePackageObjects(doc);
	const now = Date.now();
	const choices: WorkflowPackageChoices = {
		inputs: { 'input:1': { mode: 'create', name: 'qa', color: 'blue' } }
	};
	const resolve = async (chosen: unknown = choices) =>
		resolvePackageDestination(
			doc,
			chosen,
			(await readPackageDestinationInternal(t.db, USER)).data,
			allocation,
			now
		);
	return { t, doc, allocation, now, choices, resolve };
}

describe('destination package resolution (read-only)', () => {
	it('copies closure independently with rendered inherited instructions, skills and repo declarations', async () => {
		const f = await fixture();
		const before = f.t.sqlite.prepare('SELECT COUNT(*) AS n FROM event').get();
		const plan = await f.resolve();
		expect(plan.workflows.map((w) => w.name)).toEqual(['Reviewer', 'Shared']);
		expect(plan.inputs[0]).toMatchObject({
			mode: 'create',
			value: 'qa',
			id: f.allocation.labels['input:1'].id
		});
		expect(plan.context[0]).toMatchObject({ body: 'File work with label qa. Preserve {{date}}.' });
		expect(plan.context[1]).toEqual(f.doc.context[1]);
		expect(plan.context[2]).toEqual(f.doc.context[2]);
		expect(plan.workflows[0].states[0].inherits_from).toEqual({
			kind: 'bundled_state',
			state_id: 'state:3'
		});
		expect(plan.schedules).toEqual([]);
		expect(plan.routing).toEqual([]);
		expect(f.t.sqlite.prepare('SELECT COUNT(*) AS n FROM event').get()).toEqual(before);
		expect(await f.t.db.selectFrom('label').selectAll().execute()).toEqual([]);
	});
	it('renames both same-named main and dependency even when destination definitions are equal', async () => {
		const f = await fixture();
		f.doc.workflows[1].name = 'Reviewer';
		f.t.sqlite.exec(
			`INSERT INTO workflow(id,user_id,name,description,initial_state_id,created_at,updated_at) VALUES('existing','${USER}','Reviewer','','wfs_std_open',1,1)`
		);
		const plan = await f.resolve();
		expect(plan.workflows.map((w) => w.name)).toEqual([
			'Reviewer (imported)',
			'Reviewer (imported 2)'
		]);
		expect(new Set(Object.values(f.allocation.records).map((r) => r.id)).size).toBe(
			Object.keys(f.allocation.records).length
		);
		expect(() =>
			resolvePackageNames(f.doc.workflows, { 'workflow:1': 'Reviewer' }, ['Reviewer'])
		).toThrow('already in use');
	});
	it('reserves explicit choices before proposals and keeps Unicode names within 200 characters', () => {
		expect(
			resolvePackageNames(
				[
					{ id: 'a', name: 'Name' },
					{ id: 'b', name: 'Other' }
				],
				{ b: 'Name' },
				[]
			)
		).toEqual({ b: 'Name', a: 'Name (imported)' });
		const source = 'x'.repeat(187) + '🧪'.repeat(6);
		const names = resolvePackageNames([{ id: 'a', name: source }], {}, [source]);
		expect(names.a.length).toBeLessThanOrEqual(200);
		expect(names.a).toMatch(/ \(imported\)$/);
		expect(() => JSON.parse(JSON.stringify(names))).not.toThrow();
	});
	it('refuses silent label creation, supports unique case-insensitive defaults, and witnesses ordinary SQLite semantics', async () => {
		const f = await fixture();
		await expect(f.resolve({})).rejects.toMatchObject({ code: 'missing_input' });
		f.t.sqlite.exec(
			`INSERT INTO label(id,user_id,name,color,description,created_at,updated_at) VALUES('label','${USER}','QA','blue','',1,1)`
		);
		const plan = await f.resolve({});
		expect(plan.inputs[0]).toMatchObject({ mode: 'reuse', id: 'label', value: 'QA' });
		expect(plan.choices.inputs).toEqual({ 'input:1': { mode: 'reuse', id: 'label' } });
		await expect(f.resolve()).rejects.toMatchObject({ code: 'name_collision' });
	});
	it('never treats a default spelling as a destination ID', async () => {
		const f = await fixture();
		f.doc.inputs[0].default = 'label';
		f.doc.text_uses = [];
		f.t.sqlite.exec(
			`INSERT INTO label(id,user_id,name,color,description,created_at,updated_at) VALUES('label','${USER}','Different','blue','',1,1)`
		);
		await expect(f.resolve({})).rejects.toMatchObject({ code: 'missing_input' });
		expect(
			(await f.resolve({ inputs: { 'input:1': { mode: 'reuse', id: 'label' } } })).inputs[0].value
		).toBe('Different');
	});
	it('refuses foreign explicit references without disclosing the resource', async () => {
		const f = await fixture();
		await expect(
			f.resolve({ inputs: { 'input:1': { mode: 'reuse', id: 'foreign' } } })
		).rejects.toMatchObject({ status: 404 });
	});
	it('uses workflow default names only when unambiguous and enforces required states', async () => {
		const f = await fixture();
		f.doc.inputs.push({
			id: 'input:w',
			key: 'destination_workflow',
			type: 'workflow',
			label: 'Workflow',
			description: '',
			default: 'Standard',
			required: true,
			required_states: ['Open']
		});
		let plan = await f.resolve();
		expect(plan.inputs.find((i) => i.input_id === 'input:w')).toMatchObject({
			id: 'wf_standard',
			mode: 'reuse'
		});
		f.t.sqlite.exec(
			`INSERT INTO workflow(id,user_id,name,description,initial_state_id,created_at,updated_at) VALUES('second','${USER}','Standard','','wfs_std_open',1,1)`
		);
		await expect(f.resolve()).rejects.toMatchObject({ code: 'ambiguous_input' });
		await expect(
			f.resolve({
				...f.choices,
				inputs: { ...f.choices.inputs, 'input:w': { mode: 'reuse', id: 'second' } }
			})
		).rejects.toMatchObject({ code: 'missing_required_states' });
		plan = await f.resolve({
			...f.choices,
			inputs: { ...f.choices.inputs, 'input:w': { mode: 'reuse', id: 'wf_standard' } }
		});
		expect(plan.selection.workflow_ids).toEqual(['wf_standard']);
	});
	it('keeps required project inputs unused when all project-bound automation is omitted', async () => {
		const f = await fixture(true);
		const plan = await f.resolve();
		expect(plan.inputs.find((i) => i.type === 'project')).toMatchObject({
			mode: 'unused',
			id: null
		});
		expect(plan.selection.project_ids).toEqual([]);
		expect(plan.schedules).toEqual([]);
		expect(plan.skipped.some((s) => s.kind === 'schedule')).toBe(true);
	});
	it('requires a live project for selected schedules, preserves explicit start, and independently renames schedules by project', async () => {
		const f = await fixture(true);
		const projectInput = f.doc.inputs.find((i) => i.type === 'project')!;
		const schedule = f.doc.schedules[0];
		const choices = { ...f.choices, schedule_ids: [schedule.id] };
		await expect(f.resolve(choices)).rejects.toMatchObject({ code: 'missing_input' });
		const selected = {
			...choices,
			inputs: { ...f.choices.inputs, [projectInput.id]: { mode: 'reuse', id: PROJECT } }
		};
		const plan = await f.resolve(selected);
		expect(plan.schedules[0]).toMatchObject({
			project_id: PROJECT,
			definition: { start_state: schedule.start_state }
		});
		f.t.sqlite.exec(`UPDATE project SET archived_at=1 WHERE id='${PROJECT}'`);
		await expect(f.resolve(selected)).rejects.toMatchObject({ code: 'project_archived' });
	});
	it('evaluates tiers using actual destination runner rules and models, not source IDs or liveness', async () => {
		const f = await fixture();
		f.doc.routing = [{ id: 'routing:1', scope: { state_id: 'state:1' }, tier: 'smartest' }];
		f.allocation.records['routing:1'] = { id: 'rul_planned', event_id: 'evt_planned' };
		const choices = { ...f.choices, routing: { 'routing:1': 'smartest' } };
		await expect(f.resolve(choices)).rejects.toMatchObject({ code: 'routing_unavailable' });
		const runner = addRunner(f.t, { type: 'local', config: { harness: 'codex' } });
		f.t.sqlite
			.prepare(
				'INSERT INTO routing_rule(id,user_id,targets,created_at,updated_at) VALUES(?,?,?,1,1)'
			)
			.run('global', USER, JSON.stringify([{ runner_id: runner }]));
		const plan = await f.resolve(choices);
		expect(plan.routing[0]).toMatchObject({
			tier: 'smartest',
			runner_rule_id: 'global',
			targets: [{ runner_id: runner, supported: true, model: 'gpt-6-astra' }]
		});
		f.t.sqlite.exec(
			`UPDATE runner SET last_seen_at=0,backoff_until=9999999999999 WHERE id='${runner}'`
		);
		expect((await f.resolve(choices)).routing).toEqual(plan.routing);
		f.t.sqlite.exec(`UPDATE runner SET status='paused' WHERE id='${runner}'`);
		await expect(f.resolve(choices)).rejects.toMatchObject({ code: 'routing_unavailable' });
	});
	it('uses literal input values once and applies post-render ordinary limits', async () => {
		const f = await fixture();
		f.doc.inputs[0] = { ...f.doc.inputs[0], type: 'text' };
		const plan = await f.resolve({
			inputs: { 'input:1': { value: '{{filing_label:qa}} $HOME `code`' } }
		});
		expect(plan.context[0]).toMatchObject({
			body: 'File work with label {{filing_label:qa}} $HOME `code`. Preserve {{date}}.'
		});
		await expect(
			f.resolve({ inputs: { 'input:1': { value: 'x'.repeat(10000) } } })
		).rejects.toThrow();
	});
	it('selected SQL witness matches the same projection from the coherent initial snapshot', async () => {
		const f = await fixture();
		const initial = await readPackageDestinationInternal(f.t.db, USER);
		const plan = resolvePackageDestination(f.doc, f.choices, initial.data, f.allocation, f.now);
		const selected = await readPackageDestinationInternal(f.t.db, USER, plan.selection);
		expect(selected.data).toEqual(selectPackageDestination(initial.data, plan.selection));
		expect(JSON.parse(selected.raw)).toEqual(selected.data);
		expect(selected.raw).not.toMatch(/secret_enc|runner_token_hash|last_seen_at/);
	});
});

import { sql } from 'kysely';
import { compilePackageObjects } from './compile';
import { runAtomic } from '../api/core';
import { validatePackageBatch } from './budgets';
const actor = {
	userId: USER,
	userName: 'Alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};
describe('resolved package compilation', () => {
	for (const enabled of [false, true])
		it(`guards the complete compiled closure with predicate ${enabled}`, async () => {
			const f = await fixture(true);
			const plan = await f.resolve({
				...f.choices,
				inputs: { ...f.choices.inputs, 'input:2': { mode: 'reuse', id: PROJECT } },
				schedule_ids: ['schedule:1']
			});
			const queries = compilePackageObjects(
				f.t.db,
				actor,
				plan,
				f.allocation,
				{ predicate: sql<boolean>`${enabled ? 1 : 0}` },
				f.now
			);
			expect(validatePackageBatch(queries).statements).toBe(20);
			await runAtomic(f.t.env, queries);
			const workflows = await f.t.db
				.selectFrom('workflow')
				.selectAll()
				.where('user_id', '=', USER)
				.execute();
			expect(workflows).toHaveLength(enabled ? 2 : 0);
			expect(await f.t.db.selectFrom('context_item').selectAll().execute()).toHaveLength(
				enabled ? 3 : 0
			);
			expect(await f.t.db.selectFrom('scheduled_task').selectAll().execute()).toHaveLength(
				enabled ? 1 : 0
			);
			expect(await f.t.db.selectFrom('issue').selectAll().execute()).toHaveLength(0);
			if (enabled) {
				const state = await f.t.db
					.selectFrom('workflow_state')
					.select('inherits_from_state_id')
					.where('id', '=', f.allocation.records['state:1'].id)
					.executeTakeFirstOrThrow();
				expect(state.inherits_from_state_id).toBe(f.allocation.records['state:3'].id);
				const schedule = await f.t.db
					.selectFrom('scheduled_task')
					.selectAll()
					.executeTakeFirstOrThrow();
				expect(schedule).toMatchObject({
					enabled: 0,
					run_count: 0,
					last_run_at: null,
					state_id: null
				});
			} else expect(await f.t.db.selectFrom('event').selectAll().execute()).toEqual([]);
		});
});
