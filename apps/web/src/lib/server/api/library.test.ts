/**
 * Library export / import. The property that matters is the round trip:
 * a document exported from one deployment must rebuild the same library in
 * another that shares none of its ids — and re-importing must be a no-op
 * rather than a duplicator.
 */
import { LIBRARY_FORMAT, LIBRARY_VERSION, type LibraryDocument } from '@tines/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { PROJECT, USER, addIssue, seedBase } from '../supervisor/test-fixtures';
import { createContextItem } from './context';
import { ApiFail, type ActorContext } from './core';
import { createLabel } from './labels';
import { applyImport, assertImportableDocument, buildLibraryDocument, planImport } from './library';
import { createWorkflow, loadWorkflow } from './workflows';
import { createTestDb, type TestDb } from './test-db';

const actor: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

let t: TestDb;

beforeEach(() => {
	t = createTestDb();
	seedBase(t);
});

const ENGINEERING = {
	name: 'Engineering',
	description: 'Ship it',
	initial_state: 'Backlog',
	states: [
		{ name: 'Backlog', category: 'backlog' as const },
		{ name: 'Research', category: 'active' as const },
		{ name: 'Done', category: 'done' as const }
	],
	transitions: [
		{ name: 'Start', from: 'Backlog', to: 'Research' },
		{
			name: 'Finish',
			from: 'Research',
			to: 'Done',
			requires: [
				{ artifact: 'research-findings', type: 'text' as const, content_type: 'text/markdown' }
			]
		}
	]
};

/** A library worth moving: a workflow, prompts at three scopes, a skill, a repo. */
async function seedLibrary() {
	const wf = await createWorkflow(t.db, t.env, actor, ENGINEERING);
	const research = wf.states.find((s) => s.name === 'Research')!;
	await createContextItem(t.db, t.env, actor, {
		kind: 'prompt',
		name: 'agent-guidelines',
		body: 'Be careful.'
	});
	await createContextItem(t.db, t.env, actor, {
		kind: 'prompt',
		name: 'conventions',
		project_id: PROJECT,
		body: 'House style.'
	});
	await createContextItem(t.db, t.env, actor, {
		kind: 'prompt',
		name: 'instructions',
		workflow_state_id: research.id,
		body: 'Research the thing.'
	});
	await createContextItem(t.db, t.env, actor, {
		kind: 'prompt',
		name: 'journal',
		project_id: PROJECT,
		workflow_state_id: research.id,
		body: '- a lesson'
	});
	await createContextItem(t.db, t.env, actor, {
		kind: 'skill',
		name: 'deploy',
		files: [{ path: 'SKILL.md', content: '# Deploy' }]
	});
	await createContextItem(t.db, t.env, actor, {
		kind: 'repo',
		name: 'tines-github',
		project_id: PROJECT,
		repo_url: 'https://github.com/tbuckley/tines.git'
	});
	return { wf, research };
}

/** A second deployment: same schema and user id, no shared rows. */
function freshDeployment(): TestDb {
	const fresh = createTestDb();
	seedBase(fresh);
	return fresh;
}

const names = (doc: LibraryDocument) => doc.context.map((c) => c.name).sort();

describe('buildLibraryDocument', () => {
	it('carries the version stamp and every non-issue-scoped item', async () => {
		await seedLibrary();
		const doc = await buildLibraryDocument(t.db, USER);
		expect(doc.format).toBe(LIBRARY_FORMAT);
		expect(doc.version).toBe(LIBRARY_VERSION);
		expect(doc.exported_at).toBeGreaterThan(0);
		expect(names(doc)).toEqual([
			'agent-guidelines',
			'conventions',
			'deploy',
			'instructions',
			'journal',
			'tines-github'
		]);
	});

	it('excludes the system workflow, which is seeded identically everywhere', async () => {
		await seedLibrary();
		const doc = await buildLibraryDocument(t.db, USER);
		expect(doc.workflows.map((w) => w.name)).toEqual(['Engineering']);
	});

	it('excludes issue-scoped items — their issue does not travel', async () => {
		await seedLibrary();
		const issueId = addIssue(t);
		await createContextItem(t.db, t.env, actor, {
			kind: 'prompt',
			name: 'issue-note',
			issue_id: issueId,
			body: 'local'
		});
		const doc = await buildLibraryDocument(t.db, USER);
		expect(names(doc)).not.toContain('issue-note');
	});

	it('refers to states by name and keeps them in position order', async () => {
		await seedLibrary();
		const [wf] = (await buildLibraryDocument(t.db, USER)).workflows;
		expect(wf.states.map((s) => s.name)).toEqual(['Backlog', 'Research', 'Done']);
		expect(wf.initial_state).toBe('Backlog');
		expect(wf.transitions).toContainEqual({ name: 'Start', from: 'Backlog', to: 'Research' });
	});

	it('exports a workflow that is directly re-creatable — the format is the request', async () => {
		await seedLibrary();
		const [wf] = (await buildLibraryDocument(t.db, USER)).workflows;
		const fresh = freshDeployment();
		const created = await createWorkflow(fresh.db, fresh.env, actor, { ...wf, name: 'Copy' });
		expect(created.states.map((s) => s.name)).toEqual(['Backlog', 'Research', 'Done']);
	});

	it('tags journals and can leave them behind', async () => {
		await seedLibrary();
		const withJournals = await buildLibraryDocument(t.db, USER);
		expect(withJournals.context.find((c) => c.name === 'journal')?.journal).toBe(true);
		const without = await buildLibraryDocument(t.db, USER, { includeJournals: false });
		expect(names(without)).not.toContain('journal');
	});

	it('carries skill file bodies, not just a count', async () => {
		await seedLibrary();
		const doc = await buildLibraryDocument(t.db, USER);
		expect(doc.context.find((c) => c.name === 'deploy')?.files).toEqual([
			{ path: 'SKILL.md', content: '# Deploy' }
		]);
	});
});

