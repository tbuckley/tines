import { beforeEach, describe, expect, it } from 'vitest';
import {
	NOW,
	OPEN,
	PROJECT,
	USER,
	addIssue,
	addRun,
	addRunner,
	seedBase
} from '../supervisor/test-fixtures';
import { claimRun } from '../supervisor/engine';
import type { ActorContext } from './core';
import { commitIssueTransfer, previewIssueTransfer } from './issue-transfer';
import { loadIssue } from './issues';
import { createTestDb, type TestDb } from './test-db';

const DESTINATION = 'prj_destination';
const actor: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

const claimInput = (
	t: TestDb,
	issueId: string,
	runnerId: string,
	projectId: string,
	projectAssignmentToken: string
) => ({
	runId: `arun_${Math.random().toString(36).slice(2)}`,
	userId: USER,
	issueId,
	projectId,
	stateId: OPEN,
	runnerId,
	maxConcurrent: 5,
	tier: 'balanced' as const,
	model: null,
	quota: { type: 'global_cap' as const, limit: 10 },
	now: NOW,
	projectAssignmentToken
});

describe('private issue transfer path', () => {
	let t: TestDb;
	let issueId: string;

	beforeEach(() => {
		t = createTestDb();
		t.env.BETTER_AUTH_SECRET = 'transfer-test-secret';
		seedBase(t);
		t.sqlite.exec(`
			INSERT INTO project (id, user_id, name, created_at, updated_at)
			VALUES ('${DESTINATION}', '${USER}', 'destination', ${NOW}, ${NOW});
		`);
		issueId = addIssue(t, {
			id: 'iss_transfer',
			title: 'Keep this record',
			description: 'Every owned field survives',
			attemptCount: 2,
			needsAttention: true,
			updatedAt: NOW + 4,
			stateEnteredAt: NOW - 10
		});
		addIssue(t, { id: 'iss_destination_occupied', project: DESTINATION });
		t.sqlite.exec(`
			INSERT INTO comment (id, issue_id, body, actor_user_id, created_at)
			VALUES ('cmt_transfer', '${issueId}', 'still here', '${USER}', ${NOW});
			INSERT INTO context_item (
				id, user_id, kind, name, description, project_id, issue_id, body,
				position, version, created_at, updated_at
			) VALUES (
				'ctx_transfer', '${USER}', 'prompt', 'issue directions', '', '${PROJECT}',
				'${issueId}', 'preserve me', 3, 7, ${NOW}, ${NOW}
			);
		`);
	});

	it('previews without allocating, commits atomically, and resolves both addresses', async () => {
		const beforeIssue = t.all(`SELECT * FROM issue WHERE id = ?`, issueId)[0];
		const beforeContext = t.all(`SELECT * FROM context_item WHERE id = 'ctx_transfer'`)[0];
		const beforeAddresses = t.all(`SELECT * FROM issue_address`).length;

		const preview = await previewIssueTransfer(t.env, actor, issueId, DESTINATION, NOW + 100);

		expect(preview).toMatchObject({
			issueId,
			oldRef: `demo/${beforeIssue.number}`,
			noop: false,
			canCommit: true,
			blockers: []
		});
		expect(preview.previewToken).toEqual(expect.any(String));
		expect(t.all(`SELECT * FROM issue_address`)).toHaveLength(beforeAddresses);

		const result = await commitIssueTransfer(
			t.env,
			actor,
			issueId,
			DESTINATION,
			preview.previewToken!,
			NOW + 200
		);
		const afterIssue = t.all(`SELECT * FROM issue WHERE id = ?`, issueId)[0];
		const afterContext = t.all(`SELECT * FROM context_item WHERE id = 'ctx_transfer'`)[0];

		expect(result).toMatchObject({
			status: 'transferred',
			issueId,
			oldRef: `demo/${beforeIssue.number}`,
			newRef: `destination/${afterIssue.number}`
		});
		expect(result.eventId).toEqual(expect.any(String));
		expect(
			await loadIssue(t.db, USER, { projectName: 'demo', number: Number(beforeIssue.number) })
		).toMatchObject({ id: issueId, project_id: DESTINATION, number: afterIssue.number });
		expect(
			await loadIssue(t.db, USER, {
				projectName: 'destination',
				number: Number(afterIssue.number)
			})
		).toMatchObject({ id: issueId, project_id: DESTINATION });

		for (const field of [
			'id',
			'title',
			'description',
			'workflow_id',
			'state_id',
			'scheduled_task_id',
			'pinned_runner_id',
			'pinned_tier',
			'attempt_count',
			'needs_attention',
			'state_entered_at',
			'created_at'
		]) {
			expect(afterIssue[field]).toEqual(beforeIssue[field]);
		}
		expect(afterContext).toEqual({ ...beforeContext, project_id: DESTINATION });
		expect(t.all(`SELECT * FROM comment WHERE issue_id = ?`, issueId)).toHaveLength(1);
		expect(t.all(`SELECT * FROM issue_address WHERE issue_id = ?`, issueId)).toHaveLength(2);
		const events = t.all(
			`SELECT * FROM event WHERE issue_id = ? AND type = 'issue.transferred'`,
			issueId
		);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			id: result.eventId,
			project_id: DESTINATION,
			created_at: NOW + 200
		});
		expect(JSON.parse(String(events[0].payload))).toMatchObject({
			source_project_id: PROJECT,
			destination_project_id: DESTINATION,
			old_ref: result.oldRef,
			new_ref: result.newRef
		});
	});

	it('returns an unchanged same-project no-op with no allocation or event', async () => {
		const before = t.all(`SELECT * FROM issue WHERE id = ?`, issueId)[0];
		const addresses = t.all(`SELECT * FROM issue_address`).length;
		const preview = await previewIssueTransfer(t.env, actor, issueId, PROJECT, NOW + 100);
		expect(preview).toMatchObject({ noop: true, canCommit: true });

		const result = await commitIssueTransfer(
			t.env,
			actor,
			issueId,
			PROJECT,
			preview.previewToken!,
			NOW + 200
		);

		expect(result).toEqual({
			status: 'noop',
			issueId,
			oldRef: `demo/${before.number}`,
			newRef: `demo/${before.number}`,
			eventId: null
		});
		expect(t.all(`SELECT * FROM issue WHERE id = ?`, issueId)[0]).toEqual(before);
		expect(t.all(`SELECT * FROM issue_address`)).toHaveLength(addresses);
		expect(t.all(`SELECT * FROM event WHERE type = 'issue.transferred'`)).toHaveLength(0);
	});

	it('lets run keys preview the blocker but never commit', async () => {
		const runActor = { ...actor, viaSession: false, agentRunId: 'arun_self' };
		const preview = await previewIssueTransfer(t.env, runActor, issueId, DESTINATION, NOW);
		expect(preview).toMatchObject({
			canCommit: false,
			previewToken: null,
			blockers: [{ code: 'run_key_forbidden' }]
		});
		await expect(
			commitIssueTransfer(t.env, runActor, issueId, DESTINATION, 'anything', NOW)
		).rejects.toMatchObject({ status: 403, code: 'run_key_forbidden' });
	});

	it('does not reveal unknown or foreign destinations', async () => {
		await expect(
			previewIssueTransfer(t.env, actor, issueId, 'prj_missing', NOW)
		).rejects.toMatchObject({ status: 404, code: 'not_found' });
		t.sqlite.exec(`
			INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
			VALUES ('u2', 'bob', 'b@example.com', 1, ${NOW}, ${NOW});
			INSERT INTO project (id, user_id, name, created_at, updated_at)
			VALUES ('prj_foreign', 'u2', 'foreign', ${NOW}, ${NOW});
		`);
		await expect(
			previewIssueTransfer(t.env, actor, issueId, 'prj_foreign', NOW)
		).rejects.toMatchObject({ status: 404, code: 'not_found' });
	});

	it.each([
		['source', PROJECT],
		['destination', DESTINATION]
	])('blocks an archived %s project without writes', async (_which, projectId) => {
		t.sqlite.exec(`UPDATE project SET archived_at = ${NOW} WHERE id = '${projectId}'`);
		const preview = await previewIssueTransfer(t.env, actor, issueId, DESTINATION, NOW);
		expect(preview).toMatchObject({
			canCommit: false,
			previewToken: null,
			blockers: [{ code: 'project_archived' }]
		});
		expect(t.all(`SELECT * FROM event WHERE type = 'issue.transferred'`)).toHaveLength(0);
	});

	it.each(['assigned', 'launching', 'running'])(
		'blocks %s work and never cancels it',
		async (status) => {
			const runnerId = addRunner(t);
			const preview = await previewIssueTransfer(t.env, actor, issueId, DESTINATION, NOW);
			addRun(t, { id: `arun_${status}`, issueId, runnerId, status });
			await expect(
				commitIssueTransfer(t.env, actor, issueId, DESTINATION, preview.previewToken!, NOW + 1)
			).rejects.toMatchObject({ status: 409, code: 'issue_busy' });
			expect(t.all(`SELECT status FROM agent_run WHERE id = ?`, `arun_${status}`)[0]).toEqual({
				status
			});
			expect(t.all(`SELECT project_id FROM issue WHERE id = ?`, issueId)[0]).toEqual({
				project_id: PROJECT
			});
		}
	);

	it('rejects tampered, expired, and stale previews without partial writes', async () => {
		const preview = await previewIssueTransfer(t.env, actor, issueId, DESTINATION, NOW);
		const token = preview.previewToken!;
		const tokenParts = token.split('.');
		tokenParts[2] = `${tokenParts[2][0] === 'A' ? 'B' : 'A'}${tokenParts[2].slice(1)}`;
		const tampered = tokenParts.join('.');
		await expect(
			commitIssueTransfer(t.env, actor, issueId, DESTINATION, tampered, NOW + 1)
		).rejects.toMatchObject({ status: 422, code: 'invalid_preview_token' });
		await expect(
			commitIssueTransfer(t.env, actor, issueId, DESTINATION, token, NOW + 15 * 60_000)
		).rejects.toMatchObject({ status: 409, code: 'transfer_preview_stale' });

		t.sqlite.exec(`UPDATE issue SET title = 'changed after preview' WHERE id = '${issueId}'`);
		await expect(
			commitIssueTransfer(t.env, actor, issueId, DESTINATION, token, NOW + 1)
		).rejects.toMatchObject({ status: 409, code: 'transfer_preview_stale' });
		expect(t.all(`SELECT project_id FROM issue WHERE id = ?`, issueId)[0]).toEqual({
			project_id: PROJECT
		});
		expect(t.all(`SELECT * FROM event WHERE type = 'issue.transferred'`)).toHaveLength(0);
	});

	it('rejects replay after A to B to A, so ABA cannot revive an old confirmation', async () => {
		const first = await previewIssueTransfer(t.env, actor, issueId, DESTINATION, NOW);
		await commitIssueTransfer(t.env, actor, issueId, DESTINATION, first.previewToken!, NOW + 1);
		const back = await previewIssueTransfer(t.env, actor, issueId, PROJECT, NOW + 2);
		await commitIssueTransfer(t.env, actor, issueId, PROJECT, back.previewToken!, NOW + 3);

		await expect(
			commitIssueTransfer(t.env, actor, issueId, DESTINATION, first.previewToken!, NOW + 4)
		).rejects.toMatchObject({ status: 409, code: 'transfer_conflict' });
		expect(t.all(`SELECT * FROM event WHERE type = 'issue.transferred'`)).toHaveLength(2);
	});

	it('serializes claim and move: a winning claim blocks transfer without cancellation', async () => {
		t.sqlite.exec(`UPDATE issue SET needs_attention = 0 WHERE id = '${issueId}'`);
		const preview = await previewIssueTransfer(t.env, actor, issueId, DESTINATION, NOW);
		const runnerId = addRunner(t);
		const issue = t.all(
			`SELECT project_id, project_assignment_token FROM issue WHERE id = ?`,
			issueId
		)[0];
		expect(
			await claimRun(
				t.db,
				t.env,
				claimInput(
					t,
					issueId,
					runnerId,
					String(issue.project_id),
					String(issue.project_assignment_token)
				)
			)
		).toBe(true);

		await expect(
			commitIssueTransfer(t.env, actor, issueId, DESTINATION, preview.previewToken!, NOW + 1)
		).rejects.toMatchObject({ status: 409, code: 'issue_busy' });
		expect(t.all(`SELECT status FROM agent_run WHERE issue_id = ?`, issueId)).toEqual([
			{ status: 'assigned' }
		]);
		expect(t.all(`SELECT project_id FROM issue WHERE id = ?`, issueId)[0].project_id).toBe(PROJECT);
	});

	it('serializes move and claim: stale source and ABA candidates lose, a fresh candidate wins', async () => {
		t.sqlite.exec(`UPDATE issue SET needs_attention = 0 WHERE id = '${issueId}'`);
		const runnerId = addRunner(t);
		const source = t.all(
			`SELECT project_id, project_assignment_token FROM issue WHERE id = ?`,
			issueId
		)[0];
		const staleSourceClaim = claimInput(
			t,
			issueId,
			runnerId,
			String(source.project_id),
			String(source.project_assignment_token)
		);
		const toDestination = await previewIssueTransfer(t.env, actor, issueId, DESTINATION, NOW);
		await commitIssueTransfer(
			t.env,
			actor,
			issueId,
			DESTINATION,
			toDestination.previewToken!,
			NOW + 1
		);
		expect(await claimRun(t.db, t.env, staleSourceClaim)).toBe(false);

		const back = await previewIssueTransfer(t.env, actor, issueId, PROJECT, NOW + 2);
		await commitIssueTransfer(t.env, actor, issueId, PROJECT, back.previewToken!, NOW + 3);
		expect(await claimRun(t.db, t.env, staleSourceClaim)).toBe(false);

		const current = t.all(
			`SELECT project_id, project_assignment_token FROM issue WHERE id = ?`,
			issueId
		)[0];
		expect(
			await claimRun(
				t.db,
				t.env,
				claimInput(
					t,
					issueId,
					runnerId,
					String(current.project_id),
					String(current.project_assignment_token)
				)
			)
		).toBe(true);
	});

	it.each([
		[
			'context rescope',
			`CREATE TRIGGER fail_transfer BEFORE UPDATE OF project_id ON context_item BEGIN SELECT RAISE(ABORT, 'injected rescope failure'); END`
		],
		[
			'event insertion',
			`CREATE TRIGGER fail_transfer BEFORE INSERT ON event WHEN NEW.type = 'issue.transferred' BEGIN SELECT RAISE(ABORT, 'injected event failure'); END`
		]
	])('rolls back every transfer write after an injected %s failure', async (_stage, trigger) => {
		const preview = await previewIssueTransfer(t.env, actor, issueId, DESTINATION, NOW);
		const before = {
			issue: t.all(`SELECT * FROM issue WHERE id = ?`, issueId),
			addresses: t.all(`SELECT * FROM issue_address WHERE issue_id = ?`, issueId),
			context: t.all(`SELECT * FROM context_item WHERE issue_id = ?`, issueId),
			events: t.all(`SELECT * FROM event WHERE issue_id = ?`, issueId)
		};
		t.sqlite.exec(trigger);

		await expect(
			commitIssueTransfer(t.env, actor, issueId, DESTINATION, preview.previewToken!, NOW + 1)
		).rejects.toThrow(/injected/);
		expect(t.all(`SELECT * FROM issue WHERE id = ?`, issueId)).toEqual(before.issue);
		expect(t.all(`SELECT * FROM issue_address WHERE issue_id = ?`, issueId)).toEqual(
			before.addresses
		);
		expect(t.all(`SELECT * FROM context_item WHERE issue_id = ?`, issueId)).toEqual(before.context);
		expect(t.all(`SELECT * FROM event WHERE issue_id = ?`, issueId)).toEqual(before.events);
	});

	it('does not enqueue when the guarded update loses, but enqueue failure cannot undo a move', async () => {
		const stale = await previewIssueTransfer(t.env, actor, issueId, DESTINATION, NOW);
		const realBatch = t.env.DB.batch.bind(t.env.DB);
		let first = true;
		t.env.DB.batch = async (statements) => {
			if (first) {
				first = false;
				t.sqlite.exec(`UPDATE issue SET title = 'raced' WHERE id = '${issueId}'`);
			}
			return realBatch(statements);
		};
		const waits: Promise<unknown>[] = [];
		await expect(
			commitIssueTransfer(t.env, actor, issueId, DESTINATION, stale.previewToken!, NOW + 1, {
				env: t.env,
				ctx: { waitUntil: (promise) => waits.push(promise) }
			})
		).rejects.toMatchObject({ status: 409, code: 'transfer_preview_stale' });
		expect(waits).toHaveLength(0);

		const fresh = await previewIssueTransfer(t.env, actor, issueId, DESTINATION, NOW + 2);
		const result = await commitIssueTransfer(
			t.env,
			actor,
			issueId,
			DESTINATION,
			fresh.previewToken!,
			NOW + 3,
			{
				env: { DB: null } as unknown as Env,
				ctx: { waitUntil: (promise) => waits.push(promise) }
			}
		);
		expect(result.status).toBe('transferred');
		expect(t.all(`SELECT project_id FROM issue WHERE id = ?`, issueId)[0].project_id).toBe(
			DESTINATION
		);
	});
});
