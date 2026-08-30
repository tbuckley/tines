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
import { createContextItem, journalForIssue } from './context';
import { ApiFail, type ActorContext } from './core';
import { transitionIssue } from './issues';
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
	it('gives a session actor the issue\'s current state', async () => {
		const issue = addIssue(t);
		const journal = await journalForIssue(t.db, session, issue);
		expect(journal.anchor).toBe('current');
		expect(journal.note).toBeNull();
		expect(journal.scope.workflow_state_id).toBe(OPEN);
		expect(journal.scope.label).toBe('project demo · state Open');
	});

	it("anchors a run key to its launch state after the issue has moved on", async () => {
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
		t.sqlite.exec(`UPDATE agent_run SET state_id_at_start = 'wfs_gone' WHERE id = '${actor.agentRunId}'`);

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