describe('assertImportableDocument', () => {
	const base = (): LibraryDocument => ({
		format: LIBRARY_FORMAT,
		version: LIBRARY_VERSION,
		exported_at: 1,
		projects: [],
		workflows: [],
		context: []
	});

	it('rejects a document written by a newer Tines, naming the version it reads', () => {
		try {
			assertImportableDocument({ ...base(), version: LIBRARY_VERSION + 1 });
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(ApiFail);
			expect((e as ApiFail).code).toBe('unsupported_format');
			expect((e as ApiFail).message).toMatch(String(LIBRARY_VERSION));
		}
	});

	it('rejects a JSON file that is not a library export', () => {
		expect(() =>
			assertImportableDocument({ ...base(), format: 'something.else' as never })
		).toThrow(/Not a Tines library export/);
	});

	it('rejects a document with more entries than one import may carry', () => {
		const doc = base();
		doc.context = Array.from({ length: 1001 }, (_, i) => ({
			kind: 'prompt' as const,
			name: `p${i}`,
			scope: {}
		}));
		expect(() => assertImportableDocument(doc)).toThrow(/at most 1000/);
	});

	it('accepts an older version — the format only refuses the future', () => {
		expect(() => assertImportableDocument({ ...base(), version: 1 })).not.toThrow();
	});
});

describe('planImport', () => {
	/** Export from `t`, then plan that document against a target deployment. */
	async function planInto(target: TestDb, opts: Parameters<typeof planImport>[2] | object = {}) {
		const document = await buildLibraryDocument(t.db, USER);
		return planImport(target.db, USER, { document, ...opts });
	}

	const actionsOf = (plan: Awaited<ReturnType<typeof planImport>>, section: string) =>
		plan.steps.filter((s) => s.entry.section === section).map((s) => s.entry.action);

	it('plans everything as a create on a deployment that has none of it', async () => {
		await seedLibrary();
		const plan = await planInto(freshDeployment());
		expect(actionsOf(plan, 'workflow')).toEqual(['create']);
		expect(new Set(actionsOf(plan, 'context'))).toEqual(new Set(['create']));
	});

	it('skips a project that already exists and reuses it as a scope carrier', async () => {
		await seedLibrary();
		const plan = await planInto(t);
		const project = plan.steps.find((s) => s.entry.section === 'project')!;
		expect(project.entry.action).toBe('skip');
		expect(project.entry.reason).toMatch(/already exists/);
	});

	it('skips an identical workflow and every item, importing into its own source', async () => {
		await seedLibrary();
		const plan = await planInto(t);
		expect(actionsOf(plan, 'workflow')).toEqual(['skip']);
		expect(new Set(actionsOf(plan, 'context'))).toEqual(new Set(['skip']));
	});

	it('refuses a workflow whose name matches but whose definition differs', async () => {
		await seedLibrary();
		const target = freshDeployment();
		await createWorkflow(target.db, target.env, actor, {
			...ENGINEERING,
			states: [{ name: 'Backlog', category: 'backlog' }],
			transitions: []
		});
		const plan = await planInto(target);
		const wf = plan.steps.find((s) => s.entry.section === 'workflow')!;
		expect(wf.entry.action).toBe('refuse');
		expect(wf.entry.reason).toMatch(/rename or delete it first/);
	});

	it('still lands state-scoped items on a refused workflow that already exists', async () => {
		await seedLibrary();
		const target = freshDeployment();
		// Same states, different transitions: the definition conflicts, but
		// "Research" exists, so its instructions have somewhere to go.
		await createWorkflow(target.db, target.env, actor, { ...ENGINEERING, transitions: [] });
		const plan = await planInto(target);
		const instructions = plan.steps.find((s) => s.entry.ref.includes('"instructions"'))!;
		expect(instructions.entry.action).toBe('create');
	});

	it('overwrites colliding context items only when asked', async () => {
		await seedLibrary();
		const plan = await planInto(t, { on_collision: 'overwrite' });
		expect(new Set(actionsOf(plan, 'context'))).toEqual(new Set(['overwrite']));
		// The workflow is never overwritten, whatever the collision setting.
		expect(actionsOf(plan, 'workflow')).toEqual(['skip']);
	});

	it('skips items whose scope cannot be resolved and says which scope', async () => {
		await seedLibrary();
		// A project the target genuinely lacks, and which it is told not to create.
		const document = await buildLibraryDocument(t.db, USER);
		document.projects = [{ name: 'Elsewhere' }];
		document.context = document.context.map((c) =>
			c.scope.project ? { ...c, scope: { ...c.scope, project: 'Elsewhere' } } : c
		);
		const target = freshDeployment();
		const plan = await planImport(target.db, USER, { document, create_projects: false });

		const project = plan.steps.find((s) => s.entry.section === 'project')!;
		expect(project.entry.action).toBe('skip');
		expect(project.entry.reason).toMatch(/turned off/);
		const conventions = plan.steps.find((s) => s.entry.ref.includes('"conventions"'))!;
		expect(conventions.entry.action).toBe('skip');
		expect(conventions.entry.reason).toMatch(/no project named "Elsewhere"/);
	});

	it('does not read a scope that is only being created as the global scope', async () => {
		await seedLibrary();
		const document = await buildLibraryDocument(t.db, USER);
		document.projects = [{ name: 'Elsewhere' }];
		document.context = document.context
			.filter((c) => c.name === 'conventions')
			.map((c) => ({ ...c, scope: { project: 'Elsewhere' } }));
		const target = freshDeployment();
		// Same kind and name at *global* scope: a different item entirely, and
		// no reason to hold back the project-scoped one arriving with its project.
		await createContextItem(target.db, target.env, actor, {
			kind: 'prompt',
			name: 'conventions',
			body: 'Global.'
		});

		const plan = await planImport(target.db, USER, { document });
		const conventions = plan.steps.find((s) => s.entry.ref.includes('"conventions"'))!;
		expect(conventions.entry.action).toBe('create');
	});

	it('says so when a project names a default workflow that is nowhere to be found', async () => {
		await seedLibrary();
		const document = await buildLibraryDocument(t.db, USER);
		document.projects = [{ name: 'Elsewhere', default_workflow: 'Ghost' }];
		const plan = await planImport(freshDeployment().db, USER, { document });
		const project = plan.steps.find((s) => s.entry.section === 'project')!;
		expect(project.entry.action).toBe('create');
		expect(project.entry.reason).toMatch(/no workflow named "Ghost"/);
	});

	it('leaves journals out when the toggle is off', async () => {
		await seedLibrary();
		const plan = await planInto(freshDeployment(), { include_journals: false });
		const journal = plan.steps.find((s) => s.entry.ref.includes('"journal"'))!;
		expect(journal.entry.action).toBe('skip');
		expect(journal.entry.reason).toMatch(/journals are excluded/);
	});
});

