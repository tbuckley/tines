/**
 * Starter bundles applied atomically with the project (Tines/248): each
 * built-in lands cleanly on an empty database, a second application reuses
 * the workflow it already created, every rejection happens before the first
 * write, and a failure midway leaves nothing behind.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { PROJECT_PROMPT_NAME, STARTER_IDS, STATE_PROMPT_NAME } from '@tines/shared';
import { NOW, USER, seedBase } from '../supervisor/test-fixtures';
import { STARTERS, type Starter } from '../starters';
import { effectiveContextForIssue, listContextItems } from './context';
import { ApiFail, type ActorContext, type Page } from './core';
import { getIssueDetail, listIssues } from './issues';
import { createProject } from './projects';
import { listStarters, resolveStarter } from './starters';
import { loadWorkflows } from './workflows';
import { createTestDb, type TestDb } from './test-db';

const actor: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

const REPO = 'https://github.com/alice/website.git';
const PAGE: Page = { cursor: null, limit: 100 };

let t: TestDb;

beforeEach(() => {
	t = createTestDb();
	seedBase(t);
});

const counts = () => ({
	projects: t.sqlite.prepare('SELECT COUNT(*) AS n FROM project').get() as { n: number },
	workflows: t.sqlite.prepare('SELECT COUNT(*) AS n FROM workflow').get() as { n: number },
	context: t.sqlite.prepare('SELECT COUNT(*) AS n FROM context_item').get() as { n: number },
	issues: t.sqlite.prepare('SELECT COUNT(*) AS n FROM issue').get() as { n: number }
});

const inputsFor = (id: string): Record<string, string> =>
	id === 'code' ? { repo_url: REPO } : id === 'plan' ? { brief: 'our move to Postgres' } : {};

describe('the starter menu', () => {
	it('advertises every built-in with its inputs and what it creates', () => {
		const items = listStarters();
		expect(items.map((i) => i.id)).toEqual([...STARTER_IDS]);

		const code = items.find((i) => i.id === 'code')!;
		expect(code.inputs.map((i) => [i.key, i.required])).toEqual([
			['repo_url', true],
			['repo_branch', false]
		]);
		expect(code.conventions_template).toContain('Test command');
		expect(code.creates.workflows).toEqual([
			{
				name: 'Code change',
				default: true,
				states: ['Backlog', 'In progress', 'Review', 'Done']
			}
		]);
		expect(code.creates.context).toEqual([{ kind: 'repo', name: '{{ repo_name }}' }]);
		expect(code.creates.first_issue).toEqual({
			title: 'Find and fix a bug',
			workflow: 'Code change',
			state: 'In progress'
		});

		// Two workflows, exactly one of them the default.
		const plan = items.find((i) => i.id === 'plan')!;
		expect(plan.creates.workflows.map((w) => w.name)).toEqual(['Idea', 'Scout']);
		expect(plan.creates.workflows.filter((w) => w.default).map((w) => w.name)).toEqual(['Idea']);
		// The first issue deliberately sits in the *non-default* workflow.
		expect(plan.creates.first_issue).toEqual({
			title: 'Scout candidates for {{ brief }}',
			workflow: 'Scout',
			state: 'Scouting'
		});

		const blank = items.find((i) => i.id === 'blank')!;
		expect(blank.inputs).toEqual([]);
		expect(blank.creates).toEqual({ workflows: [], context: [], first_issue: null });
	});
});

describe('applying a built-in to an empty database', () => {
	for (const id of STARTER_IDS) {
		it(`"${id}" creates everything it declares, in one request`, async () => {
			const starter = STARTERS[id];
			const created = await createProject(t.db, t.env, actor, {
				name: `p-${id}`,
				starter: { id, inputs: inputsFor(id) }
			});

			if (id === 'blank') {
				// Blank is the absence of a starter, so the response is a plain project.
				expect(created.starter).toBeUndefined();
				expect(created.default_workflow_id).toBeNull();
				expect((await listIssues(t.db, USER, { project: created.id }, PAGE)).items).toHaveLength(0);
				return;
			}

			const applied = created.starter!;
			expect(applied.id).toBe(id);
			expect(applied.workflows.map((w) => w.name)).toEqual(starter.workflows.map((w) => w.name));
			expect(applied.workflows.every((w) => !w.reused)).toBe(true);

			// The starter's default workflow becomes the project's.
			const wfs = await loadWorkflows(t.db, USER);
			const def = wfs.find((w) => w.name === starter.default_workflow)!;
			expect(created.default_workflow_id).toBe(def.id);

			// Workflow shape: every state and transition the content declares.
			for (const want of starter.workflows) {
				const got = wfs.find((w) => w.name === want.name)!;
				expect(got.states.map((s) => s.name)).toEqual(want.states.map((s) => s.name));
				expect(got.transitions.map((tr) => tr.name).sort()).toEqual(
					want.transitions.map((tr) => tr.name).sort()
				);
				// One "instructions" item per state that ships a prompt, and no more.
				const withPrompt = want.states.filter((s) => s.prompt !== undefined).map((s) => s.name);
				const seeded = (await listContextItems(t.db, USER, { kind: 'prompt' }, PAGE)).items;
				const stateItems = seeded.filter(
					(item) =>
						item.name === STATE_PROMPT_NAME &&
						got.states.some((s) => s.id === item.scope.workflow_state_id)
				);
				expect(
					stateItems
						.map((item) => got.states.find((s) => s.id === item.scope.workflow_state_id)!.name)
						.sort()
				).toEqual([...withPrompt].sort());
			}

			// Conventions: the rendered template, on the project.
			const projectItems = (await listContextItems(t.db, USER, { project: created.id }, PAGE))
				.items;
			const conventions = projectItems.find((i) => i.name === PROJECT_PROMPT_NAME)!;
			expect(conventions.body).toBe(
				starter.conventions_template!.replace('{{ brief }}', inputsFor(id).brief ?? '')
			);

			// The first issue is #1, in the state the starter names.
			const spec = starter.first_issue!;
			expect(applied.first_issue).toMatchObject({ number: 1, state_name: spec.state });
			const issue = await getIssueDetail(t.db, USER, { id: applied.first_issue!.id });
			expect(issue.number).toBe(1);
			expect(issue.state.name).toBe(spec.state);
			expect(issue.workflow.name).toBe(spec.workflow);

			// Events for every row, as any other create path writes them.
			const types = (t.sqlite.prepare('SELECT type FROM event').all() as { type: string }[]).map(
				(e) => e.type
			);
			expect(types).toContain('project.created');
			expect(types).toContain('workflow.created');
			expect(types).toContain('issue.created');
			expect(types).toContain('context.created');
		});
	}

	it('"code" pins the repository so the run workspace clones it', async () => {
		const created = await createProject(t.db, t.env, actor, {
			name: 'website',
			starter: { id: 'code', inputs: { repo_url: REPO, repo_branch: 'trunk' } }
		});
		const applied = created.starter!;
		expect(applied.context).toEqual([{ id: expect.any(String), kind: 'repo', name: 'website' }]);

		// The server side of the `repos.json` acceptance criterion.
		const ctx = await effectiveContextForIssue(t.db, USER, applied.first_issue!.id);
		expect(ctx.repos).toEqual([
			expect.objectContaining({ name: 'website', url: REPO, branch: 'trunk', dir: 'website' })
		]);
		// `{{ repo_name }}` reached the first issue's description too.
		const issue = await getIssueDetail(t.db, USER, { id: applied.first_issue!.id });
		expect(issue.description).toContain('website');
	});

	it('"code" installs the complete first pull-request loop', async () => {
		const starter = STARTERS.code;
		const workflow = starter.workflows[0];
		expect(workflow).toMatchObject({
			name: 'Code change',
			initial_state: 'Backlog',
			states: [
				{ name: 'Backlog', category: 'backlog' },
				{ name: 'In progress', category: 'active' },
				{ name: 'Review', category: 'awaiting_human' },
				{ name: 'Done', category: 'done' }
			]
		});
		expect(workflow.transitions).toEqual([
			{ name: 'Start', from: 'Backlog', to: 'In progress' },
			{
				name: 'Submit for review',
				from: 'In progress',
				to: 'Review',
				requires: [
					{ artifact: 'pr', type: 'pr', description: 'The pull request implementing this issue' }
				]
			},
			{ name: 'No bug found', from: 'In progress', to: 'Review' },
			{ name: 'Send back', from: 'Review', to: 'In progress' },
			{ name: 'Approve', from: 'Review', to: 'Done' },
			{ name: 'Abandon', from: 'In progress', to: 'Done' }
		]);

		const inProgress = workflow.states.find((state) => state.name === 'In progress')!;
		expect(inProgress.prompt).toContain('Unanswered template lines mean “not specified”');
		expect(inProgress.prompt).toContain('run the Test command');
		expect(inProgress.prompt).toContain('tines issues artifacts attach <ref> pr --pr <url>');
		expect(inProgress.prompt).toContain('tines issues move <ref> "Submit for review"');
		const reviewPrompt = workflow.states.find((state) => state.name === 'Review')!.prompt;
		expect(reviewPrompt).toContain('issue arrived through “No bug found”');
		expect(reviewPrompt).toContain('choose “Send back”');
		expect(starter.conventions_template?.split('\n').map((line) => line.split(':')[0])).toEqual([
			'Test command',
			'Branch rules',
			'PR expectations',
			'Where things live'
		]);
		expect(starter.first_issue).toMatchObject({
			title: 'Find and fix a bug',
			workflow: 'Code change',
			state: 'In progress'
		});
		expect(starter.first_issue?.description).toContain('a failing test, a crash, a wrong message');
		expect(starter.first_issue?.description).toContain('tines issues move <ref> "No bug found"');
		expect(starter.first_issue?.description).toContain('If nothing qualifies, do not invent work');
	});

	it('an optional input the caller omits renders as nothing, not as its token', async () => {
		const created = await createProject(t.db, t.env, actor, {
			name: 'nobranch',
			starter: { id: 'code', inputs: { repo_url: REPO } }
		});
		const items = (await listContextItems(t.db, USER, { project: created.id, kind: 'repo' }, PAGE))
			.items;
		expect(items[0].repo_branch).toBeNull();
	});
});

describe('the collision rule', () => {
	it('reuses an identical workflow rather than creating a second one', async () => {
		const first = await createProject(t.db, t.env, actor, {
			name: 'one',
			starter: { id: 'code', inputs: { repo_url: REPO } }
		});
		const second = await createProject(t.db, t.env, actor, {
			name: 'two',
			starter: { id: 'code', inputs: { repo_url: REPO } }
		});

		expect(second.starter!.workflows).toEqual([
			{ id: first.starter!.workflows[0].id, name: 'Code change', reused: true }
		]);
		expect(second.default_workflow_id).toBe(first.default_workflow_id);

		const wfs = await loadWorkflows(t.db, USER);
		expect(wfs.filter((w) => w.name.startsWith('Code change'))).toHaveLength(1);

		// Stage instructions are state-scoped, so the reuse path must not
		// re-seed them: doing so would hit `context_item_name_scope_uq` and
		// take the whole creation down.
		const prompts = (await listContextItems(t.db, USER, { kind: 'prompt' }, PAGE)).items;
		const instructions = prompts.filter((i) => i.name === STATE_PROMPT_NAME);
		expect(instructions).toHaveLength(2);

		// The second first issue sits in the *existing* workflow's state.
		const issue = await getIssueDetail(t.db, USER, { id: second.starter!.first_issue!.id });
		expect(issue.workflow.id).toBe(first.starter!.workflows[0].id);
		expect(issue.state.name).toBe('In progress');
	});

	it('renames when a different workflow already has the name', async () => {
		t.sqlite.exec(`
			INSERT INTO workflow (id, user_id, name, description, initial_state_id, created_at, updated_at)
				VALUES ('wf_x', '${USER}', 'Code change', '', 'wfs_x', ${NOW}, ${NOW});
			INSERT INTO workflow_state (id, workflow_id, name, category, position, created_at)
				VALUES ('wfs_x', 'wf_x', 'Only', 'active', 0, ${NOW});
		`);
		const created = await createProject(t.db, t.env, actor, {
			name: 'mine',
			starter: { id: 'code', inputs: { repo_url: REPO } }
		});
		expect(created.starter!.workflows[0]).toMatchObject({
			name: 'Code change (mine)',
			reused: false
		});
	});

	it('truncates the project suffix rather than failing on a long name', async () => {
		t.sqlite.exec(`
			INSERT INTO workflow (id, user_id, name, description, initial_state_id, created_at, updated_at)
				VALUES ('wf_x', '${USER}', 'Code change', '', 'wfs_x', ${NOW}, ${NOW});
			INSERT INTO workflow_state (id, workflow_id, name, category, position, created_at)
				VALUES ('wfs_x', 'wf_x', 'Only', 'active', 0, ${NOW});
		`);
		const long = 'x'.repeat(200);
		const created = await createProject(t.db, t.env, actor, {
			name: long,
			starter: { id: 'code', inputs: { repo_url: REPO } }
		});
		const name = created.starter!.workflows[0].name;
		expect(name.length).toBeLessThanOrEqual(200);
		expect(name.startsWith('Code change (x')).toBe(true);
	});
});

describe('rejections happen before any write', () => {
	const cases: [string, Parameters<typeof createProject>[3], string][] = [
		['an unknown id', { name: 'a', starter: { id: 'nope' } }, 'unknown_starter'],
		['a missing required input', { name: 'a', starter: { id: 'code' } }, 'missing_starter_input'],
		[
			'an input the starter does not declare',
			{ name: 'a', starter: { id: 'code', inputs: { repo_url: REPO, brief: 'x' } } },
			'unknown_starter_input'
		],
		[
			'an input on blank',
			{ name: 'a', starter: { id: 'blank', inputs: { brief: 'x' } } },
			'unknown_starter_input'
		],
		[
			'a default workflow alongside a starter that sets one',
			{
				name: 'a',
				default_workflow_id: 'wf_standard',
				starter: { id: 'code', inputs: { repo_url: REPO } }
			},
			'starter_sets_default_workflow'
		]
	];
	for (const [label, body, code] of cases) {
		it(`422s on ${label}, leaving nothing behind`, async () => {
			const before = counts();
			await expect(createProject(t.db, t.env, actor, body)).rejects.toThrow(
				expect.objectContaining({ code, status: 422 }) as Error
			);
			expect(counts()).toEqual(before);
		});
	}

	it('names the input the caller should have sent', async () => {
		const err = await createProject(t.db, t.env, actor, {
			name: 'a',
			starter: { id: 'code' }
		}).catch((e: ApiFail) => e);
		expect((err as ApiFail).details).toMatchObject({ field: 'starter.inputs.repo_url' });
	});
});

describe('a failure midway leaves no project behind', () => {
	it('rolls the whole batch back', async () => {
		// Two repo entries with the same name violate `context_item_name_scope_uq`,
		// which fires *after* the project row is already in the batch.
		const broken: Starter = {
			...STARTERS.code,
			context: [...STARTERS.code.context, { ...STARTERS.code.context[0] }]
		};
		await expect(
			createProject(
				t.db,
				t.env,
				actor,
				{ name: 'doomed', starter: { id: 'code', inputs: { repo_url: REPO } } },
				{ starters: { ...STARTERS, code: broken } }
			)
		).rejects.toThrow();
		expect(counts()).toEqual({
			projects: { n: 1 }, // the seeded fixture project, and nothing else
			workflows: { n: 1 }, // the standard workflow from the migration
			context: { n: 0 },
			issues: { n: 0 }
		});
	});
});

describe('blank is exactly today’s behaviour', () => {
	it('matches an omitted starter, initial_prompt included', async () => {
		const withBlank = await createProject(t.db, t.env, actor, {
			name: 'a',
			initial_prompt: 'be nice'
		});
		const omitted = await createProject(t.db, t.env, actor, {
			name: 'b',
			initial_prompt: 'be nice',
			starter: { id: 'blank' }
		});
		expect(withBlank.starter).toBeUndefined();
		expect(omitted.starter).toBeUndefined();
		for (const p of [withBlank, omitted]) {
			const items = (await listContextItems(t.db, USER, { project: p.id }, PAGE)).items;
			expect(items.map((i) => [i.name, i.body])).toEqual([[PROJECT_PROMPT_NAME, 'be nice']]);
		}
	});

	it('an explicit initial_prompt beats the starter template, and "" means none', async () => {
		const override = await createProject(t.db, t.env, actor, {
			name: 'a',
			initial_prompt: 'mine',
			starter: { id: 'code', inputs: { repo_url: REPO } }
		});
		const overrideItems = (
			await listContextItems(t.db, USER, { project: override.id, kind: 'prompt' }, PAGE)
		).items;
		expect(overrideItems.map((i) => i.body)).toEqual(['mine']);

		const cleared = await createProject(t.db, t.env, actor, {
			name: 'b',
			initial_prompt: '',
			starter: { id: 'code', inputs: { repo_url: REPO } }
		});
		const clearedItems = (
			await listContextItems(t.db, USER, { project: cleared.id, kind: 'prompt' }, PAGE)
		).items;
		expect(clearedItems).toHaveLength(0);
	});
});

describe('resolveStarter', () => {
	it('treats an absent starter and blank alike', () => {
		expect(resolveStarter(undefined)).toBeNull();
		expect(resolveStarter({ id: 'blank' })).toBeNull();
	});

	it('trims values and defaults absent optional inputs to empty', () => {
		const resolved = resolveStarter({ id: 'code', inputs: { repo_url: `  ${REPO}  ` } })!;
		expect(resolved.inputs).toEqual({ repo_url: REPO, repo_branch: '' });
	});
});

describe('Plan journey content and compatibility limits', () => {
	it('creates actionable conventions, guide, and a full multiline first brief', async () => {
		const brief = 'Two adults and two children\nRainy-day backup needed';
		const created = await createProject(t.db, t.env, actor, {
			name: 'Weekend',
			starter: { id: 'plan', inputs: { brief } }
		});
		const items = (await listContextItems(t.db, USER, { project: created.id }, PAGE)).items;
		expect(
			items.map((item) => [item.name, item.position]).sort((a, b) => Number(a[1]) - Number(b[1]))
		).toEqual([
			['conventions', 0],
			['planning-guide', 1]
		]);
		expect(items[0].body).toContain('Constraints (naps, walking, budget, diet):');
		expect(items[1].body).toContain(created.id);
		expect(items[1].body).toContain('Never invent addresses, hours, prices');
		expect(items[1].body).toContain('tines issues move "<candidate-ref>" "Propose"');
		const issue = await getIssueDetail(t.db, USER, { id: created.starter!.first_issue!.id });
		expect(issue.description).toContain(brief);
		expect(issue.description).toContain('Nothing to file');
	});

	it('caps the previewable title but preserves the maximum-length brief in its description', async () => {
		const brief = 'x'.repeat(10_000);
		const created = await createProject(t.db, t.env, actor, {
			name: 'Long',
			starter: { id: 'plan', inputs: { brief } }
		});
		const issue = await getIssueDetail(t.db, USER, { id: created.starter!.first_issue!.id });
		expect(issue.title).toHaveLength(500);
		expect(issue.description).toContain(brief);
	});

	it('keeps the planning guide when conventions are explicitly omitted', async () => {
		const created = await createProject(t.db, t.env, actor, {
			name: 'No conventions',
			initial_prompt: '',
			starter: { id: 'plan', inputs: { brief: 'A family day out' } }
		});
		const items = (await listContextItems(t.db, USER, { project: created.id }, PAGE)).items;
		expect(items.map((item) => [item.name, item.position])).toEqual([['planning-guide', 1]]);
	});

	it('rejects a starter-owned conventions entry before any write', async () => {
		const broken: Starter = {
			...STARTERS.plan,
			context: [{ kind: 'prompt', name: ' conventions ', body: 'collision' }]
		};
		const before = counts();
		await expect(
			createProject(
				t.db,
				t.env,
				actor,
				{ name: 'Bad', starter: { id: 'plan', inputs: { brief: 'x' } } },
				{ starters: { ...STARTERS, plan: broken } }
			)
		).rejects.toThrow(expect.objectContaining({ code: 'invalid_starter', status: 422 }) as Error);
		expect(counts()).toEqual(before);
	});

	it('isolates placement bindings when workflows are reused', async () => {
		const first = await createProject(t.db, t.env, actor, {
			name: 'First',
			starter: { id: 'plan', inputs: { brief: 'First brief' } }
		});
		const second = await createProject(t.db, t.env, actor, {
			name: 'Second',
			starter: { id: 'plan', inputs: { brief: 'Second brief' } }
		});
		expect(second.starter!.workflows.every((workflow) => workflow.reused)).toBe(true);
		const guide = (
			await listContextItems(t.db, USER, { project: second.id, kind: 'prompt' }, PAGE)
		).items.find((item) => item.name === 'planning-guide')!;
		expect(guide.body).toContain(second.id);
		expect(guide.body).not.toContain(first.id);
	});
});
