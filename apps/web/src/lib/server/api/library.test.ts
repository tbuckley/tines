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
import { applyImport, assertImportableDocument, buildLibraryDocument, planImport } from './library';
import { createWorkflow } from './workflows';
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