describe('applyImport', () => {
	/** Everything but the timestamp, which is stamped per export by design. */
	const comparable = (doc: LibraryDocument) => ({
		projects: [...doc.projects].sort((a, b) => a.name.localeCompare(b.name)),
		workflows: doc.workflows,
		context: [...doc.context].sort((a, b) => a.name.localeCompare(b.name))
	});

	it('reproduces the library on a fresh deployment — the round trip', async () => {
		await seedLibrary();
		const source = await buildLibraryDocument(t.db, USER);
		const target = freshDeployment();

		const result = await applyImport(target.db, target.env, actor, { document: source });
		expect(result.applied).toBe(true);
		expect(result.counts.error).toBe(0);
		expect(result.counts.refuse).toBe(0);

		const rebuilt = await buildLibraryDocument(target.db, USER);
		expect(comparable(rebuilt)).toEqual(comparable(source));
	});

	it('carries a label-scoped item and creates the label it names', async () => {
		const label = await createLabel(t.db, t.env, actor, { name: 'design' });
		await createContextItem(t.db, t.env, actor, {
			kind: 'prompt',
			name: 'component-testing',
			label_id: label.id,
			body: 'Test the component.'
		});
		const source = await buildLibraryDocument(t.db, USER);
		expect(source.context.find((e) => e.name === 'component-testing')?.scope).toEqual({
			label: 'design'
		});

		const target = freshDeployment();
		const result = await applyImport(target.db, target.env, actor, { document: source });
		expect(result.counts.error).toBe(0);
		// The label did not exist on the target: unlike a project or a
		// workflow, it is created rather than costing the item its scope.
		const rebuilt = await buildLibraryDocument(target.db, USER);
		expect(rebuilt.context.find((e) => e.name === 'component-testing')?.scope).toEqual({
			label: 'design'
		});
	});

	it('treats the same name under two labels as two items, not a collision', async () => {
		const design = await createLabel(t.db, t.env, actor, { name: 'design' });
		const qa = await createLabel(t.db, t.env, actor, { name: 'qa' });
		for (const id of [design.id, qa.id]) {
			await createContextItem(t.db, t.env, actor, {
				kind: 'prompt',
				name: 'component-testing',
				label_id: id,
				body: id
			});
		}
		const document = await buildLibraryDocument(t.db, USER);
		const target = freshDeployment();
		const result = await applyImport(target.db, target.env, actor, { document });
		expect(result.counts.error).toBe(0);
		const rebuilt = await buildLibraryDocument(target.db, USER);
		// Both survive: `contextKey` includes the label, so the second is not
		// read as a collision with the first.
		expect(
			rebuilt.context
				.filter((e) => e.name === 'component-testing')
				.map((e) => e.scope.label)
				.sort()
		).toEqual(['design', 'qa']);
	});

	it('is idempotent: a second import creates nothing', async () => {
		await seedLibrary();
		const document = await buildLibraryDocument(t.db, USER);
		const target = freshDeployment();
		await applyImport(target.db, target.env, actor, { document });
		const again = await applyImport(target.db, target.env, actor, { document });
		expect(again.counts.create).toBe(0);
		expect(again.counts.error).toBe(0);
		expect(again.counts.skip).toBe(document.context.length + document.workflows.length + 1);
	});

	it('writes nothing on a dry run, and the plan it previews is the one apply follows', async () => {
		await seedLibrary();
		const document = await buildLibraryDocument(t.db, USER);
		const target = freshDeployment();

		const preview = await applyImport(target.db, target.env, actor, { document, dry_run: true });
		expect(preview.applied).toBe(false);
		expect((await buildLibraryDocument(target.db, USER)).context).toHaveLength(0);

		const applied = await applyImport(target.db, target.env, actor, { document });
		expect(applied.entries.map((e) => `${e.ref} ${e.action}`)).toEqual(
			preview.entries.map((e) => `${e.ref} ${e.action}`)
		);
	});

	it('resolves items scoped to the system workflow by name, not by id', async () => {
		const openState = 'wfs_std_open';
		await createContextItem(t.db, t.env, actor, {
			kind: 'prompt',
			name: 'instructions',
			workflow_state_id: openState,
			body: 'Work it.'
		});
		const document = await buildLibraryDocument(t.db, USER);
		const target = freshDeployment();
		const result = await applyImport(target.db, target.env, actor, { document });
		expect(result.counts.error).toBe(0);

		const rebuilt = await buildLibraryDocument(target.db, USER);
		const item = rebuilt.context.find((c) => c.name === 'instructions')!;
		expect(item.scope.state?.name).toBeDefined();
		expect(item.body).toBe('Work it.');
	});

	it('overwrite replaces the existing item rather than duplicating it', async () => {
		await seedLibrary();
		const document = await buildLibraryDocument(t.db, USER);
		const target = freshDeployment();
		await applyImport(target.db, target.env, actor, { document });

		// Same names and scopes, changed bodies: overwrite must land the new
		// text on the items already there.
		const edited: LibraryDocument = {
			...document,
			context: document.context.map((c) =>
				c.kind === 'prompt' ? { ...c, body: `${c.body} (updated)` } : c
			)
		};
		const result = await applyImport(target.db, target.env, actor, {
			document: edited,
			on_collision: 'overwrite'
		});
		expect(result.counts.create).toBe(0);

		const rebuilt = await buildLibraryDocument(target.db, USER);
		expect(rebuilt.context).toHaveLength(document.context.length);
		expect(rebuilt.context.find((c) => c.name === 'conventions')?.body).toBe(
			'House style. (updated)'
		);
	});

	it('creates a missing project as a scope carrier, with no tracker data attached', async () => {
		await seedLibrary();
		const document = await buildLibraryDocument(t.db, USER);
		const target = freshDeployment();
		// The fresh deployment's seeded project has the same name, so rename
		// the source's to make it genuinely missing.
		document.projects = [{ name: 'Elsewhere' }];
		document.context = document.context.map((c) =>
			c.scope.project ? { ...c, scope: { ...c.scope, project: 'Elsewhere' } } : c
		);
		const result = await applyImport(target.db, target.env, actor, { document });
		expect(result.counts.error).toBe(0);

		const project = await target.db
			.selectFrom('project')
			.select('id')
			.where('name', '=', 'Elsewhere')
			.executeTakeFirst();
		expect(project).toBeDefined();
		const issues = await target.db
			.selectFrom('issue')
			.select('id')
			.where('project_id', '=', project!.id)
			.execute();
		expect(issues).toEqual([]);
	});

	it("restores a project's default workflow, which arrives in the same document", async () => {
		const { wf } = await seedLibrary();
		await t.db
			.updateTable('project')
			.set({ default_workflow_id: wf.id })
			.where('id', '=', PROJECT)
			.execute();

		const document = await buildLibraryDocument(t.db, USER);
		expect(document.projects[0].default_workflow).toBe('Engineering');
		// Rename so the target genuinely lacks the project (its own seed uses
		// the same name), keeping the default-workflow reference.
		document.projects = [{ name: 'Elsewhere', default_workflow: 'Engineering' }];
		document.context = document.context.map((c) =>
			c.scope.project ? { ...c, scope: { ...c.scope, project: 'Elsewhere' } } : c
		);

		const target = freshDeployment();
		const result = await applyImport(target.db, target.env, actor, { document });
		expect(result.counts.error).toBe(0);

		const rebuilt = await buildLibraryDocument(target.db, USER);
		expect(rebuilt.projects.find((p) => p.name === 'Elsewhere')?.default_workflow).toBe(
			'Engineering'
		);
	});

	it('creates the project anyway when its default workflow is absent', async () => {
		await seedLibrary();
		const document = await buildLibraryDocument(t.db, USER);
		document.projects = [{ name: 'Elsewhere', default_workflow: 'Ghost' }];
		const target = freshDeployment();
		const result = await applyImport(target.db, target.env, actor, { document });
		expect(result.counts.error).toBe(0);

		const rebuilt = await buildLibraryDocument(target.db, USER);
		expect(rebuilt.projects.find((p) => p.name === 'Elsewhere')?.default_workflow).toBeNull();
	});

	it('reports a failing entry and carries on with the rest', async () => {
		await seedLibrary();
		const document = await buildLibraryDocument(t.db, USER);
		// A repo item with no URL fails its own validation; nothing else should.
		document.context = document.context.map((c) =>
			c.kind === 'repo' ? { ...c, repo_url: '' } : c
		);
		const target = freshDeployment();
		const result = await applyImport(target.db, target.env, actor, { document });
		expect(result.counts.error).toBe(1);
		expect(result.counts.create).toBe(document.context.length - 1 + document.workflows.length);
		expect(result.entries.find((e) => e.action === 'error')?.ref).toMatch(/tines-github/);
	});
});

