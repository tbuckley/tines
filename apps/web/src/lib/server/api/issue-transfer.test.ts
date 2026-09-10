import { beforeEach, describe, expect, it } from 'vitest';
import { NOW, PROJECT, USER, addIssue, seedBase } from '../supervisor/test-fixtures';
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
});
