/**
 * The acceptance journey for a populated issue: A → B → C → A through the real
 * transfer service, over a record with comments, versioned artifact bytes,
 * labels, links, a completed run, pins and a gated schedule. What it is here to
 * prove is that the journey changes the address and nothing else — and that the
 * addresses it leaves behind keep working, keep their history, and are never
 * handed to another issue.
 */
import { describe, expect, it } from 'vitest';
import {
	NOW,
	OPEN,
	PROJECT,
	USER,
	addComment,
	addIssue,
	addLabel,
	addRun,
	addRunner,
	seedBase
} from '../supervisor/test-fixtures';
import type { ActorContext } from './core';
import { eventInsert, eventQuery, serializeEvent } from './events';
import { commitIssueTransfer, previewIssueTransfer } from './issue-transfer';
import { createIssue, loadIssue } from './issues';
import { runScheduleNow } from './schedules';
import { createTestDb, type TestDb } from './test-db';

const B = 'prj_b';
const C = 'prj_c';
const actor: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

/** One reviewed move through the real service, exactly as an operator makes it. */
async function transfer(t: TestDb, issueId: string, destination: string, now: number) {
	const preview = await previewIssueTransfer(t.env, actor, issueId, destination, now);
	expect(preview.can_commit).toBe(true);
	expect(preview.new_ref).toBeNull();
	const result = await commitIssueTransfer(
		t.env,
		actor,
		issueId,
		destination,
		preview.preview_token!,
		now
	);
	if (result.status !== 'transferred') throw new Error('expected a transfer');
	return result;
}

/** Everything about the issue that a move is not allowed to touch. */
function record(t: TestDb, issueId: string) {
	const one = (sql: string, ...args: unknown[]) => t.all(sql, ...args);
	return {
		issue: one(
			`SELECT title, description, workflow_id, state_id, state_entered_at, created_at,
				pinned_runner_id, pinned_tier, attempt_count, needs_attention, scheduled_task_id
			FROM issue WHERE id = ?`,
			issueId
		),
		comments: one(
			'SELECT id, body, actor_user_id, actor_api_key_id, created_at FROM comment WHERE issue_id = ? ORDER BY id',
			issueId
		),
		artifacts: one(
			`SELECT ci.id, ci.name, ci.config, av.version, av.content, av.r2_key, av.size_bytes
			FROM context_item ci JOIN artifact_version av ON av.context_item_id = ci.id
			WHERE ci.issue_id = ? AND ci.kind = 'artifact' ORDER BY ci.id, av.version`,
			issueId
		),
		artifactFiles: one(
			`SELECT avf.id, avf.artifact_version_id, avf.path, avf.size_bytes, avf.r2_key
			FROM artifact_version_file avf
			JOIN artifact_version av ON av.id = avf.artifact_version_id
			JOIN context_item ci ON ci.id = av.context_item_id
			WHERE ci.issue_id = ? ORDER BY avf.id`,
			issueId
		),
		labels: one('SELECT label_id FROM issue_label WHERE issue_id = ? ORDER BY label_id', issueId),
		links: one(
			'SELECT id, source_issue_id, target_issue_id, kind FROM issue_link WHERE source_issue_id = ? OR target_issue_id = ? ORDER BY id',
			issueId,
			issueId
		),
		runs: one(
			'SELECT id, status, runner_id, state_id_at_start FROM agent_run WHERE issue_id = ? ORDER BY id',
			issueId
		),
		issueOnlyContext: one(
			`SELECT id, name, body, version, project_id FROM context_item
			WHERE issue_id = ? AND kind = 'prompt' ORDER BY id`,
			issueId
		)
	};
}