// ---------------------------------------------------------------------------
// Inheritance pointers (format version 2, Tines/270)

describe('inheritance pointers', () => {
	/** Chains worth moving: `Base / Shared` under two workflows, and one two deep. */
	async function seedInheritance() {
		const base = await createWorkflow(t.db, t.env, actor, {
			name: 'Base',
			initial_state: 'Shared',
			states: [
				{ name: 'Shared', category: 'active' },
				{ name: 'Retired', category: 'done' }
			],
			transitions: [{ name: 'Retire', from: 'Shared', to: 'Retired' }]
		});
		const shared = base.states.find((s) => s.name === 'Shared')!;
		const alpha = await createWorkflow(t.db, t.env, actor, {
			name: 'Alpha',
			initial_state: 'Design',
			states: [
				// Cross-workflow base by id, then an in-workflow base by name:
				// a chain of three, which is the deepest the API allows.
				{ name: 'Design', category: 'active', inherits_from: shared.id },
				{ name: 'Review', category: 'active', inherits_from: 'Design' },
				{ name: 'Done', category: 'done' }
			],
			transitions: [
				// An artifact requirement rides along so the deferred pointer
				// pass, which re-sends the whole workflow, has something to
				// lose if it ever stopped preserving the rest of it.
				{
					name: 'Submit',
					from: 'Design',
					to: 'Review',
					requires: [{ artifact: 'design-doc', type: 'text', content_type: 'text/markdown' }]
				},
				{ name: 'Approve', from: 'Review', to: 'Done' }
			]
		});
		const beta = await createWorkflow(t.db, t.env, actor, {
			name: 'Beta',
			initial_state: 'Triage',
			states: [
				{ name: 'Triage', category: 'backlog', inherits_from: shared.id },
				{ name: 'Shipped', category: 'done' }
			],
			transitions: [{ name: 'Ship', from: 'Triage', to: 'Shipped' }]
		});
		return { base, alpha, beta, shared };
	}

	/** Every pointer in a document, as `<workflow>/<state> -> <ref>`. */
	const pointers = (doc: LibraryDocument) =>
		doc.workflows
			.flatMap((wf) =>
				wf.states.map((s) => (s.inherits_from ? `${wf.name}/${s.name} -> ${s.inherits_from}` : ''))
			)
			.filter(Boolean)
			.sort();

	it('exports each pointer by name, and nothing at all for a state without one', async () => {
		await seedInheritance();
		const doc = await buildLibraryDocument(t.db, USER);
		expect(pointers(doc)).toEqual([
			'Alpha/Design -> Base/Shared',
			'Alpha/Review -> Alpha/Design',
			'Beta/Triage -> Base/Shared'
		]);
		// A state with no base carries no key — that is what keeps a
		// pointer-free deployment exporting the version 1 document.
		const untouched = doc.workflows.flatMap((wf) =>
			wf.states.filter((s) => !['Design', 'Review', 'Triage'].includes(s.name))
		);
		expect(untouched.length).toBeGreaterThan(0);
		for (const state of untouched) expect(Object.keys(state).sort()).toEqual(['category', 'name']);
	});

	it('exports the version 1 document, bar the version, when nothing inherits', async () => {
		await seedLibrary();
		const doc = await buildLibraryDocument(t.db, USER);
		expect(doc.version).toBe(2);
		expect(JSON.stringify(doc.workflows)).not.toContain('inherits_from');
	});

	it('round-trips every pointer onto a deployment that shares none of the ids', async () => {
		await seedInheritance();
		const document = await buildLibraryDocument(t.db, USER);
		const target = freshDeployment();

		const result = await applyImport(target.db, target.env, actor, { document });
		expect(result.counts.error).toBe(0);
		expect(result.counts.refuse).toBe(0);

		const rebuilt = await buildLibraryDocument(target.db, USER);
		expect(pointers(rebuilt)).toEqual(pointers(document));
		// By name, and genuinely re-resolved: the target's own ids.
		const alpha = rebuilt.workflows.find((wf) => wf.name === 'Alpha')!;
		expect(alpha.states.find((s) => s.name === 'Design')?.inherits_from).toBe('Base/Shared');
	});

	it('resolves a base that arrives later in the same document', async () => {
		await seedInheritance();
		const document = await buildLibraryDocument(t.db, USER);
		// Children first, base last: order in the document must not matter.
		document.workflows = [...document.workflows].sort((a, b) =>
			a.name === 'Base' ? 1 : b.name === 'Base' ? -1 : 0
		);
		expect(document.workflows.at(-1)?.name).toBe('Base');

		const target = freshDeployment();
		const result = await applyImport(target.db, target.env, actor, { document });
		expect(result.counts.error).toBe(0);
		const rebuilt = await buildLibraryDocument(target.db, USER);
		expect(pointers(rebuilt)).toEqual(pointers(document));
		// The pointers are patched on by re-sending the whole workflow, so the
		// rest of it — transitions and their artifact requirements — has to
		// survive that second write untouched.
		const source = document.workflows.find((wf) => wf.name === 'Alpha')!;
		expect(rebuilt.workflows.find((wf) => wf.name === 'Alpha')!.transitions).toEqual(
			source.transitions
		);
	});

	it('resolves a base the target already has, including the standard workflow', async () => {
		await createWorkflow(t.db, t.env, actor, {
			name: 'Alpha',
			initial_state: 'Design',
			states: [{ name: 'Design', category: 'active', inherits_from: 'wfs_std_open' }],
			transitions: []
		});
		const document = await buildLibraryDocument(t.db, USER);
		expect(pointers(document)).toEqual(['Alpha/Design -> Standard/Open']);

		// The standard workflow is never exported: the target's own copy,
		// seeded by the migration, is what the name resolves against.
		const target = freshDeployment();
		const result = await applyImport(target.db, target.env, actor, { document });
		expect(result.counts.error).toBe(0);
		expect(pointers(await buildLibraryDocument(target.db, USER))).toEqual([
			'Alpha/Design -> Standard/Open'
		]);
	});

	it('refuses a workflow whose base is nowhere, naming it, and writes nothing', async () => {
		await seedInheritance();
		const document = await buildLibraryDocument(t.db, USER);
		// The base workflow stays behind: Alpha and Beta now point at nothing.
		document.workflows = document.workflows.filter((wf) => wf.name !== 'Base');
		const target = freshDeployment();

		const preview = await applyImport(target.db, target.env, actor, { document, dry_run: true });
		const refused = preview.entries.filter((e) => e.action === 'refuse');
		expect(refused.map((e) => e.ref).sort()).toEqual(['workflow "Alpha"', 'workflow "Beta"']);
		for (const entry of refused) expect(entry.reason).toMatch(/Base \/ Shared/);

		const result = await applyImport(target.db, target.env, actor, { document });
		expect(result.counts.error).toBe(0);
		expect(result.counts.refuse).toBe(2);
		expect((await buildLibraryDocument(target.db, USER)).workflows).toEqual([]);
	});

	it('refuses the children of a workflow it refuses for a missing base', async () => {
		await seedInheritance();
		// Alpha's own Review inherits from its Design, so the whole workflow
		// goes; a third workflow hanging off Alpha must go with it.
		const document = await buildLibraryDocument(t.db, USER);
		document.workflows = document.workflows.filter((wf) => wf.name !== 'Base');
		document.workflows.push({
			name: 'Gamma',
			initial_state: 'Start',
			states: [{ name: 'Start', category: 'active', inherits_from: 'Alpha/Design' }],
			transitions: []
		});
		const plan = await planImport(freshDeployment().db, USER, { document });
		const actions = plan.steps
			.filter((s) => s.entry.section === 'workflow')
			.map((s) => `${s.entry.ref} ${s.entry.action}`);
		expect(actions).toEqual([
			'workflow "Alpha" refuse',
			'workflow "Beta" refuse',
			'workflow "Gamma" refuse'
		]);
		const gamma = plan.steps.find((s) => s.entry.ref.includes('Gamma'))!;
		expect(gamma.entry.reason).toMatch(/Alpha \/ Design/);
	});

	// The rollout configuration: a target that took an earlier version 1
	// export of this same library already has these workflows, structurally
	// identical, with no pointers at all. The collision check is a structural
	// fingerprint, so this is the one branch where a dropped pointer could
	// pass for "nothing to do".
	async function targetHoldingTheVersionOneExport() {
		const source = await buildLibraryDocument(t.db, USER);
		const stripped: LibraryDocument = {
			...source,
			version: 1,
			workflows: source.workflows.map((wf) => ({
				...wf,
				states: wf.states.map(({ name, category }) => ({ name, category }))
			}))
		};
		const target = freshDeployment();
		const seeded = await applyImport(target.db, target.env, actor, { document: stripped });
		expect(seeded.counts.error + seeded.counts.refuse).toBe(0);
		expect(pointers(await buildLibraryDocument(target.db, USER))).toEqual([]);
		return { target, document: source };
	}

	it('refuses a workflow that is here already but whose pointers differ, naming the states', async () => {
		await seedInheritance();
		const { target, document } = await targetHoldingTheVersionOneExport();

		const result = await applyImport(target.db, target.env, actor, { document });
		const entries = result.entries.filter((e) => e.section === 'workflow');
		expect(entries.map((e) => `${e.ref} ${e.action}`).sort()).toEqual([
			'workflow "Alpha" refuse',
			'workflow "Base" skip',
			'workflow "Beta" refuse'
		]);
		// The states that differ are named, and the way out is spelled out.
		expect(entries.find((e) => e.ref.includes('Alpha'))!.reason).toMatch(/"Design", "Review"/);
		expect(entries.find((e) => e.ref.includes('Alpha'))!.reason).toMatch(/on_collision=overwrite/);
		// Refused, so nothing moved — never silently skipped with the pointers lost.
		expect(pointers(await buildLibraryDocument(target.db, USER))).toEqual([]);
	});

	it('overwrite patches the pointers onto the workflow that is here already', async () => {
		await seedInheritance();
		const { target, document } = await targetHoldingTheVersionOneExport();

		const preview = await applyImport(target.db, target.env, actor, {
			document,
			on_collision: 'overwrite',
			dry_run: true
		});
		expect(
			preview.entries
				.filter((e) => e.section === 'workflow')
				.map((e) => e.action)
				.sort()
		).toEqual(['overwrite', 'overwrite', 'skip']);
		expect(pointers(await buildLibraryDocument(target.db, USER))).toEqual([]);

		const result = await applyImport(target.db, target.env, actor, {
			document,
			on_collision: 'overwrite'
		});
		expect(result.counts.error).toBe(0);
		expect(result.counts.refuse).toBe(0);
		const rebuilt = await buildLibraryDocument(target.db, USER);
		expect(pointers(rebuilt)).toEqual(pointers(document));
		// Only the pointers moved: the rest of the workflow is untouched.
		const alpha = rebuilt.workflows.find((wf) => wf.name === 'Alpha')!;
		expect(alpha.transitions).toEqual(
			document.workflows.find((wf) => wf.name === 'Alpha')!.transitions
		);
		// And it converges: a second run has nothing left to do.
		const again = await applyImport(target.db, target.env, actor, {
			document,
			on_collision: 'overwrite'
		});
		expect(again.counts.overwrite).toBe(0);
		expect(again.counts.refuse).toBe(0);
	});

	it('clears a pointer the document has dropped, on overwrite', async () => {
		await seedInheritance();
		const source = await buildLibraryDocument(t.db, USER);
		const target = freshDeployment();
		await applyImport(target.db, target.env, actor, { document: source });
		expect(pointers(await buildLibraryDocument(target.db, USER))).toEqual(pointers(source));

		// Beta stops inheriting; everything else stays as it is.
		const document: LibraryDocument = {
			...source,
			workflows: source.workflows.map((wf) =>
				wf.name === 'Beta'
					? { ...wf, states: wf.states.map(({ name, category }) => ({ name, category })) }
					: wf
			)
		};
		const result = await applyImport(target.db, target.env, actor, {
			document,
			on_collision: 'overwrite'
		});
		expect(result.counts.error).toBe(0);
		expect(pointers(await buildLibraryDocument(target.db, USER))).toEqual([
			'Alpha/Design -> Base/Shared',
			'Alpha/Review -> Alpha/Design'
		]);
	});

	it('imports a version 1 document, which has no pointers, unchanged', async () => {
		await seedLibrary();
		const document: LibraryDocument = { ...(await buildLibraryDocument(t.db, USER)), version: 1 };
		const target = freshDeployment();
		const result = await applyImport(target.db, target.env, actor, { document });
		expect(result.counts.error).toBe(0);
		expect(result.counts.refuse).toBe(0);

		const rebuilt = await buildLibraryDocument(target.db, USER);
		expect(pointers(rebuilt)).toEqual([]);
		expect(rebuilt.workflows.map((wf) => wf.name)).toEqual(['Engineering']);
	});

	it.each(['skip', 'overwrite'] as const)(
		'v1 cannot clear an existing pointer in %s collision mode',
		async (on_collision) => {
			const base = await createWorkflow(t.db, t.env, actor, {
				name: 'Base',
				initial_state: 'Shared',
				states: [{ name: 'Shared', category: 'active' }],
				transitions: []
			});
			const shared = base.states[0];
			await createWorkflow(t.db, t.env, actor, {
				name: 'Child',
				initial_state: 'Ready',
				states: [{ name: 'Ready', category: 'active', inherits_from: shared.id }],
				transitions: []
			});
			const exported = await buildLibraryDocument(t.db, USER);
			const document: LibraryDocument = {
				...exported,
				version: 1,
				// A permissive old reader may have left this later-version field
				// in place. Version 1 still has to ignore it completely.
				workflows: exported.workflows.map((workflow) =>
					workflow.name === 'Child'
						? {
								...workflow,
								states: workflow.states.map((state) => ({ ...state, inherits_from: null }))
							}
						: workflow
				)
			};

			const preview = await applyImport(t.db, t.env, actor, {
				document,
				on_collision,
				dry_run: true
			});
			expect(
				preview.entries.filter((entry) => entry.section === 'workflow').map((entry) => entry.action)
			).toEqual(['skip', 'skip']);
			const applied = await applyImport(t.db, t.env, actor, { document, on_collision });
			expect(applied.counts.overwrite).toBe(0);
			expect(pointers(await buildLibraryDocument(t.db, USER))).toEqual([
				'Child/Ready -> Base/Shared'
			]);
		}
	);

	it("passes the API's depth refusal through as the entry's error", async () => {
		await seedInheritance();
		const document = await buildLibraryDocument(t.db, USER);
		// One more link than `MAX_INHERITANCE_CHAIN` allows: Base / Shared →
		// Alpha / Design → Alpha / Review → here.
		document.workflows.push({
			name: 'Gamma',
			initial_state: 'Start',
			states: [{ name: 'Start', category: 'active', inherits_from: 'Alpha/Review' }],
			transitions: []
		});
		const target = freshDeployment();
		const result = await applyImport(target.db, target.env, actor, { document });
		const gamma = result.entries.find((e) => e.ref.includes('Gamma'))!;
		expect(gamma.action).toBe('error');
		expect(gamma.reason).toMatch(/chain/i);
		// Everything else still landed.
		expect(result.counts.create).toBeGreaterThan(0);
	});
});

