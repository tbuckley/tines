import { describe, expect, it } from 'vitest';
import { withLibraryDocumentDigest, type LibraryV3Document } from '@tines/shared';
import { USER, seedBase } from '../supervisor/test-fixtures';
import { createTestDb } from './test-db';
import { createWorkflow, loadWorkflows } from './workflows';
import { applyImport } from './library';
import { buildLibraryV3Document } from './library-v3-export';
import { createContextItem } from './context';
import { createProject } from './projects';
import { createLabel } from './labels';

const actor = {
	userId: USER,
	userName: 'Alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};
function setup() {
	const t = createTestDb();
	seedBase(t);
	return t;
}
async function fixture() {
	const t = setup();
	const first = await createWorkflow(t.db, t.env, actor, {
		name: 'Same / name',
		initial_state: 'Ready / now',
		states: [{ name: 'Ready / now', category: 'active' }],
		transitions: []
	});
	const second = await createWorkflow(t.db, t.env, actor, {
		name: 'Same / name',
		initial_state: 'Ready / now',
		states: [{ name: 'Ready / now', category: 'active', inherits_from: first.states[0].id }],
		transitions: []
	});
	for (const [wf, body] of [
		[first, 'FIRST'],
		[second, 'SECOND']
	] as const)
		await createContextItem(t.db, t.env, actor, {
			kind: 'prompt',
			name: 'instructions',
			body,
			workflow_state_id: wf.states[0].id
		});
	return { document: await buildLibraryV3Document(t.db, USER), t, first, second };
}
const workflowEntries = (result: Awaited<ReturnType<typeof applyImport>>) =>
	result.entries.filter((e) => e.section === 'workflow');

describe('ID-addressed whole-library import', () => {
	it('keeps duplicate names, slash names, different prompts and inheritance independent in an empty destination', async () => {
		const { document } = await fixture();
		const dest = setup();
		const before = dest.sqlite.prepare('SELECT count(*) n FROM event').get();
		const preview = await applyImport(dest.db, dest.env, actor, { document, dry_run: true });
		expect(dest.sqlite.prepare('SELECT count(*) n FROM event').get()).toEqual(before);
		expect(workflowEntries(preview).map((e) => e.action)).toEqual(['create', 'create']);
		expect(workflowEntries(preview).map((e) => [e.target_name, e.target_id])).toEqual([
			['Same / name', undefined],
			['Same / name', undefined]
		]);
		const result = await applyImport(dest.db, dest.env, actor, { document });
		expect(result.counts.error).toBe(0);
		expect(result.counts.refuse).toBe(0);
		expect(workflowEntries(result).map((e) => e.action)).toEqual(['create', 'create']);
		expect(workflowEntries(result).every((e) => e.target_name === 'Same / name')).toBe(true);
		expect(workflowEntries(result).every((e) => e.target_id?.startsWith('wf_'))).toBe(true);
		const exported = await buildLibraryV3Document(dest.db, USER);
		expect(exported.workflows.map((w) => w.name)).toEqual(['Same / name', 'Same / name']);
		for (const source of document.context) {
			const sourceRef = source.scope.state;
			if (sourceRef?.kind !== 'bundled_state') continue;
			const sourceWf = document.workflows.find((w) =>
				w.states.some((s) => s.id === sourceRef.state_id)
			)!;
			const target = workflowEntries(result).find((e) => e.local_id === sourceWf.id)!.target_id!;
			const body = await dest.db
				.selectFrom('context_item')
				.innerJoin('workflow_state', 'workflow_state.id', 'context_item.workflow_state_id')
				.select('context_item.body')
				.where('workflow_state.workflow_id', '=', target)
				.executeTakeFirstOrThrow();
			expect(body.body).toBe(source.kind === 'prompt' ? source.body : '');
		}
		const workflows = (await loadWorkflows(dest.db, USER)).filter((w) => !w.is_system);
		expect(workflows.filter((w) => w.states[0].inherits_from !== null)).toHaveLength(1);
		expect(workflows.flatMap((w) => w.states).map((s) => s.id)).not.toContain(
			document.workflows[0].states[0].id
		);
	});
	it('requires collision mappings and accepts independent collision-safe creates', async () => {
		const { document } = await fixture();
		const dest = setup();
		await createWorkflow(dest.db, dest.env, actor, {
			name: 'Same / name',
			initial_state: 'Ready / now',
			states: [{ name: 'Ready / now', category: 'active' }],
			transitions: []
		});
		const preview = await applyImport(dest.db, dest.env, actor, { document, dry_run: true });
		expect(workflowEntries(preview).every((e) => e.action === 'refuse')).toBe(true);
		expect(workflowEntries(preview).every((e) => e.target_name === undefined)).toBe(true);
		const workflow_targets = Object.fromEntries(
			document.workflows.map((w, i) => [w.id, { kind: 'create' as const, name: `Copy ${i}` }])
		);
		const result = await applyImport(dest.db, dest.env, actor, { document, workflow_targets });
		expect(result.counts.error).toBe(0);
		expect(result.counts.refuse).toBe(0);
		expect(workflowEntries(result).map((e) => e.target_name)).toEqual(['Copy 0', 'Copy 1']);
		expect(
			(await loadWorkflows(dest.db, USER))
				.filter((w) => !w.is_system)
				.map((w) => w.name)
				.sort()
		).toEqual(['Copy 0', 'Copy 1', 'Same / name']);
	});
	it('maps two same-name destination workflows explicitly and refuses many-to-one before any writes', async () => {
		const { document, t, first, second } = await fixture();
		const targets = Object.fromEntries(
			document.workflows.map((w) => [w.id, { kind: 'target' as const, workflow_id: first.id }])
		);
		const before = t.sqlite.prepare('SELECT count(*) n FROM event').get();
		await expect(
			applyImport(t.db, t.env, actor, { document, workflow_targets: targets })
		).rejects.toMatchObject({ code: 'many_to_one_workflow_targets' });
		expect(t.sqlite.prepare('SELECT count(*) n FROM event').get()).toEqual(before);
		for (const w of document.workflows)
			targets[w.id].workflow_id = w.states[0].inherits_from ? second.id : first.id;
		const result = await applyImport(t.db, t.env, actor, { document, workflow_targets: targets });
		expect(result.counts.create).toBe(0);
		expect(result.counts.error).toBe(0);
		expect(result.counts.refuse).toBe(0);
	});
	it('preserves defaults, label color, all scopes, ordered files and journal exclusion', async () => {
		const { t, first, second } = await fixture();
		const project = await createProject(t.db, t.env, actor, {
			name: 'Destination project',
			default_workflow_id: second.id
		});
		const label = await createLabel(t.db, t.env, actor, { name: 'filing', color: 'red' });
		await createContextItem(t.db, t.env, actor, {
			kind: 'prompt',
			name: 'journal',
			body: 'history',
			project_id: project.id,
			workflow_state_id: first.states[0].id
		});
		await createContextItem(t.db, t.env, actor, {
			kind: 'skill',
			name: 'check',
			files: [
				{ path: 'SKILL.md', content: 'Instructions' },
				{ path: 'steps.txt', content: 'Second file' }
			],
			workflow_state_id: second.states[0].id,
			label_id: label.id
		});
		await createContextItem(t.db, t.env, actor, {
			kind: 'repo',
			name: 'source',
			repo_url: 'https://github.com/tbuckley/tines',
			project_id: project.id
		});
		await createContextItem(t.db, t.env, actor, {
			kind: 'prompt',
			name: 'global',
			body: 'Global instructions'
		});
		const document = await buildLibraryV3Document(t.db, USER);
		const dest = setup();
		const result = await applyImport(dest.db, dest.env, actor, {
			document,
			include_journals: false
		});
		expect(result.counts.error).toBe(0);
		expect(result.counts.refuse).toBe(0);
		const output = await buildLibraryV3Document(dest.db, USER);
		expect(output.labels.map((l) => [l.name, l.color])).toContainEqual(['filing', 'red']);
		expect(output.context.some((c) => c.journal)).toBe(false);
		expect(output.context.find((c) => c.kind === 'skill')).toMatchObject({
			files: [
				{ path: 'SKILL.md', content: 'Instructions' },
				{ path: 'steps.txt', content: 'Second file' }
			]
		});
		const targetProject = await dest.db
			.selectFrom('project')
			.selectAll()
			.where('name', '=', project.name)
			.executeTakeFirstOrThrow();
		const sourceDefault = document.projects.find((p) => p.name === project.name)!.default_workflow!;
		expect(sourceDefault.kind).toBe('bundled_workflow');
		if (sourceDefault.kind === 'bundled_workflow')
			expect(targetProject.default_workflow_id).toBe(
				workflowEntries(result).find((e) => e.local_id === sourceDefault.workflow_id)!.target_id
			);
		expect(
			(await buildLibraryV3Document(t.db, USER, { includeJournals: false })).context.some(
				(c) => c.journal
			)
		).toBe(false);
	});
	it('normalizes fields before collision comparison and application', async () => {
		const { document } = await fixture();
		const dest = setup();
		for (const w of document.workflows) {
			w.name = ` ${w.name} `;
			for (const s of w.states) s.name = ` ${s.name} `;
		}
		for (const c of document.context) c.name = ` ${c.name} `;
		const normalized = await withLibraryDocumentDigest(document);
		const result = await applyImport(dest.db, dest.env, actor, { document: normalized });
		expect(result.counts.error).toBe(0);
		expect(
			(await buildLibraryV3Document(dest.db, USER)).context.filter((c) => c.name === 'instructions')
		).toHaveLength(2);
	});
	it('rejects invalid schema/digest and unknown target IDs without writes', async () => {
		const { document } = await fixture();
		const dest = setup();
		const before = dest.sqlite.prepare('SELECT count(*) n FROM event').get();
		await expect(
			applyImport(dest.db, dest.env, actor, {
				document: { ...document, digest: 'sha256:' + '0'.repeat(64) }
			})
		).rejects.toMatchObject({ code: 'invalid_library' });
		await expect(
			applyImport(dest.db, dest.env, actor, {
				document,
				workflow_targets: { unknown: { kind: 'create', name: 'No' } }
			})
		).rejects.toMatchObject({ code: 'invalid_workflow_targets' });
		expect(dest.sqlite.prepare('SELECT count(*) n FROM event').get()).toEqual(before);
	});
	it('reports invalid mapping fields, foreign targets and too-long create names in both preview/apply', async () => {
		const { document } = await fixture();
		const dest = setup();
		for (const choice of [
			{ kind: 'create', name: 'x'.repeat(201) },
			{ kind: 'target', workflow_id: 'foreign' },
			null
		]) {
			const request = {
				document,
				workflow_targets: { [document.workflows[0].id]: choice }
			} as Parameters<typeof applyImport>[3];
			const preview = await applyImport(dest.db, dest.env, actor, { ...request, dry_run: true });
			const result = await applyImport(dest.db, dest.env, actor, request);
			expect(workflowEntries(preview)[0].action).toBe('error');
			expect(workflowEntries(result)[0].action).toBe('error');
		}
	});
});

it('applies a valid cross-workflow edge reversal independent of document workflow order', async () => {
	const { t, document, first, second } = await fixture();
	const base = document.workflows.find((w) => !w.states[0].inherits_from)!;
	const child = document.workflows.find((w) => w.states[0].inherits_from)!;
	base.states[0].inherits_from = { kind: 'bundled_state', state_id: child.states[0].id };
	child.states[0].inherits_from = null;
	document.workflows = [base, child]; // Setting this base first without clearing the old child edge cycles.
	const source = await withLibraryDocumentDigest(document);
	const request = {
		document: source,
		on_collision: 'overwrite' as const,
		workflow_targets: {
			[base.id]: { kind: 'target' as const, workflow_id: first.id },
			[child.id]: { kind: 'target' as const, workflow_id: second.id }
		}
	};
	const preview = await applyImport(t.db, t.env, actor, { ...request, dry_run: true });
	expect(workflowEntries(preview).map((e) => e.action)).toEqual(['overwrite', 'overwrite']);
	const result = await applyImport(t.db, t.env, actor, request);
	expect(result.counts.error).toBe(0);
	const workflows = await loadWorkflows(t.db, USER);
	expect(workflows.find((w) => w.id === first.id)!.states[0].inherits_from).toBe(
		second.states[0].id
	);
	expect(workflows.find((w) => w.id === second.id)!.states[0].inherits_from).toBeNull();
});

it('refused overwrite retains target states for independent context and inheritance', async () => {
	const { t, document, first, second } = await fixture();
	const sourceBase = document.workflows.find((w) => !w.states[0].inherits_from)!;
	const sourceChild = document.workflows.find((w) => w.states[0].inherits_from)!;
	// The target still has Ready but differs in structure, so overwrite must not replace it.
	await t.db
		.updateTable('workflow_state')
		.set({ category: 'backlog' })
		.where('id', '=', first.states[0].id)
		.execute();
	const request = {
		document,
		on_collision: 'overwrite' as const,
		workflow_targets: {
			[sourceBase.id]: { kind: 'target' as const, workflow_id: first.id },
			[sourceChild.id]: { kind: 'target' as const, workflow_id: second.id }
		}
	};
	const preview = await applyImport(t.db, t.env, actor, { ...request, dry_run: true });
	const result = await applyImport(t.db, t.env, actor, request);
	expect(workflowEntries(preview).find((e) => e.local_id === sourceBase.id)?.action).toBe('refuse');
	expect(result.entries.map((e) => [e.local_id, e.action])).toEqual(
		preview.entries.map((e) => [e.local_id, e.action])
	);
	expect(result.counts.error).toBe(0);
	expect(
		result.entries.filter((e) => e.section === 'context').every((e) => e.action === 'overwrite')
	).toBe(true);
});

it('never treats an owned workflow named Standard as a typed system reference', async () => {
	const t = setup();
	await createWorkflow(t.db, t.env, actor, {
		name: 'Standard',
		initial_state: 'Open',
		states: [
			{ name: 'Open', category: 'active' },
			{ name: 'Human Review', category: 'awaiting_human' },
			{ name: 'Closed', category: 'done' }
		],
		transitions: []
	});
	const document = await buildLibraryV3Document(t.db, USER);
	const dest = setup();
	const preview = await applyImport(dest.db, dest.env, actor, { document, dry_run: true });
	expect(workflowEntries(preview)[0]).toMatchObject({ action: 'refuse' });
	expect(workflowEntries(preview)[0].target_id).toBeUndefined();
	const result = await applyImport(dest.db, dest.env, actor, {
		document,
		workflow_targets: { [document.workflows[0].id]: { kind: 'create', name: 'My Standard copy' } }
	});
	expect(result.counts.error).toBe(0);
	expect(workflowEntries(result)[0].action).toBe('create');
});
