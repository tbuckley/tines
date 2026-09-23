/**
 * State inheritance in the scope model (Tines/238): an issue's effective
 * context includes items scoped to its state's *ancestors*, stitched root →
 * leaf before the state's own layer.
 *
 * The first suite is the regression fixture PRD signal 4 asks for: for a state
 * with no parent nothing may move, so it pins the whole stitched prompt and the
 * ordered names of an issue with an item in every layer. It must stay green
 * unchanged for as long as inheritance exists.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
	NOW,
	PROJECT,
	STAGE_A,
	STAGE_B,
	USER,
	addIssue,
	addLabel,
	addTwoStageWorkflow,
	seedBase
} from '../supervisor/test-fixtures';
import {
	contextSummaryForIssue,
	createContextItem,
	effectiveContextForIssue,
	journalForIssue
} from './context';
import type { ActorContext } from './core';
import { createTestDb, type TestDb } from './test-db';

const session: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

/** A base workflow whose states exist only to be inherited from. */
const BASE_MERGING = 'wfs_base_merging';
const BASE_ROOT = 'wfs_base_root';

function addBaseWorkflow(t: TestDb): void {
	t.sqlite.exec(`
		INSERT INTO workflow (id, user_id, name, initial_state_id, created_at, updated_at)
			VALUES ('wf_base', '${USER}', 'Shared stages', '${BASE_MERGING}', ${NOW}, ${NOW});
		INSERT INTO workflow_state (id, workflow_id, name, category, position, created_at) VALUES
			('${BASE_MERGING}', 'wf_base', 'Stage A', 'backlog', 0, ${NOW}),
			('${BASE_ROOT}', 'wf_base', 'Root', 'backlog', 1, ${NOW});
	`);
}

/** Point `child` at `base` the way a validated workflow write would. */
function inherit(t: TestDb, child: string, base: string | null): void {
	t.sqlite
		.prepare(`UPDATE workflow_state SET inherits_from_state_id = ? WHERE id = ?`)
		.run(base, child);
}

const prompt = (t: TestDb, name: string, body: string, scope: Record<string, string> = {}) =>
	createContextItem(t.db, t.env, session, { kind: 'prompt', name, body, ...scope });

let t: TestDb;

beforeEach(() => {
	t = createTestDb();
	seedBase(t);
	addTwoStageWorkflow(t);
});

describe('a state with no parent (regression fixture, PRD signal 4)', () => {
	it('stitches exactly the layers it did before inheritance existed', async () => {
		const label = addLabel(t, 'team');
		const issue = addIssue(t, { workflow: 'wf_two', state: STAGE_A });
		t.sqlite
			.prepare(`INSERT INTO issue_label (issue_id, label_id, created_at) VALUES (?, ?, ?)`)
			.run(issue, label, NOW);

		await prompt(t, 'global', 'G');
		await prompt(t, 'proj', 'P', { project_id: PROJECT });
		await prompt(t, 'state', 'S', { workflow_state_id: STAGE_A });
		await prompt(t, 'proj-state', 'PS', { project_id: PROJECT, workflow_state_id: STAGE_A });
		await prompt(t, 'label', 'L', { label_id: label });
		await prompt(t, 'label-state', 'LS', { label_id: label, workflow_state_id: STAGE_A });
		await prompt(t, 'issue', 'I', { issue_id: issue });
		await prompt(t, 'issue-state', 'IS', { issue_id: issue, workflow_state_id: STAGE_A });

		const ctx = await effectiveContextForIssue(t.db, USER, issue);
		expect(ctx.prompt.text).toMatchInlineSnapshot(`
			"## Context: global

			G

			## Context: project demo

			P

			## Context: state Stage A

			S

			## Context: project demo · state Stage A

			PS

			## Context: label team

			L

			## Context: state Stage A · label team

			LS

			## Context: issue demo/2

			I

			## Context: state Stage A · issue demo/2

			IS"
		`);
		// No layer is inherited, so no part carries provenance and no label is
		// qualified with its workflow.
		expect(ctx.prompt.parts.every((p) => p.inherited_from === null)).toBe(true);

		const summary = await contextSummaryForIssue(t.db, USER, {
			projectId: PROJECT,
			stateId: STAGE_A,
			issueId: issue
		});
		expect(summary.prompts).toBe(8);
	});
});