describe('applyImport — structural identity', () => {
	// Tines/413. Both sides gate "Finish" differently: the incoming one wants a
	// `tests` artifact too, the existing one only names it inside the `pr`
	// requirement's description. The old fingerprint concatenated those fields
	// with `,` and `:`, so the two encoded identically and the import silently
	// skipped a workflow whose gates it did not have.
	const GATE_COLLISION = {
		name: 'Gate collision',
		initial_state: 'Work',
		states: [
			{ name: 'Work', category: 'active' as const },
			{ name: 'Done', category: 'done' as const }
		],
		transitions: [
			{
				name: 'Finish',
				from: 'Work',
				to: 'Done',
				requires: [
					{ artifact: 'pr', type: 'pr' as const, description: 'Ship' },
					{ artifact: 'tests', type: 'text' as const }
				]
			}
		]
	};
	// Same workflow, transitions and requirements listed the other way round:
	// order is not identity, and a real import must still call it a skip.
	const REORDERED = {
		name: 'Reordered',
		initial_state: 'Work',
		states: [
			{ name: 'Work', category: 'active' as const },
			{ name: 'Done', category: 'done' as const }
		],
		transitions: [
			{
				name: 'Finish',
				from: 'Work',
				to: 'Done',
				requires: [
					{ artifact: 'pr', type: 'pr' as const },
					{ artifact: 'tests', type: 'text' as const }
				]
			},
			{ name: 'Reopen', from: 'Done', to: 'Work' }
		]
	};
	const REORDERED_MIRROR = {
		...REORDERED,
		transitions: [
			{ name: 'Reopen', from: 'Done', to: 'Work' },
			{
				name: 'Finish',
				from: 'Work',
				to: 'Done',
				requires: [
					{ artifact: 'tests', type: 'text' as const },
					{ artifact: 'pr', type: 'pr' as const }
				]
			}
		]
	};
	const NEAR_MISS = {
		...GATE_COLLISION,
		transitions: [
			{
				name: 'Finish',
				from: 'Work',
				to: 'Done',
				requires: [{ artifact: 'pr', type: 'pr' as const, description: 'Ship,tests:text::' }]
			}
		]
	};

	it.each([
		['on its own', {}],
		['even when asked to overwrite', { on_collision: 'overwrite' as const }]
	])(
		'refuses a workflow whose extra gate the existing description spells, %s',
		async (_l, opts) => {
			await createWorkflow(t.db, t.env, actor, GATE_COLLISION);
			await createWorkflow(t.db, t.env, actor, REORDERED);
			const target = freshDeployment();
			const stored = await createWorkflow(target.db, target.env, actor, NEAR_MISS);
			await createWorkflow(target.db, target.env, actor, REORDERED_MIRROR);
			const document = await buildLibraryDocument(t.db, USER);

			// Preview and apply plan alike: neither may call these identical.
			for (const dry_run of [true, false]) {
				const result = await applyImport(target.db, target.env, actor, {
					document,
					dry_run,
					...opts
				});
				const entry = result.entries.find((e) => e.ref === `workflow "Gate collision"`)!;
				expect(entry.action).toBe('refuse');
				expect(entry.reason).toMatch(/a different workflow already has this name/);
				// Its neighbour in the same document is the same workflow written
				// in another order: genuine identity still reads as identity.
				expect(result.entries.find((e) => e.ref === `workflow "Reordered"`)?.action).toBe('skip');
			}

			// Refusal is not a partial write: the destination workflow is the one
			// it was, gate and all.
			const after = await loadWorkflow(target.db, USER, stored.id);
			expect(after.states.map((s) => s.name)).toEqual(['Work', 'Done']);
			const byId = new Map(after.states.map((s) => [s.id, s.name]));
			expect(after.transitions).toHaveLength(1);
			expect(after.transitions[0].id).toBe(stored.transitions[0].id);
			expect(byId.get(after.transitions[0].from_state_id)).toBe('Work');
			expect(byId.get(after.transitions[0].to_state_id)).toBe('Done');
			expect(after.transitions[0].requires).toEqual([
				{ artifact: 'pr', type: 'pr', description: 'Ship,tests:text::' }
			]);
		}
	);
});