function fixture() {
	const t = createTestDb();
	t.env.BETTER_AUTH_SECRET = 'journey-secret';
	seedBase(t);
	t.sqlite.exec(`
		INSERT INTO project (id, user_id, name, created_at, updated_at) VALUES
			('${B}', '${USER}', 'beta', ${NOW}, ${NOW}),
			('${C}', '${USER}', 'gamma', ${NOW}, ${NOW});
	`);
	// Both destinations already own issues, so no number the journey lands on
	// can be the one it started with.
	addIssue(t, { id: 'iss_b_occupied', project: B, title: 'beta already has this' });
	addIssue(t, { id: 'iss_c_occupied', project: C, title: 'gamma already has this' });

	const label = addLabel(t, 'tooling');
	// Its neighbours come first: the traveller must hold the source's highest
	// number when it leaves, or the reuse test proves nothing.
	const other = addIssue(t, { id: 'iss_blocker', title: 'blocks the traveller' });
	const dupe = addIssue(t, { id: 'iss_dupe', title: 'duplicate of the traveller' });
	const issueId = addIssue(t, {
		id: 'iss_journey',
		title: 'Port the importer',
		description: 'the whole record travels',
		pinnedTier: 'smartest',
		attemptCount: 3,
		needsAttention: true,
		stateEnteredAt: NOW - 5000,
		labels: [label]
	});

	t.sqlite.exec(`
		INSERT INTO api_key (id, user_id, name, key_hash, key_prefix, created_at)
		VALUES ('key_reviewer', '${USER}', 'reviewer', 'hash', 'rev', ${NOW});
	`);
	addComment(t, { issueId, body: 'from alice', at: NOW + 1, id: 'cmt_alice' });
	addComment(t, {
		issueId,
		body: 'from a key',
		at: NOW + 2,
		id: 'cmt_key',
		apiKeyId: 'key_reviewer'
	});
	const runner = addRunner(t, { name: 'laptop' });
	addRun(t, {
		id: 'arun_done',
		issueId,
		runnerId: runner,
		status: 'completed',
		endedAt: NOW + 5,
		outcome: 'done'
	});

	t.sqlite.exec(`
		INSERT INTO issue_link (id, source_issue_id, target_issue_id, kind, created_at) VALUES
			('lnk_blocks', '${other}', '${issueId}', 'blocks', ${NOW}),
			('lnk_dupe', '${dupe}', '${issueId}', 'duplicate_of', ${NOW});

		-- Two versions of a text artifact and one file version with real bytes.
		INSERT INTO context_item (id, user_id, kind, name, description, issue_id, body, position, version, config, created_at, updated_at)
		VALUES
			('ctx_art_text', '${USER}', 'artifact', 'design-doc', '', '${issueId}', '', 0, 1, '{"artifact_type":"text"}', ${NOW}, ${NOW}),
			('ctx_art_file', '${USER}', 'artifact', 'evidence', '', '${issueId}', '', 1, 1, '{"artifact_type":"file"}', ${NOW}, ${NOW}),
			('ctx_art_folder', '${USER}', 'artifact', 'screenshots', '', '${issueId}', '', 2, 1, '{"artifact_type":"folder"}', ${NOW}, ${NOW});
		INSERT INTO artifact_version (id, context_item_id, version, content, content_type, size_bytes, r2_key, filename, actor_user_id, created_at)
		VALUES
			('av_text_1', 'ctx_art_text', 1, 'first draft', 'text/markdown', 11, NULL, NULL, '${USER}', ${NOW}),
			('av_text_2', 'ctx_art_text', 2, 'second draft', 'text/markdown', 12, NULL, NULL, '${USER}', ${NOW + 3}),
			('av_file_1', 'ctx_art_file', 1, NULL, 'image/png', 9, 'artifacts/ctx_art_file/1.png', 'shot.png', '${USER}', ${NOW + 4}),
			('av_folder_1', 'ctx_art_folder', 1, NULL, NULL, 12, NULL, NULL, '${USER}', ${NOW + 5});
		INSERT INTO artifact_version_file (id, artifact_version_id, path, content_type, size_bytes, r2_key)
		VALUES
			('avf_one', 'av_folder_1', 'desktop.png', 'image/png', 5, 'artifacts/ctx_art_folder/desktop.png'),
			('avf_two', 'av_folder_1', 'phone.png', 'image/png', 7, 'artifacts/ctx_art_folder/phone.png');

		-- Issue-only guidance, and guidance anchored on this issue inside the
		-- source project: only the second has a project dimension to rescope.
		INSERT INTO context_item (id, user_id, kind, name, description, project_id, issue_id, body, position, version, created_at, updated_at)
		VALUES
			('ctx_issue_only', '${USER}', 'prompt', 'issue directions', '', NULL, '${issueId}', 'issue-only guidance', 2, 4, ${NOW}, ${NOW}),
			('ctx_project_issue', '${USER}', 'prompt', 'source anchored', '', '${PROJECT}', '${issueId}', 'anchored guidance', 3, 7, ${NOW}, ${NOW});

		-- A gated schedule in the source, and the traveller is its instance.
		INSERT INTO scheduled_task (id, project_id, name, title_template, description_template,
			workflow_id, cron, timezone, require_all_closed, enabled, next_run_at, run_count, created_at, updated_at)
		VALUES ('sch_origin', '${PROJECT}', 'Weekly sweep', 'Sweep {{n}}', '', 'wf_standard',
			'0 9 * * 1', 'UTC', 1, 1, ${NOW + 100000}, 1, ${NOW}, ${NOW});
		UPDATE issue SET scheduled_task_id = 'sch_origin' WHERE id = '${issueId}';
	`);
	const artifactBytes = new Map<string, Uint8Array>([
		['artifacts/ctx_art_file/1.png', new TextEncoder().encode('PNG-BYTES')],
		['artifacts/ctx_art_folder/desktop.png', new Uint8Array([1, 2, 3, 4, 5])],
		['artifacts/ctx_art_folder/phone.png', new Uint8Array([6, 7, 8, 9, 10, 11, 12])]
	]);
	return { t, issueId, label, other, dupe, artifactBytes };
}

