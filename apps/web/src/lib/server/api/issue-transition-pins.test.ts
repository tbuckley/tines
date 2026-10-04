import { TEST_NOOP_DISPATCH_EFFECTS, recordDispatchEffects } from './test-dispatch-effects';
import { FULL_API_KEY_PERMISSIONS } from '@tines/shared';
import { describe, expect, it } from 'vitest';
import {
	CLOSED,
	OPEN,
	PROJECT,
	REVIEW,
	USER,
	addIssue,
	addRun,
	addRunKey,
	addRunner,
	eventsOfType,
	issueById,
	seedBase
} from '../supervisor/test-fixtures';
import type { ActorContext } from './core';
import { getIssueDetail, listIssues, transitionIssue, updateIssue } from './issues';
import { createTestDb, type TestDb } from './test-db';
import { updateWorkflow } from './workflows';

// Tines/608 Part D (former Tines/502): a transition commits only against the
// state visit and workflow graph it read, in a project that is not shared.

const actor: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

const SUBMIT = 'wft_std_open_review';
const APPROVE = 'wft_std_review_closed';

/** Runs `interleave` after the delayed request's reads, just before its batch. */
function beforeBatch(t: TestDb, interleave: () => Promise<unknown>): Env {
	const batch = t.env.DB.batch.bind(t.env.DB);
	let fired = false;
	return {
		...t.env,
		DB: {
			...t.env.DB,
			batch: async (statements: Parameters<typeof batch>[0]) => {
				if (!fired) {
					fired = true;
					await interleave();
				}
				return batch(statements);
			}
		}
	} as Env;
}

function move(t: TestDb, id: string, body: Parameters<typeof transitionIssue>[5], env = t.env) {
	return transitionIssue(t.db, env, actor, TEST_NOOP_DISPATCH_EFFECTS, id, body);
}

function seed(state = OPEN) {
	const t = createTestDb();
	seedBase(t);
	return { t, id: addIssue(t, { title: 'Pinned', state }) };
}