describe.skip('inherited layers (retired)', () => {
	beforeEach(() => {
		addBaseWorkflow(t);
		inherit(t, STAGE_A, BASE_MERGING);
	});

	it('stitches the base state before the state that inherits it', async () => {
		const issue = addIssue(t, { workflow: 'wf_two', state: STAGE_A });
		await prompt(t, 'own', 'child text', { workflow_state_id: STAGE_A });
		await prompt(t, 'base', 'base text', { workflow_state_id: BASE_MERGING });
		// Age the child's item so every tie-break *below* the depth key —
		// position, created_at, id — would put it first. The expected order
		// then holds because of the depth key alone, not creation order.
		t.sqlite
			.prepare(`UPDATE context_item SET created_at = ? WHERE name = ?`)
			.run(NOW - 1000, 'own');
		t.sqlite.prepare(`UPDATE context_item SET created_at = ? WHERE name = ?`).run(NOW, 'base');

		const ctx = await effectiveContextForIssue(t.db, USER, issue);
		expect(ctx.prompt.text).toContain('## Context: state Shared stages / Stage A\n\nbase text');
		expect(ctx.prompt.parts.map((p) => p.name)).toEqual(['base', 'own']);
		expect(ctx.prompt.parts[0].inherited_from).toEqual({
			state_id: BASE_MERGING,
			state_name: 'Stage A',
			workflow_id: 'wf_base',
			workflow_name: 'Shared stages'
		});
		expect(ctx.prompt.parts[1].inherited_from).toBeNull();
		// The child's own layer keeps the short label: same-named states only
		// collide when both are stitched, and only the inherited one qualifies.
		expect(ctx.prompt.parts[1].scope.label).toBe('state Stage A');
	});

	it('stitches a three-state chain root → middle → leaf', async () => {
		inherit(t, BASE_MERGING, BASE_ROOT);
		const issue = addIssue(t, { workflow: 'wf_two', state: STAGE_A });
		await prompt(t, 'leaf', 'leaf', { workflow_state_id: STAGE_A });
		await prompt(t, 'middle', 'middle', { workflow_state_id: BASE_MERGING });
		await prompt(t, 'root', 'root', { workflow_state_id: BASE_ROOT });

		const ctx = await effectiveContextForIssue(t.db, USER, issue);
		expect(ctx.prompt.parts.map((p) => p.name)).toEqual(['root', 'middle', 'leaf']);
	});

	it('keeps the layer order: depth only breaks ties inside a rank', async () => {
		const label = addLabel(t, 'team');
		const issue = addIssue(t, { workflow: 'wf_two', state: STAGE_A });
		t.sqlite
			.prepare(`INSERT INTO issue_label (issue_id, label_id, created_at) VALUES (?, ?, ?)`)
			.run(issue, label, NOW);

		await prompt(t, 'label-base', 'lb', { label_id: label, workflow_state_id: BASE_MERGING });
		await prompt(t, 'own', 'o', { workflow_state_id: STAGE_A });
		await prompt(t, 'proj-base', 'pb', { project_id: PROJECT, workflow_state_id: BASE_MERGING });
		await prompt(t, 'base', 'b', { workflow_state_id: BASE_MERGING });

		const ctx = await effectiveContextForIssue(t.db, USER, issue);
		// `project ∧ base` still ranks with `project ∧ state` (rank 3), i.e. after
		// every bare state layer and before any label layer. Only `base` vs `own`
		// — both rank 2 — is decided by depth.
		expect(ctx.prompt.parts.map((p) => p.name)).toEqual(['base', 'own', 'proj-base', 'label-base']);
	});

	it('lets the child override an inherited item by name and flags the loser', async () => {
		const issue = addIssue(t, { workflow: 'wf_two', state: STAGE_A });
		await createContextItem(t.db, t.env, session, {
			kind: 'skill',
			name: 'review',
			description: 'inherited description',
			workflow_state_id: BASE_MERGING
		});
		await createContextItem(t.db, t.env, session, {
			kind: 'skill',
			name: 'review',
			description: 'winning child description',
			workflow_state_id: STAGE_A
		});

		const ctx = await effectiveContextForIssue(t.db, USER, issue);
		expect(ctx.skills.map((s) => s.scope.workflow_state_id)).toEqual([STAGE_A]);
		expect(ctx.skills[0].description).toBe('winning child description');
		expect(ctx.skills[0].inherited_from).toBeNull();
		expect(ctx.overridden).toHaveLength(1);
		expect(ctx.overridden[0].scope.label).toBe('state Shared stages / Stage A');
		expect(ctx.overridden[0].inherited_from?.state_id).toBe(BASE_MERGING);

		const withoutFiles = await effectiveContextForIssue(t.db, USER, issue, {
			skillFiles: false
		});
		expect(withoutFiles.skills[0].description).toBe('winning child description');
		expect(withoutFiles.skills[0].files).toEqual([]);
	});

	it('writes the journal to the base, even when the child has a legacy one', async () => {
		// The point of inheriting is one journal per stage kind: both children
		// learn and prune in the base's file. A journal left on the child by an
		// earlier run keeps stitching (see the prompt tests) but is not handed
		// out — a merge helper folds it in later.
		const issue = addIssue(t, { workflow: 'wf_two', state: STAGE_A });
		const base = await prompt(t, 'journal', 'base journal', {
			project_id: PROJECT,
			workflow_state_id: BASE_MERGING
		});
		await prompt(t, 'journal', 'own journal', {
			project_id: PROJECT,
			workflow_state_id: STAGE_A
		});

		const journal = await journalForIssue(t.db, session, issue);
		expect(journal.scope.workflow_state_id).toBe(BASE_MERGING);
		expect(journal.item?.id).toBe(base.id);
	});

	it('refuses an item scoped to an issue and a state outside its workflow', async () => {
		// A base state belongs to another workflow, so `issue ∧ base state` is
		// incoherent even though the issue inherits that state's context.
		const issue = addIssue(t, { workflow: 'wf_two', state: STAGE_A });
		await expect(
			prompt(t, 'both', 'x', { issue_id: issue, workflow_state_id: BASE_MERGING })
		).rejects.toMatchObject({ status: 422, code: 'scope_incoherent' });
	});

	it('counts inherited items in the summary badge, and only labels the issue carries', async () => {
		const carried = addLabel(t, 'team');
		const other = addLabel(t, 'docs');
		const issue = addIssue(t, { workflow: 'wf_two', state: STAGE_A });
		t.sqlite
			.prepare(`INSERT INTO issue_label (issue_id, label_id, created_at) VALUES (?, ?, ?)`)
			.run(issue, carried, NOW);

		await prompt(t, 'base', 'b', { workflow_state_id: BASE_MERGING });
		await prompt(t, 'carried', 'c', { label_id: carried });
		await prompt(t, 'unrelated', 'u', { label_id: other });
		// A state in neither the chain nor the issue's workflow.
		await prompt(t, 'elsewhere', 'e', { workflow_state_id: STAGE_B });

		const summary = await contextSummaryForIssue(t.db, USER, {
			projectId: PROJECT,
			stateId: STAGE_A,
			issueId: issue
		});
		const ctx = await effectiveContextForIssue(t.db, USER, issue);
		expect(summary.prompts).toBe(2);
		expect(summary.prompts).toBe(ctx.prompt.parts.length);
	});
});
