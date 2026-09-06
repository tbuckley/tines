/**
 * Journal resolution: which journal a caller's `tines journal` commands
 * target. The trap this replaces — appending after moving the issue files the
 * lesson in the *next* stage's journal — is scenario 2 below.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
	CLOSED,
	OPEN,
	PROJECT,
	REVIEW,
	USER,
	addIssue,
	addRun,
	addRunner,
	seedBase
} from '../supervisor/test-fixtures';
import {
	createContextItem,
	effectiveContextForIssue,
	issueBlock,
	journalForIssue
} from './context';
import { ApiFail, type ActorContext } from './core';
import { getIssueDetail, transitionIssue } from './issues';
import { createTestDb, type TestDb } from './test-db';

const session: ActorContext = {
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

/** A run on `issueId`, its api_key row, and the actor that key resolves to. */
function runActor(
	issueId: string,
	opts: { stateAtStart?: string; id?: string } = {}
): ActorContext {
	const runner = addRunner(t);
	const runId = addRun(t, {
		id: opts.id,
		issueId,
		runnerId: runner,
		status: 'running',
		stateAtStart: opts.stateAtStart ?? OPEN
	});
	const keyId = `key_${runId}`;
	t.sqlite.exec(`
		INSERT INTO api_key (id, user_id, name, key_hash, key_prefix, agent_run_id, expires_at, created_at)
			VALUES ('${keyId}', '${USER}', 'run ${runId}', 'h_${runId}', 'p', '${runId}', 9999999999999, 0);
	`);
	return {
		userId: USER,
		userName: 'alice',
		apiKeyId: keyId,
		apiKeyName: `run ${runId}`,
		viaSession: false,
		agentRunId: runId
	};
}

const seedJournal = (stateId: string, body: string) =>
	createContextItem(t.db, t.env, session, {
		kind: 'prompt',
		name: 'journal',
		project_id: PROJECT,
		workflow_state_id: stateId,
		body
	});

describe('journalForIssue', () => {
	it("gives a session actor the issue's current state", async () => {
		const issue = addIssue(t);
		const journal = await journalForIssue(t.db, session, issue);
		expect(journal.anchor).toBe('current');
		expect(journal.note).toBeNull();
		expect(journal.scope.workflow_state_id).toBe(OPEN);
		expect(journal.scope.label).toBe('project demo · state Open');
	});

	it('anchors a run key to its launch state after the issue has moved on', async () => {
		const issue = addIssue(t);
		const actor = runActor(issue, { stateAtStart: OPEN });
		await transitionIssue(t.db, t.env, session, issue, { action: 'Submit for review' });

		const journal = await journalForIssue(t.db, actor, issue);
		expect(journal.anchor).toBe('run');
		expect(journal.note).toBeNull();
		expect(journal.scope.workflow_state_id).toBe(OPEN);
		expect(journal.scope.label).toBe('project demo · state Open');
		// The trap: the issue itself now sits in the next stage.
		expect(t.all(`SELECT state_id FROM issue WHERE id = '${issue}'`)).toEqual([
			{ state_id: REVIEW }
		]);
	});

	it('returns the journal item at the anchored scope, and null when only the next stage has one', async () => {
		const issue = addIssue(t);
		const actor = runActor(issue, { stateAtStart: OPEN });
		await transitionIssue(t.db, t.env, session, issue, { action: 'Submit for review' });

		const launchJournal = await seedJournal(OPEN, '- lesson from Open');
		expect((await journalForIssue(t.db, actor, issue)).item?.id).toBe(launchJournal.id);
		// The session actor, on the same issue, still sees the current state's
		// journal — which does not exist yet.
		expect(await journalForIssue(t.db, session, issue)).toMatchObject({
			anchor: 'current',
			item: null
		});

		const reviewJournal = await seedJournal(REVIEW, '- lesson from Human Review');
		expect((await journalForIssue(t.db, session, issue)).item?.id).toBe(reviewJournal.id);
		// Unmoved: the run key still owns the Open journal.
		expect((await journalForIssue(t.db, actor, issue)).item?.id).toBe(launchJournal.id);
	});

	it("falls back to the current state for another issue's run key, and says so", async () => {
		const mine = addIssue(t);
		const other = addIssue(t, { state: CLOSED });
		const actor = runActor(other, { stateAtStart: OPEN });

		const journal = await journalForIssue(t.db, actor, mine);
		expect(journal.anchor).toBe('current');
		expect(journal.scope.workflow_state_id).toBe(OPEN);
		const otherNumber = t.all(`SELECT number FROM issue WHERE id = '${other}'`)[0].number;
		expect(journal.note).toBe(
			`this run key belongs to demo/${otherNumber}; using the requested issue's current state`
		);
	});

	it('falls back to the current state when the launch state no longer exists', async () => {
		const issue = addIssue(t, { state: REVIEW });
		const actor = runActor(issue, { stateAtStart: OPEN });
		// A workflow edit mid-run: `state_id_at_start` is kept but dangles.
		t.sqlite.exec(
			`UPDATE agent_run SET state_id_at_start = 'wfs_gone' WHERE id = '${actor.agentRunId}'`
		);

		const journal = await journalForIssue(t.db, actor, issue);
		expect(journal.anchor).toBe('current');
		expect(journal.scope.workflow_state_id).toBe(REVIEW);
		expect(journal.note).toBe(
			"the state this run was launched in no longer exists; using the issue's current state"
		);
	});

	it('404s on an unknown or foreign issue', async () => {
		let error: unknown;
		await journalForIssue(t.db, session, 'iss_nope').catch((e) => (error = e));
		expect(error).toBeInstanceOf(ApiFail);
		expect((error as ApiFail).status).toBe(404);
	});
});