describe('transitionIssue pins the state visit and workflow graph', () => {
	it('exposes the witness on ordinary detail reads and keeps it off list items', async () => {
		const { t, id } = seed();
		const before = await getIssueDetail(t.db, USER, { id });
		expect(before.decision_revision).toBe(issueById(t, id).decision_revision);
		expect(before.workflow_revision).toBe(
			t.all("SELECT decision_revision AS r FROM workflow WHERE id = 'wf_standard'")[0].r
		);
		const after = await move(t, id, { action: 'Submit for review' });
		expect(after.decision_revision).toBe(before.decision_revision + 1);
		expect(after.workflow_revision).toBe(before.workflow_revision);
		const [item] = (
			await listIssues(t.db, USER, { projectId: PROJECT }, { cursor: null, limit: 50 })
		).items;
		expect(item).not.toHaveProperty('decision_revision');
		expect(item).not.toHaveProperty('workflow_revision');
	});

	it('reads the workflow graph revision after a graph-changing save', async () => {
		const { t, id } = seed();
		t.sqlite.exec(`UPDATE workflow SET user_id = '${USER}' WHERE id = 'wf_standard'`);
		await updateWorkflow(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, 'wf_standard', {
			transitions: [
				{ name: 'Submit for review', from: 'Open', to: 'Human Review' },
				{ name: 'Send back', from: 'Human Review', to: 'Open' },
				{ name: 'Approve', from: 'Human Review', to: 'Closed' }
			]
		});
		const stored = t.all("SELECT decision_revision AS r FROM workflow WHERE id = 'wf_standard'")[0]
			.r as number;
		expect(stored).toBeGreaterThan(0);
		// A fixture workflow sits at 0, which a constant would also satisfy.
		expect((await getIssueDetail(t.db, USER, { id })).workflow_revision).toBe(stored);
		// The move's own response is the witness for the next move.
		expect((await move(t, id, { action: 'Submit for review' })).workflow_revision).toBe(stored);
	});

	it('refuses a delayed approve after another approve and send back (502 reproduction 1)', async () => {
		const { t, id } = seed(REVIEW);
		const effects = recordDispatchEffects();
		// The competing round: send back, then submit again. The issue is in
		// Human Review once more, on a later visit.
		const env = beforeBatch(t, async () => {
			await move(t, id, { action: 'Send back' });
			await move(t, id, { action: 'Submit for review' });
		});
		const eventsBefore = eventsOfType(t, 'issue.transitioned').length;

		await expect(
			transitionIssue(t.db, env, actor, effects, id, { action: 'Approve' })
		).rejects.toMatchObject({
			status: 409,
			code: 'conflict',
			details: { reason: 'issue_moved', current_state: { id: REVIEW } }
		});
		expect(issueById(t, id).state_id).toBe(REVIEW);
		// Only the two competing moves recorded an event; the refused one did not.
		expect(eventsOfType(t, 'issue.transitioned').length).toBe(eventsBefore + 2);
		expect(effects.count()).toBe(0);
	});

	it('refuses a round-one transition id sent with its witness in round two (502 reproduction 3)', async () => {
		const { t, id } = seed(REVIEW);
		const roundOne = await getIssueDetail(t.db, USER, { id });
		await move(t, id, { action: 'Send back' });
		await move(t, id, { action: 'Submit for review' });

		await expect(
			move(t, id, {
				transition_id: APPROVE,
				expected_state_id: roundOne.state.id,
				expected_decision_revision: roundOne.decision_revision,
				expected_workflow_revision: roundOne.workflow_revision
			})
		).rejects.toMatchObject({
			status: 409,
			code: 'decision_refresh_required',
			details: {
				committed: false,
				reason: 'issue_moved',
				current_decision_revision: roundOne.decision_revision + 2
			}
		});
		expect(issueById(t, id).state_id).toBe(REVIEW);

		// The same request with the current witness commits.
		const roundTwo = await getIssueDetail(t.db, USER, { id });
		const moved = await move(t, id, {
			transition_id: APPROVE,
			expected_state_id: roundTwo.state.id,
			expected_decision_revision: roundTwo.decision_revision,
			expected_workflow_revision: roundTwo.workflow_revision
		});
		expect(moved.state.id).toBe(CLOSED);
	});

	it('refuses after a leave and return inside the same millisecond', async () => {
		const { t, id } = seed(REVIEW);
		const frozen = Date.now();
		const realNow = Date.now;
		Date.now = () => frozen;
		try {
			const env = beforeBatch(t, async () => {
				await move(t, id, { action: 'Send back' });
				await move(t, id, { action: 'Submit for review' });
			});
			await expect(move(t, id, { action: 'Approve' }, env)).rejects.toMatchObject({
				status: 409,
				details: { reason: 'issue_moved' }
			});
		} finally {
			Date.now = realNow;
		}
		expect(issueById(t, id).state_id).toBe(REVIEW);
		// Two events, both from the competing moves: the same-millisecond guard
		// that matched (issue, state, updated_at) is gone.
		const approvals = eventsOfType(t, 'issue.transitioned').filter(
			(e) => (e.payload as { transition_id: string }).transition_id === APPROVE
		);
		expect(approvals).toHaveLength(0);
	});

	it('refuses after a forced state change through updateIssue', async () => {
		const { t, id } = seed(REVIEW);
		const env = beforeBatch(t, async () => {
			await updateIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, id, { state: OPEN });
			await updateIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, id, { state: REVIEW });
		});
		await expect(move(t, id, { action: 'Approve' }, env)).rejects.toMatchObject({
			status: 409,
			code: 'conflict',
			details: { reason: 'issue_moved' }
		});
		expect(issueById(t, id).state_id).toBe(REVIEW);
	});

	it('refuses after the workflow graph changed, and says so', async () => {
		const { t, id } = seed(REVIEW);
		t.sqlite.exec(`UPDATE workflow SET user_id = '${USER}' WHERE id = 'wf_standard'`);
		const env = beforeBatch(t, async () => {
			// Dropping "Abandon" is a semantic graph save: the graph revision
			// advances and every transition id is reissued.
			await updateWorkflow(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, 'wf_standard', {
				transitions: [
					{ name: 'Submit for review', from: 'Open', to: 'Human Review' },
					{ name: 'Send back', from: 'Human Review', to: 'Open' },
					{ name: 'Approve', from: 'Human Review', to: 'Closed' }
				]
			});
		});
		await expect(move(t, id, { action: 'Approve' }, env)).rejects.toMatchObject({
			status: 409,
			code: 'conflict',
			details: { reason: 'workflow_changed' }
		});
		expect(issueById(t, id).state_id).toBe(REVIEW);
	});

	it('refuses on the graph revision alone, when the transition id survived the save', async () => {
		// Today a graph save reissues every transition id, so the transition-id
		// check refuses it first. This holds the graph pin on its own: the
		// revision advances and the transition row is untouched.
		const { t, id } = seed(REVIEW);
		const env = beforeBatch(t, async () => {
			t.sqlite.exec(
				"UPDATE workflow SET decision_revision = decision_revision + 1 WHERE id = 'wf_standard'"
			);
		});
		const eventsBefore = eventsOfType(t, 'issue.transitioned').length;
		await expect(move(t, id, { transition_id: APPROVE }, env)).rejects.toMatchObject({
			status: 409,
			code: 'conflict',
			details: { reason: 'workflow_changed' }
		});
		expect(issueById(t, id).state_id).toBe(REVIEW);
		expect(eventsOfType(t, 'issue.transitioned')).toHaveLength(eventsBefore);
	});

	it('records one event when two moves to the same state land in one millisecond', async () => {
		const { t, id } = seed(REVIEW);
		const frozen = Date.now();
		const realNow = Date.now;
		Date.now = () => frozen;
		try {
			// The competing Approve commits first, in the same millisecond. The
			// issue is then in the delayed request's target state with its
			// timestamp, which is all the old (issue, state, updated_at) guard asked.
			const env = beforeBatch(t, () => move(t, id, { action: 'Approve' }));
			await expect(move(t, id, { action: 'Approve' }, env)).rejects.toMatchObject({
				status: 409,
				code: 'conflict',
				details: { reason: 'issue_moved', current_state: { id: CLOSED } }
			});
		} finally {
			Date.now = realNow;
		}
		expect(issueById(t, id).updated_at).toBe(frozen);
		const approvals = eventsOfType(t, 'issue.transitioned').filter(
			(e) => (e.payload as { transition_id: string }).transition_id === APPROVE
		);
		expect(approvals).toHaveLength(1);
	});

	it('refuses a stale workflow witness before any write', async () => {
		const { t, id } = seed();
		const read = await getIssueDetail(t.db, USER, { id });
		await expect(
			move(t, id, {
				transition_id: SUBMIT,
				expected_workflow_revision: read.workflow_revision + 1
			})
		).rejects.toMatchObject({
			status: 409,
			code: 'decision_refresh_required',
			details: { reason: 'workflow_changed', current_workflow_revision: read.workflow_revision }
		});
		expect(issueById(t, id).state_id).toBe(OPEN);
	});

	it('honors a stale witness from a run key', async () => {
		const { t, id } = seed();
		const runner = addRunner(t);
		const run = addRun(t, { issueId: id, runnerId: runner, status: 'running' });
		const keyId = addRunKey(t, run);
		const runActor: ActorContext = {
			userId: USER,
			userName: 'alice',
			apiKeyId: keyId,
			apiKeyName: `run ${run}`,
			viaSession: false,
			permissions: FULL_API_KEY_PERMISSIONS,
			agentRunId: run,
			runRestriction: {
				policy: 'run-v1',
				runId: run,
				issueId: id,
				projectId: PROJECT,
				launchStateId: OPEN
			}
		};
		const read = await getIssueDetail(t.db, USER, { id });
		await expect(
			transitionIssue(t.db, t.env, runActor, TEST_NOOP_DISPATCH_EFFECTS, id, {
				action: 'Submit for review',
				expected_decision_revision: read.decision_revision - 1
			})
		).rejects.toMatchObject({ status: 409, code: 'decision_refresh_required' });
		expect(issueById(t, id).state_id).toBe(OPEN);

		// Without a witness, and with the current one, the run key still moves it.
		const moved = await transitionIssue(t.db, t.env, runActor, TEST_NOOP_DISPATCH_EFFECTS, id, {
			action: 'Submit for review',
			expected_decision_revision: read.decision_revision
		});
		expect(moved.state.id).toBe(REVIEW);
	});

	it('records exactly one event for a committed move and stamps the decision token', async () => {
		const { t, id } = seed();
		await move(t, id, { action: 'Submit for review' });
		expect(eventsOfType(t, 'issue.transitioned')).toHaveLength(1);
		expect(issueById(t, id).last_decision_token).toMatch(/^dcn_/);
	});
});
