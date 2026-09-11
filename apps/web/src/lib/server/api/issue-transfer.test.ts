import { beforeEach, describe, expect, it } from 'vitest';
import {
	NOW,
	OPEN,
	PROJECT,
	USER,
	addIssue,
	addRule,
	addRun,
	addRunner,
	seedBase,
	setSettings
} from '../supervisor/test-fixtures';
import { claimRun, queueDispatchPass } from '../supervisor/engine';
import type { ActorContext } from './core';
import { commitIssueTransfer, previewIssueTransfer } from './issue-transfer';
import { loadIssue } from './issues';
import { effectiveContextForIssue } from './context';
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

	it('stales a preview when destination guidance or a label changes under it', async () => {
		const preview = await previewIssueTransfer(t.env, actor, issueId, DESTINATION, NOW + 100);
		// A prompt added at the destination after the review changes what the
		// operator approved, even though it touches neither the issue nor the
		// rows the move rescopes.
		t.sqlite.exec(`
			INSERT INTO context_item (
				id, user_id, kind, name, description, project_id, body,
				position, version, created_at, updated_at
			) VALUES ('ctx_late', '${USER}', 'prompt', 'late', '', '${DESTINATION}',
				'arrived after the review', 1, 1, ${NOW}, ${NOW});
		`);
		await expect(
			commitIssueTransfer(t.env, actor, issueId, DESTINATION, preview.preview_token!, NOW + 200)
		).rejects.toMatchObject({ code: 'transfer_preview_stale' });
		expect(t.all(`SELECT * FROM event WHERE type = 'issue.transferred'`)).toHaveLength(0);

		// Labels feed context and routing matching, so they are witnessed too.
		t.sqlite.exec(`DELETE FROM context_item WHERE id = 'ctx_late'`);
		const fresh = await previewIssueTransfer(t.env, actor, issueId, DESTINATION, NOW + 300);
		t.sqlite.exec(`
			INSERT INTO label (id, user_id, name, color, created_at, updated_at)
			VALUES ('lbl_late', '${USER}', 'urgent', 'red', ${NOW}, ${NOW});
			INSERT INTO issue_label (issue_id, label_id, created_at)
			VALUES ('${issueId}', 'lbl_late', ${NOW});
		`);
		await expect(
			commitIssueTransfer(t.env, actor, issueId, DESTINATION, fresh.preview_token!, NOW + 400)
		).rejects.toMatchObject({ code: 'transfer_preview_stale' });

		// Names are displayed in the preservation review, not merely their IDs.
		const named = await previewIssueTransfer(t.env, actor, issueId, DESTINATION, NOW + 500);
		t.sqlite.exec(`UPDATE label SET name = 'renamed' WHERE id = 'lbl_late'`);
		await expect(
			commitIssueTransfer(t.env, actor, issueId, DESTINATION, named.preview_token!, NOW + 501)
		).rejects.toMatchObject({ code: 'transfer_preview_stale' });
	});

	it('stales rendered workflow inheritance and relationship readiness', async () => {
		const inheritance = await previewIssueTransfer(t.env, actor, issueId, DESTINATION, NOW);
		t.sqlite.exec(`UPDATE workflow_state SET name = 'Renamed state' WHERE id = '${OPEN}'`);
		await expect(
			commitIssueTransfer(t.env, actor, issueId, DESTINATION, inheritance.preview_token!, NOW + 1)
		).rejects.toMatchObject({ code: 'transfer_preview_stale' });

		const other = addIssue(t, { id: 'iss_linked' });
		const readiness = await previewIssueTransfer(t.env, actor, issueId, DESTINATION, NOW + 2);
		t.sqlite.exec(`
			INSERT INTO issue_link (id, source_issue_id, target_issue_id, kind, created_at)
			VALUES ('lnk_late', '${other}', '${issueId}', 'blocks', ${NOW})
		`);
		await expect(
			commitIssueTransfer(t.env, actor, issueId, DESTINATION, readiness.preview_token!, NOW + 3)
		).rejects.toMatchObject({ code: 'transfer_preview_stale' });

		const linkedState = await previewIssueTransfer(t.env, actor, issueId, DESTINATION, NOW + 4);
		t.sqlite.exec(
			`UPDATE issue SET state_id = 'wfs_std_closed', updated_at = ${NOW + 5} WHERE id = '${other}'`
		);
		await expect(
			commitIssueTransfer(t.env, actor, issueId, DESTINATION, linkedState.preview_token!, NOW + 5)
		).rejects.toMatchObject({ code: 'transfer_preview_stale' });

		const artifact = await previewIssueTransfer(t.env, actor, issueId, DESTINATION, NOW + 6);
		t.sqlite.exec(`
			INSERT INTO context_item (id, user_id, kind, name, description, issue_id, body,
				position, version, config, created_at, updated_at)
			VALUES ('ctx_gate', '${USER}', 'artifact', 'gate', '', '${issueId}', '', 0, 1,
				'{"artifact_type":"text"}', ${NOW}, ${NOW});
			INSERT INTO artifact_version (id, context_item_id, version, content, content_type,
				size_bytes, actor_user_id, created_at)
			VALUES ('av_gate', 'ctx_gate', 1, 'ready', 'text/markdown', 5, '${USER}', ${NOW});
		`);
		await expect(
			commitIssueTransfer(t.env, actor, issueId, DESTINATION, artifact.preview_token!, NOW + 7)
		).rejects.toMatchObject({ code: 'transfer_preview_stale' });
	});

	it('stales a preview on a structural routing change but not on liveness alone', async () => {
		const runnerId = addRunner(t, { id: 'rnr_route' });
		setSettings(t);
		const stale = await previewIssueTransfer(t.env, actor, issueId, DESTINATION, NOW);
		// A rule that newly targets the destination changes where the next
		// launch would go, so the operator's approved routing is no longer what
		// would happen.
		t.sqlite.exec(`
			INSERT INTO routing_rule (id, user_id, project_id, workflow_state_id, label_id,
				targets, created_at, updated_at)
			VALUES ('rrl_late', '${USER}', '${DESTINATION}', NULL, NULL,
				'[{"runner_id":"${runnerId}"}]', ${NOW}, ${NOW});
		`);
		await expect(
			commitIssueTransfer(t.env, actor, issueId, DESTINATION, stale.preview_token!, NOW + 1)
		).rejects.toMatchObject({ code: 'transfer_preview_stale' });
		expect(t.all(`SELECT * FROM event WHERE type = 'issue.transferred'`)).toHaveLength(0);

		// So does pausing the runner the route resolves to, and so does the
		// dispatch quota the explanation reports.
		for (const change of [
			`UPDATE runner SET status = 'paused' WHERE id = '${runnerId}'`,
			`UPDATE supervisor_settings SET quota = '{"type":"global_cap","limit":1}' WHERE user_id = '${USER}'`
		]) {
			const fresh = await previewIssueTransfer(t.env, actor, issueId, DESTINATION, NOW + 10);
			t.sqlite.exec(change);
			await expect(
				commitIssueTransfer(t.env, actor, issueId, DESTINATION, fresh.preview_token!, NOW + 11)
			).rejects.toMatchObject({ code: 'transfer_preview_stale' });
		}

		// Liveness and capacity move on their own between a review and a
		// confirm; the preview labels them advisory, so witnessing them would
		// refuse an honest transfer for a heartbeat.
		const live = await previewIssueTransfer(t.env, actor, issueId, DESTINATION, NOW + 20);
		t.sqlite.exec(`
			UPDATE runner SET last_seen_at = ${NOW + 21}, launch_failures = 3,
				backoff_until = ${NOW + 900}, backoff_reason = 'rate_limit', draining = 1,
				config = '{"hostname":"moved"}'
			WHERE id = '${runnerId}';
		`);
		const result = await commitIssueTransfer(
			t.env,
			actor,
			issueId,
			DESTINATION,
			live.preview_token!,
			NOW + 22
		);
		expect(result.status).toBe('transferred');
		expect(result).toMatchObject({
			preserved: live.preserved,
			context_changes: live.context.changes,
			routing: live.routing,
			schedule: live.schedule
		});
	});

	it('projects guidance and repositories at the destination, and agrees after the move', async () => {
		// Shared source guidance the issue loses, destination guidance it gains,
		// a repo whose checkout changes hands, and its own anchored prompt, which
		// travels with it.
		t.sqlite.exec(`
			INSERT INTO context_item (
				id, user_id, kind, name, description, project_id, body, repo_url, repo_dir,
				position, version, created_at, updated_at
			) VALUES
				('ctx_src_shared', '${USER}', 'prompt', 'house-style', '', '${PROJECT}',
					'Source house style', NULL, NULL, 1, 1, ${NOW}, ${NOW}),
				('ctx_dst_shared', '${USER}', 'prompt', 'house-style', '', '${DESTINATION}',
					'Destination house style', NULL, NULL, 1, 1, ${NOW}, ${NOW}),
				('ctx_src_repo', '${USER}', 'repo', 'app', '', '${PROJECT}',
					NULL, 'https://example.test/source.git', 'app', 1, 1, ${NOW}, ${NOW}),
				('ctx_dst_repo', '${USER}', 'repo', 'app', '', '${DESTINATION}',
					NULL, 'https://example.test/destination.git', 'app', 1, 1, ${NOW}, ${NOW}),
				('ctx_issue_repo', '${USER}', 'repo', 'app', '', NULL,
					NULL, 'https://example.test/issue-override.git', 'app', 2, 1, ${NOW}, ${NOW});
		`);
		t.sqlite.exec(`
			UPDATE context_item SET issue_id = '${issueId}', repo_branch = 'research'
			WHERE id = 'ctx_issue_repo'
		`);

		const preview = await previewIssueTransfer(t.env, actor, issueId, DESTINATION, NOW + 100);
		const change = (id: string) => preview.context.changes.find((c) => c.item_id === id);
		expect(change('ctx_src_shared')?.change).toBe('removed');
		expect(change('ctx_dst_shared')?.change).toBe('added');
		expect(change('ctx_issue_repo')).toMatchObject({
			change: 'retained',
			effective_before: true,
			effective_after: true,
			repo_before: { url: 'https://example.test/issue-override.git', branch: 'research' }
		});
		expect(preview.context.before.repos[0].item_id).toBe('ctx_issue_repo');
		expect(preview.context.after.repos[0].item_id).toBe('ctx_issue_repo');
		expect(
			preview.context.before.overridden.find((r) => r.item_id === 'ctx_src_repo')
		).toMatchObject({
			repo: { url: 'https://example.test/source.git', dir: 'app' }
		});
		expect(
			preview.context.after.overridden.find((r) => r.item_id === 'ctx_dst_repo')
		).toMatchObject({
			repo: { url: 'https://example.test/destination.git', dir: 'app' }
		});
		// The issue's own anchored prompt moves with it: same item, new project.
		expect(change('ctx_transfer')).toMatchObject({
			change: 'rescoped',
			scope_before: { project_id: PROJECT },
			scope_after: { project_id: DESTINATION }
		});
		expect(preview.context.after.prompt.text).toContain('Destination house style');
		expect(preview.context.after.prompt.text).not.toContain('Source house style');
		expect(preview.context.after.prompt.text).toContain('preserve me');

		await commitIssueTransfer(
			t.env,
			actor,
			issueId,
			DESTINATION,
			preview.preview_token!,
			NOW + 200
		);

		// The promise the preview made: the ordinary resolver now says the same,
		// once the address the preview could not know yet is normalized away.
		const moved = t.all(`SELECT number FROM issue WHERE id = ?`, issueId)[0];
		const actual = await effectiveContextForIssue(t.db, USER, issueId);
		expect(actual.prompt.text.replace(`destination/${moved.number}`, preview.old_ref.ref)).toBe(
			preview.context.after.prompt.text
		);
		expect(actual.repos.map((r) => r.url)).toEqual(preview.context.after.repos.map((r) => r.url));
	});

	it('keeps a high-cardinality signed review inside the public token limit', async () => {
		for (let i = 0; i < 200; i++) {
			t.sqlite.exec(`
				INSERT INTO context_item (
					id, user_id, kind, name, description, project_id, body,
					position, version, created_at, updated_at
				) VALUES (
					'ctx_many_${i}', '${USER}', 'prompt', 'guidance-${i}', '', '${DESTINATION}',
					'Inspectable destination guidance ${i}', ${i}, 1, ${NOW}, ${NOW}
				)
			`);
		}
		const preview = await previewIssueTransfer(t.env, actor, issueId, DESTINATION, NOW);
		expect(preview.context.changes).toHaveLength(201);
		expect(preview.preview_token!.length).toBeLessThanOrEqual(4096);
		const result = await commitIssueTransfer(
			t.env,
			actor,
			issueId,
			DESTINATION,
			preview.preview_token!,
			NOW + 1
		);
		expect(result.context_changes).toHaveLength(201);
	});

	it('allocates distinct addresses for simultaneous moves to one destination', async () => {
		const second = addIssue(t, { id: 'iss_transfer_second', title: 'Second traveller' });
		const [firstPreview, secondPreview] = await Promise.all([
			previewIssueTransfer(t.env, actor, issueId, DESTINATION, NOW),
			previewIssueTransfer(t.env, actor, second, DESTINATION, NOW)
		]);
		const results = await Promise.all([
			commitIssueTransfer(t.env, actor, issueId, DESTINATION, firstPreview.preview_token!, NOW + 1),
			commitIssueTransfer(t.env, actor, second, DESTINATION, secondPreview.preview_token!, NOW + 1)
		]);
		expect(new Set(results.map((result) => result.new_ref.number)).size).toBe(2);
	});

	it('previews without allocating, commits atomically, and resolves both addresses', async () => {
		const beforeIssue = t.all(`SELECT * FROM issue WHERE id = ?`, issueId)[0];
		const beforeContext = t.all(`SELECT * FROM context_item WHERE id = 'ctx_transfer'`)[0];
		const beforeAddresses = t.all(`SELECT * FROM issue_address`).length;

		const preview = await previewIssueTransfer(t.env, actor, issueId, DESTINATION, NOW + 100);

		expect(preview).toMatchObject({
			issue_id: issueId,
			old_ref: { ref: `demo/${beforeIssue.number}`, number: Number(beforeIssue.number) },
			new_ref: null,
			noop: false,
			can_commit: true,
			blockers: []
		});
		expect(preview.preview_token).toEqual(expect.any(String));
		expect(t.all(`SELECT * FROM issue_address`)).toHaveLength(beforeAddresses);

		const result = await commitIssueTransfer(
			t.env,
			actor,
			issueId,
			DESTINATION,
			preview.preview_token!,
			NOW + 200
		);
		const afterIssue = t.all(`SELECT * FROM issue WHERE id = ?`, issueId)[0];
		const afterContext = t.all(`SELECT * FROM context_item WHERE id = 'ctx_transfer'`)[0];

		expect(result).toMatchObject({
			status: 'transferred',
			issue_id: issueId,
			old_ref: { ref: `demo/${beforeIssue.number}` },
			new_ref: { ref: `destination/${afterIssue.number}` }
		});
		expect(result.event_id).toEqual(expect.any(String));
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
			id: result.event_id,
			project_id: DESTINATION,
			created_at: NOW + 200
		});
		expect(JSON.parse(String(events[0].payload))).toMatchObject({
			source_project_id: PROJECT,
			destination_project_id: DESTINATION,
			old_ref: result.old_ref.ref,
			new_ref: result.new_ref.ref
		});
	});

	it('uses the request-specific receipt instead of trigger-inclusive change metadata', async () => {
		const preview = await previewIssueTransfer(t.env, actor, issueId, DESTINATION, NOW);
		const realBatch = t.env.DB.batch.bind(t.env.DB);
		t.env.DB.batch = async <T = unknown>(statements: Parameters<Env['DB']['batch']>[0]) => {
			const results = await realBatch<T>(statements);
			// Real D1 includes the issue-address AFTER UPDATE trigger in this aggregate.
			results[0].meta.changes = 2;
			return results;
		};
		const result = await commitIssueTransfer(
			t.env,
			actor,
			issueId,
			DESTINATION,
			preview.preview_token!,
			NOW + 1
		);
		expect(result).toMatchObject({
			status: 'transferred',
			issue_id: issueId,
			event_id: expect.any(String),
			new_ref: { project_id: DESTINATION }
		});
		expect(t.all(`SELECT * FROM event WHERE type = 'issue.transferred'`)).toHaveLength(1);
		expect(t.all(`SELECT * FROM issue_address WHERE issue_id = ?`, issueId)).toHaveLength(2);
	});

	it('treats a mismatched request receipt as an invariant failure, not a stale guard', async () => {
		const preview = await previewIssueTransfer(t.env, actor, issueId, DESTINATION, NOW);
		const realBatch = t.env.DB.batch.bind(t.env.DB);
		t.env.DB.batch = async <T = unknown>(statements: Parameters<Env['DB']['batch']>[0]) => {
			const results = await realBatch<T>(statements);
			const receipt = results[3]?.results?.[0] as { event_id?: string } | undefined;
			if (receipt) receipt.event_id = 'evt_from_another_request';
			return results;
		};
		await expect(
			commitIssueTransfer(t.env, actor, issueId, DESTINATION, preview.preview_token!, NOW + 1)
		).rejects.toThrow('malformed receipt');
		expect(t.all(`SELECT * FROM event WHERE type = 'issue.transferred'`)).toHaveLength(1);
	});

	it('returns an unchanged same-project no-op with no allocation or event', async () => {
		const before = t.all(`SELECT * FROM issue WHERE id = ?`, issueId)[0];
		const addresses = t.all(`SELECT * FROM issue_address`).length;
		const preview = await previewIssueTransfer(t.env, actor, issueId, PROJECT, NOW + 100);
		expect(preview).toMatchObject({ noop: true, can_commit: true });

		const result = await commitIssueTransfer(
			t.env,
			actor,
			issueId,
			PROJECT,
			preview.preview_token!,
			NOW + 200
		);

		expect(result).toMatchObject({
			status: 'noop',
			issue_id: issueId,
			old_ref: { ref: `demo/${before.number}` },
			new_ref: { ref: `demo/${before.number}` },
			event_id: null
		});
		expect(t.all(`SELECT * FROM issue WHERE id = ?`, issueId)[0]).toEqual(before);
		expect(t.all(`SELECT * FROM issue_address`)).toHaveLength(addresses);
		expect(t.all(`SELECT * FROM event WHERE type = 'issue.transferred'`)).toHaveLength(0);
	});

	it('lets run keys preview the blocker but never commit', async () => {
		const runActor = { ...actor, viaSession: false, agentRunId: 'arun_self' };
		const preview = await previewIssueTransfer(t.env, runActor, issueId, DESTINATION, NOW);
		expect(preview).toMatchObject({
			can_commit: false,
			preview_token: null,
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
			can_commit: false,
			preview_token: null,
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
				commitIssueTransfer(t.env, actor, issueId, DESTINATION, preview.preview_token!, NOW + 1)
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
		const token = preview.preview_token!;
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
		await commitIssueTransfer(t.env, actor, issueId, DESTINATION, first.preview_token!, NOW + 1);
		const back = await previewIssueTransfer(t.env, actor, issueId, PROJECT, NOW + 2);
		await commitIssueTransfer(t.env, actor, issueId, PROJECT, back.preview_token!, NOW + 3);

		await expect(
			commitIssueTransfer(t.env, actor, issueId, DESTINATION, first.preview_token!, NOW + 4)
		).rejects.toMatchObject({ status: 409, code: 'transfer_conflict' });
		expect(t.all(`SELECT * FROM event WHERE type = 'issue.transferred'`)).toHaveLength(2);
	});

	it('serializes claim and move: a winning claim blocks transfer without cancellation', async () => {
		t.sqlite.exec(`UPDATE issue SET needs_attention = 0 WHERE id = '${issueId}'`);
		// The runner exists before the review: adding one afterwards is a
		// routing change, and the freshness barrier would refuse the commit
		// for staleness before it could reach the busy check under test.
		const runnerId = addRunner(t);
		const preview = await previewIssueTransfer(t.env, actor, issueId, DESTINATION, NOW);
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
			commitIssueTransfer(t.env, actor, issueId, DESTINATION, preview.preview_token!, NOW + 1)
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
			toDestination.preview_token!,
			NOW + 1
		);
		expect(await claimRun(t.db, t.env, staleSourceClaim)).toBe(false);

		const back = await previewIssueTransfer(t.env, actor, issueId, PROJECT, NOW + 2);
		await commitIssueTransfer(t.env, actor, issueId, PROJECT, back.preview_token!, NOW + 3);
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
			commitIssueTransfer(t.env, actor, issueId, DESTINATION, preview.preview_token!, NOW + 1)
		).rejects.toThrow(/injected/);
		expect(t.all(`SELECT * FROM issue WHERE id = ?`, issueId)).toEqual(before.issue);
		expect(t.all(`SELECT * FROM issue_address WHERE issue_id = ?`, issueId)).toEqual(
			before.addresses
		);
		expect(t.all(`SELECT * FROM context_item WHERE issue_id = ?`, issueId)).toEqual(before.context);
		expect(t.all(`SELECT * FROM event WHERE issue_id = ?`, issueId)).toEqual(before.events);
	});

	it('does not signal when the guarded update loses, but signals after a committed move', async () => {
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
		let signals = 0;
		await expect(
			commitIssueTransfer(t.env, actor, issueId, DESTINATION, stale.preview_token!, NOW + 1, {
				signalDispatch: () => signals++
			})
		).rejects.toMatchObject({ status: 409, code: 'transfer_preview_stale' });
		expect(signals).toBe(0);

		const fresh = await previewIssueTransfer(t.env, actor, issueId, DESTINATION, NOW + 2);
		const result = await commitIssueTransfer(
			t.env,
			actor,
			issueId,
			DESTINATION,
			fresh.preview_token!,
			NOW + 3,
			{ signalDispatch: () => signals++ }
		);
		expect(result.status).toBe('transferred');
		expect(signals).toBe(1);
		expect(t.all(`SELECT project_id FROM issue WHERE id = ?`, issueId)[0].project_id).toBe(
			DESTINATION
		);
	});

	it('queues dispatch after the receipt and claims with the destination assignment', async () => {
		const wallNow = Date.now();
		t.sqlite.exec(
			`UPDATE issue SET needs_attention = 0, attempt_count = 0 WHERE id = '${issueId}';
			 UPDATE issue SET state_id = 'wfs_std_closed' WHERE id = 'iss_destination_occupied'`
		);
		setSettings(t);
		const runnerId = addRunner(t, {
			id: 'rnr_destination',
			type: 'local',
			lastSeen: wallNow
		});
		addRule(t, { project: DESTINATION, targets: [{ runner_id: runnerId }] });
		const preview = await previewIssueTransfer(t.env, actor, issueId, DESTINATION, wallNow);
		expect(preview.routing.after?.eligible, JSON.stringify(preview.routing.after)).toBe(true);
		const waits: Promise<unknown>[] = [];
		const result = await commitIssueTransfer(
			t.env,
			actor,
			issueId,
			DESTINATION,
			preview.preview_token!,
			wallNow + 1,
			{
				signalDispatch: () =>
					queueDispatchPass(
						{ env: t.env, ctx: { waitUntil: (promise) => waits.push(promise) } },
						USER
					)
			}
		);
		expect(result.status).toBe('transferred');
		expect(waits).toHaveLength(1);
		await Promise.all(waits);
		expect(
			t.all(
				`SELECT agent_run.issue_id, issue.project_id, agent_run.runner_id
				 FROM agent_run JOIN issue ON issue.id = agent_run.issue_id
				 WHERE agent_run.issue_id = ?`,
				issueId
			)
		).toEqual([{ issue_id: issueId, project_id: DESTINATION, runner_id: runnerId }]);
	});
});