/**
 * One writable journal for a family of stages (Tines/239): when a state
 * inherits from another, the journal handed out is the *root* ancestor's, so
 * two workflows whose stages share a base learn and prune in one file.
 */
describe('journalForIssue follows the root of the inheritance chain', () => {
	const BASE_MERGING = 'wfs_base_merging';
	const BASE_ROOT = 'wfs_base_root';

	/** A base workflow whose states exist only to be inherited from. */
	const addBaseWorkflow = () =>
		t.sqlite.exec(`
			INSERT INTO workflow (id, user_id, name, initial_state_id, created_at, updated_at)
				VALUES ('wf_base', '${USER}', 'Shared stages', '${BASE_MERGING}', 0, 0);
			INSERT INTO workflow_state (id, workflow_id, name, category, position, created_at) VALUES
				('${BASE_MERGING}', 'wf_base', 'Merging', 'backlog', 0, 0),
				('${BASE_ROOT}', 'wf_base', 'Root', 'backlog', 1, 0);
		`);

	const inherit = (child: string, base: string | null) =>
		t.sqlite
			.prepare(`UPDATE workflow_state SET inherits_from_state_id = ? WHERE id = ?`)
			.run(base, child);

	beforeEach(addBaseWorkflow);

	it('resolves a depth-2 chain to the base, for a session and for a run key', async () => {
		inherit(OPEN, BASE_MERGING);
		const base = await seedJournal(BASE_MERGING, '- shared lesson');
		const issue = addIssue(t);

		for (const actor of [session, runActor(issue, { stateAtStart: OPEN })]) {
			const journal = await journalForIssue(t.db, actor, issue);
			expect(journal.scope.workflow_state_id).toBe(BASE_MERGING);
			expect(journal.scope.label).toBe('project demo · state Merging');
			expect(journal.item?.id).toBe(base.id);
		}
	});

	it('resolves a depth-3 chain to the root, not to the state in the middle', async () => {
		inherit(OPEN, BASE_MERGING);
		inherit(BASE_MERGING, BASE_ROOT);
		await seedJournal(BASE_MERGING, '- middle lesson');
		const root = await seedJournal(BASE_ROOT, '- root lesson');

		const journal = await journalForIssue(t.db, session, addIssue(t));
		expect(journal.scope.workflow_state_id).toBe(BASE_ROOT);
		expect(journal.item?.id).toBe(root.id);
	});

	it('anchors a run key to the root of its LAUNCH state, not of the current one', async () => {
		inherit(OPEN, BASE_MERGING);
		const base = await seedJournal(BASE_MERGING, '- shared lesson');
		await seedJournal(REVIEW, '- review lesson');
		const issue = addIssue(t);
		const actor = runActor(issue, { stateAtStart: OPEN });
		await transitionIssue(t.db, t.env, session, issue, { action: 'Submit for review' });

		const journal = await journalForIssue(t.db, actor, issue);
		expect(journal.anchor).toBe('run');
		expect(journal.scope.workflow_state_id).toBe(BASE_MERGING);
		expect(journal.item?.id).toBe(base.id);
		// Review does not inherit, so its own journal is still its own.
		expect((await journalForIssue(t.db, session, issue)).scope.workflow_state_id).toBe(REVIEW);
	});

	it('hands out the base journal, and reports null when only the child has one', async () => {
		inherit(OPEN, BASE_MERGING);
		const legacy = await seedJournal(OPEN, '- legacy lesson');
		const issue = addIssue(t);

		const before = await journalForIssue(t.db, session, issue);
		expect(before.scope.workflow_state_id).toBe(BASE_MERGING);
		expect(before.item).toBeNull();

		const base = await seedJournal(BASE_MERGING, '- shared lesson');
		const after = await journalForIssue(t.db, session, issue);
		expect(after.item?.id).toBe(base.id);
		expect(after.item?.id).not.toBe(legacy.id);
	});

	it("stitches a child's legacy journal read-only while naming the base as writable", async () => {
		inherit(OPEN, BASE_MERGING);
		await seedJournal(BASE_MERGING, '- shared lesson');
		await seedJournal(OPEN, '- legacy lesson');
		const issue = addIssue(t);

		const ctx = await effectiveContextForIssue(t.db, USER, issue);
		// Both headings survive: the legacy file is knowledge, and dropping it
		// would lose it until a merge helper folds it into the base.
		expect(ctx.prompt.text).toContain('## Journal (project demo · state Shared stages / Merging)');
		expect(ctx.prompt.text).toContain('## Journal (project demo · state Open)');
		expect(ctx.prompt.journal.inherited_from).toMatchObject({
			state_id: BASE_MERGING,
			state_name: 'Merging',
			workflow_name: 'Shared stages'
		});

		const detail = await getIssueDetail(t.db, USER, { id: issue });
		const block = issueBlock(detail, ctx);
		expect(block).toContain(
			'Your journal for this project and stage is the journal of Shared stages / Merging'
		);
		expect(block).toContain('(currently v1).');
		expect(block).toContain('The other "Journal" section above belongs to state Open alone');
		expect(block).toContain(`tines journal rewrite demo/${detail.number} --body @file`);
	});

	it('names the base state even when no journal exists there yet', async () => {
		inherit(OPEN, BASE_MERGING);
		const issue = addIssue(t);
		const block = issueBlock(
			await getIssueDetail(t.db, USER, { id: issue }),
			await effectiveContextForIssue(t.db, USER, issue)
		);
		expect(block).toContain(
			'No journal exists yet for project demo · state Shared stages / Merging. Start one:'
		);
	});

	it('leaves a state with no parent word-for-word as it was (PRD signal 4)', async () => {
		// The same fixture with the pointer cleared: nothing about the resolved
		// journal or the prompt section may move for a parentless state.
		await seedJournal(OPEN, '- own lesson');
		const issue = addIssue(t);
		const detail = await getIssueDetail(t.db, USER, { id: issue });

		const journal = await journalForIssue(t.db, session, issue);
		expect(journal.scope.workflow_state_id).toBe(OPEN);
		expect(journal.scope.label).toBe('project demo · state Open');

		const ctx = await effectiveContextForIssue(t.db, USER, issue);
		expect(ctx.prompt.journal).toEqual({
			state_id: OPEN,
			inherited_from: null,
			item_id: journal.item?.id,
			version: 1
		});
		const block = issueBlock(detail, ctx);
		expect(block).toContain(
			[
				'Your journal for this project and stage is the "Journal" section above',
				'(currently v1).'
			].join('\n')
		);
		expect(block).not.toContain('is the journal of');
		expect(block).not.toContain('read-only');
	});
});