describe('populated issue transfer journey', () => {
	it('carries the whole record through A → B → C → A, changing only the address', async () => {
		const { t, issueId, artifactBytes } = fixture();
		const before = record(t, issueId);
		const beforeBytes = [...artifactBytes].map(([key, bytes]) => [key, [...bytes]]);
		const startNumber = Number(t.all('SELECT number FROM issue WHERE id = ?', issueId)[0].number);

		const toB = await transfer(t, issueId, B, NOW + 10);
		const toC = await transfer(t, issueId, C, NOW + 20);
		const home = await transfer(t, issueId, PROJECT, NOW + 30);

		// Not the number it left with: the source allocates a fresh one on return.
		expect(home.new_ref.project_id).toBe(PROJECT);
		expect(home.new_ref.number).not.toBe(startNumber);

		const after = record(t, issueId);
		expect(after).toEqual(before);
		expect([...artifactBytes].map(([key, bytes]) => [key, [...bytes]])).toEqual(beforeBytes);
		// The anchored row followed the issue's project dimension and kept its
		// identity, content and version; the issue-only row never moved.
		expect(
			t.all(
				"SELECT id, project_id, issue_id, body, version FROM context_item WHERE id IN ('ctx_issue_only','ctx_project_issue') ORDER BY id"
			)
		).toEqual([
			{
				id: 'ctx_issue_only',
				project_id: null,
				issue_id: issueId,
				body: 'issue-only guidance',
				version: 4
			},
			{
				id: 'ctx_project_issue',
				project_id: PROJECT,
				issue_id: issueId,
				body: 'anchored guidance',
				version: 7
			}
		]);

		// Every address the journey wrote still reaches the same issue, and each
		// reports the address it has now.
		for (const ref of [
			{ id: issueId },
			{ projectId: PROJECT, number: startNumber },
			{ projectId: B, number: toB.new_ref.number },
			{ projectName: 'gamma', number: toC.new_ref.number },
			{ projectName: 'demo', number: home.new_ref.number }
		] as const) {
			const issue = await loadIssue(t.db, USER, ref);
			expect(issue).toMatchObject({
				id: issueId,
				project_id: PROJECT,
				number: home.new_ref.number
			});
		}
	});

	it('never hands a vacated number to a new issue, however it is created', async () => {
		const { t, issueId } = fixture();
		const startNumber = Number(t.all('SELECT number FROM issue WHERE id = ?', issueId)[0].number);
		// The traveller holds the source's highest number when it leaves.
		expect(
			Number(t.all(`SELECT MAX(number) AS n FROM issue WHERE project_id = '${PROJECT}'`)[0].n)
		).toBe(startNumber);

		await transfer(t, issueId, B, NOW + 10);

		const created = await createIssue(t.db, t.env, actor, PROJECT, { title: 'after the move' });
		expect(created.number).toBeGreaterThan(startNumber);

		// The schedule's own creation path allocates from the same ledger.
		t.sqlite.exec(
			`UPDATE issue SET state_id = 'wfs_std_closed' WHERE scheduled_task_id = 'sch_origin'`
		);
		const instanceId = await runScheduleNow(t.db, t.env, actor, 'sch_origin');
		const instance = t.all('SELECT project_id, number FROM issue WHERE id = ?', instanceId)[0];
		expect(instance.project_id).toBe(PROJECT);
		expect(Number(instance.number)).toBeGreaterThan(created.number);

		// And the old address is still the traveller's, not the newcomers'.
		expect(await loadIssue(t.db, USER, { projectId: PROJECT, number: startNumber })).toMatchObject({
			id: issueId
		});
	});

	it('leaves earlier activity in the source and later activity at the destination', async () => {
		const { t, issueId } = fixture();
		const startNumber = Number(t.all('SELECT number FROM issue WHERE id = ?', issueId)[0].number);
		await t.db.executeQuery(
			eventInsert(t.db, actor, {
				type: 'issue.updated',
				issueId,
				projectId: PROJECT,
				payload: { title: 'before the move' }
			})
		);

		const toB = await transfer(t, issueId, B, NOW + 10);
		await t.db.executeQuery(
			eventInsert(t.db, actor, {
				type: 'issue.updated',
				issueId,
				projectId: B,
				payload: { title: 'after the move' }
			})
		);

		const rows = await eventQuery(t.db, USER).where('event.issue_id', '=', issueId).execute();
		const events = rows.map(serializeEvent);
		const moves = events.filter((e) => e.type === 'issue.transferred');
		expect(moves).toHaveLength(1);
		expect(moves[0]).toMatchObject({ project_id: B, actor: expect.objectContaining({}) });
		expect(moves[0].payload).toMatchObject({
			source_project_name: 'demo',
			destination_project_name: 'beta',
			old_ref: `demo/${startNumber}`,
			new_ref: `beta/${toB.new_ref.number}`
		});
		expect(moves[0].created_at).toBe(NOW + 10);

		// The source feed keeps what happened there; the destination feed starts
		// with the move. Both link to the address the issue has now.
		const byProject = (projectId: string) =>
			events.filter((e) => e.project_id === projectId).map((e) => e.type);
		expect(byProject(PROJECT)).toContain('issue.updated');
		expect(byProject(B)).toContain('issue.transferred');
		expect(byProject(B)).toContain('issue.updated');
		for (const event of events) {
			if (!event.issue_ref) continue;
			// Never the historical project spliced onto the live number.
			expect(event.issue_ref).toMatchObject({
				project_name: 'beta',
				number: toB.new_ref.number
			});
		}
	});

	it('keeps a moved instance on its schedule, still blocking the original gate', async () => {
		const { t, issueId } = fixture();
		const preview = await previewIssueTransfer(t.env, actor, issueId, B, NOW + 10);
		expect(preview.schedule).toMatchObject({
			id: 'sch_origin',
			project_id: PROJECT,
			project_name: 'demo'
		});
		const moved = await transfer(t, issueId, B, NOW + 10);

		// Still this schedule's instance, and still not done: the gate holds even
		// though the instance now lives in another project.
		expect(
			t.all('SELECT scheduled_task_id FROM issue WHERE id = ?', issueId)[0].scheduled_task_id
		).toBe('sch_origin');
		await expect(runScheduleNow(t.db, t.env, actor, 'sch_origin')).rejects.toMatchObject({
			status: 422,
			code: 'schedule_blocked'
		});
		// The blocker names the address the instance has now, not the one it had.
		await expect(runScheduleNow(t.db, t.env, actor, 'sch_origin')).rejects.toMatchObject({
			details: {
				open_instances: [
					expect.objectContaining({ project_name: 'beta', number: moved.new_ref.number })
				]
			}
		});

		t.sqlite.exec(`UPDATE issue SET state_id = 'wfs_std_closed' WHERE id = '${issueId}'`);
		const nextId = await runScheduleNow(t.db, t.env, actor, 'sch_origin');
		// The next instance belongs to the schedule's own project, not the one
		// its predecessor wandered into.
		expect(t.all('SELECT project_id FROM issue WHERE id = ?', nextId)[0].project_id).toBe(PROJECT);
	});
});
