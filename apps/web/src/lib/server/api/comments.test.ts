/**
 * Comment edit/delete: who may rewrite the shared record, and what the audit
 * trail keeps. The asymmetry is the point — a human's session or named key
 * cleans up after an agent (the motivating case: an agent posted a mangled
 * comment and the thread was stuck with it forever), while a run key may only
 * fix what it wrote itself.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { FULL_API_KEY_PERMISSIONS } from '@tines/shared';
import {
	NOW,
	OPEN,
	PROJECT,
	USER,
	addComment,
	addIssue,
	addRun,
	addRunKey,
	addRunner,
	seedBase
} from '../supervisor/test-fixtures';
import { ApiFail, type ActorContext } from './core';
import {
	createComment,
	deleteComment,
	getIssueDetail,
	loadComments,
	updateComment
} from './issues';
import { createTestDb, type TestDb } from './test-db';

const session: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

/** A named PAT: a key without a run behind it, so full owner authority. */
const PAT_KEY = 'key_pat';
const pat: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: PAT_KEY,
	apiKeyName: 'laptop',
	viaSession: false,
	agentRunId: null,
	permissions: FULL_API_KEY_PERMISSIONS,
	runRestriction: null
};

let t: TestDb;

beforeEach(() => {
	t = createTestDb();
	seedBase(t);
	t.sqlite.exec(
		`INSERT INTO api_key (id, user_id, name, key_hash, key_prefix, created_at)
			VALUES ('${PAT_KEY}', '${USER}', 'laptop', 'h_pat', 'p', 0)`
	);
});

/** A run on `issueId`, its api_key row, and the actor that key resolves to. */
function runActor(issueId: string, opts: { id?: string } = {}): ActorContext {
	const runner = addRunner(t);
	const runId = addRun(t, {
		id: opts.id,
		issueId,
		runnerId: runner,
		status: 'running',
		stateAtStart: OPEN
	});
	const keyId = `key_${runId}`;
	t.sqlite.exec(
		`INSERT INTO api_key (id, user_id, name, key_hash, key_prefix, agent_run_id, expires_at, created_at)
			VALUES ('${keyId}', '${USER}', 'run ${runId}', 'h_${runId}', 'p', '${runId}', 9999999999999, 0)`
	);
	return {
		userId: USER,
		userName: 'alice',
		apiKeyId: keyId,
		apiKeyName: `run ${runId}`,
		viaSession: false,
		agentRunId: runId,
		permissions: FULL_API_KEY_PERMISSIONS,
		runRestriction: {
			policy: 'run-v1',
			runId,
			issueId,
			projectId: PROJECT,
			launchStateId: OPEN
		}
	};
}

function events(issueId: string): { type: string; payload: Record<string, unknown> }[] {
	return t.sqlite
		.prepare(`SELECT type, payload FROM event WHERE issue_id = ? ORDER BY id ASC`)
		.all(issueId)
		.map((row) => ({
			type: row.type as string,
			payload: JSON.parse((row.payload as string) ?? '{}') as Record<string, unknown>
		}));
}

const fail = async (p: Promise<unknown>): Promise<ApiFail> => {
	let caught: unknown;
	await p.catch((e) => (caught = e));
	expect(caught).toBeInstanceOf(ApiFail);
	return caught as ApiFail;
};

describe('updateComment', () => {
	it('derives the final comment of the newest completed same-issue run for launch metadata', async () => {
		const issue = addIssue(t);
		const other = addIssue(t);
		const runner = addRunner(t);
		const oldRun = addRun(t, {
			id: 'arun_old',
			issueId: issue,
			runnerId: runner,
			status: 'completed',
			createdAt: NOW
		});
		const newRun = addRun(t, {
			id: 'arun_new',
			issueId: issue,
			runnerId: runner,
			status: 'completed',
			createdAt: NOW + 1
		});
		const crossIssue = addRun(t, {
			id: 'arun_cross',
			issueId: other,
			runnerId: runner,
			status: 'completed',
			createdAt: NOW + 200
		});
		const activeRun = addRun(t, {
			id: 'arun_active',
			issueId: issue,
			runnerId: runner,
			status: 'running',
			createdAt: NOW + 50
		});
		addRun(t, {
			id: 'arun_commentless',
			issueId: issue,
			runnerId: runner,
			status: 'completed',
			createdAt: NOW + 100
		});
		const tiedA = addRun(t, {
			id: 'arun_tie_a',
			issueId: issue,
			runnerId: runner,
			status: 'completed',
			createdAt: NOW + 20
		});
		const tiedB = addRun(t, {
			id: 'arun_tie_b',
			issueId: issue,
			runnerId: runner,
			status: 'completed',
			createdAt: NOW + 20
		});
		const oldKey = addRunKey(t, oldRun);
		const newKey = addRunKey(t, newRun);
		const crossKey = addRunKey(t, crossIssue);
		const activeKey = addRunKey(t, activeRun);
		const tiedAKey = addRunKey(t, tiedA);
		const tiedBKey = addRunKey(t, tiedB);
		addComment(t, { issueId: issue, body: 'old', apiKeyId: oldKey, at: NOW, id: 'cmt_old' });
		addComment(t, {
			issueId: issue,
			body: 'new first',
			apiKeyId: newKey,
			at: NOW + 1,
			id: 'cmt_new_a'
		});
		addComment(t, {
			issueId: issue,
			body: 'new final',
			apiKeyId: newKey,
			at: NOW + 2,
			id: 'cmt_new_b'
		});
		addComment(t, {
			issueId: issue,
			body: 'cross',
			apiKeyId: crossKey,
			at: NOW + 3,
			id: 'cmt_cross'
		});
		addComment(t, {
			issueId: issue,
			body: 'active must not win',
			apiKeyId: activeKey,
			at: NOW + 60,
			id: 'cmt_active'
		});
		addComment(t, {
			issueId: issue,
			body: 'tie a',
			apiKeyId: tiedAKey,
			at: NOW + 70,
			id: 'cmt_tie_a'
		});
		addComment(t, {
			issueId: issue,
			body: 'tie b first',
			apiKeyId: tiedBKey,
			at: NOW + 70,
			id: 'cmt_tie_b_a'
		});
		addComment(t, {
			issueId: issue,
			body: 'tie b final',
			apiKeyId: tiedBKey,
			at: NOW + 70,
			id: 'cmt_tie_b_z'
		});
		// A comment posted later by an older run cannot make that run newest.
		addComment(t, {
			issueId: issue,
			body: 'old posted late',
			apiKeyId: oldKey,
			at: NOW + 200,
			id: 'cmt_old_late'
		});

		const ordinary = await getIssueDetail(t.db, USER, { id: issue });
		expect(ordinary.launch_comments).toBeUndefined();
		expect(ordinary.comments).toHaveLength(9);
		const launch = await getIssueDetail(t.db, USER, { id: issue }, { launchComments: true });
		expect(launch.comments).toHaveLength(9);
		expect(launch.launch_comments?.latest_completed_run_comment_id).toBe('cmt_tie_b_z');

		// Deleting the final comment exposes that same run's deterministic predecessor.
		t.sqlite.prepare(`DELETE FROM comment WHERE id = 'cmt_tie_b_z'`).run();
		const afterDelete = await getIssueDetail(t.db, USER, { id: issue }, { launchComments: true });
		expect(afterDelete.launch_comments?.latest_completed_run_comment_id).toBe('cmt_tie_b_a');
	});

	it('finds a completed run with a comment beyond the 50-run round window', async () => {
		const issue = addIssue(t);
		const runner = addRunner(t);
		const handoffRun = addRun(t, {
			id: 'arun_handoff_beyond_cap',
			issueId: issue,
			runnerId: runner,
			status: 'completed',
			createdAt: NOW
		});
		const handoffKey = addRunKey(t, handoffRun);
		addComment(t, {
			issueId: issue,
			body: 'handoff before round cap',
			apiKeyId: handoffKey,
			at: NOW,
			id: 'cmt_handoff_beyond_cap'
		});
		for (let index = 1; index <= 51; index += 1) {
			addRun(t, {
				id: `arun_newer_commentless_${String(index).padStart(2, '0')}`,
				issueId: issue,
				runnerId: runner,
				status: 'completed',
				createdAt: NOW + index
			});
		}

		const launch = await getIssueDetail(t.db, USER, { id: issue }, { launchComments: true });
		expect(launch.launch_comments?.latest_completed_run_comment_id).toBe('cmt_handoff_beyond_cap');
	});

	it('replaces the body, stamps updated_at, and emits a content-free event', async () => {
		const issue = addIssue(t);
		const created = await createComment(t.db, t.env, session, issue, { body: 'orignal' });
		expect(created.updated_at).toBeNull();

		const updated = await updateComment(t.db, t.env, session, issue, created.id, {
			body: 'original'
		});
		expect(updated.body).toBe('original');
		expect(updated.updated_at).toBeGreaterThan(0);
		expect((await loadComments(t.db, issue))[0].body).toBe('original');

		const edited = events(issue).filter((e) => e.type === 'issue.comment_edited');
		expect(edited).toHaveLength(1);
		expect(edited[0].payload).toEqual({ comment_id: created.id, changed: ['body'] });
		// The prior body never enters the append-only stream: an edit is
		// exactly what you reach for after pasting a secret.
		expect(JSON.stringify(edited[0].payload)).not.toContain('orignal');
	});

	// requireString's own status: validation failures are 422 here, as on create.
	it('rejects an empty or oversized body', async () => {
		const issue = addIssue(t);
		const created = await createComment(t.db, t.env, session, issue, { body: 'hi' });
		expect(
			(await fail(updateComment(t.db, t.env, session, issue, created.id, { body: '' }))).status
		).toBe(422);
		expect(
			(
				await fail(
					updateComment(t.db, t.env, session, issue, created.id, { body: 'x'.repeat(100_001) })
				)
			).status
		).toBe(422);
		expect((await loadComments(t.db, issue))[0].body).toBe('hi');
	});

	it('404s on an unknown comment id, and on a comment belonging to another issue', async () => {
		const issue = addIssue(t);
		const other = addIssue(t);
		const created = await createComment(t.db, t.env, session, other, { body: 'elsewhere' });
		expect(
			(await fail(updateComment(t.db, t.env, session, issue, 'cmt_nope', { body: 'x' }))).status
		).toBe(404);
		expect(
			(await fail(updateComment(t.db, t.env, session, issue, created.id, { body: 'x' }))).status
		).toBe(404);
	});
});

describe('deleteComment', () => {
	it('removes the comment and records the deletion without its text', async () => {
		const issue = addIssue(t);
		const created = await createComment(t.db, t.env, session, issue, { body: 'oops --help' });

		await deleteComment(t.db, t.env, session, issue, created.id);
		expect(await loadComments(t.db, issue)).toEqual([]);

		const deleted = events(issue).filter((e) => e.type === 'issue.comment_deleted');
		expect(deleted).toHaveLength(1);
		expect(deleted[0].payload).toEqual({
			comment_id: created.id,
			body_length: 'oops --help'.length
		});
		expect(JSON.stringify(deleted[0].payload)).not.toContain('oops');
		// The record of the action survives the content.
		expect(events(issue).map((e) => e.type)).toContain('issue.commented');
	});

	it('404s on an unknown comment id', async () => {
		const issue = addIssue(t);
		expect((await fail(deleteComment(t.db, t.env, session, issue, 'cmt_nope'))).status).toBe(404);
	});
});

describe('comment authorization', () => {
	it('requires project delete for hard deletion and leaves the comment intact on denial', async () => {
		const issue = addIssue(t);
		const created = await createComment(t.db, t.env, session, issue, { body: 'keep me' });
		const writeOnly: ActorContext = {
			...pat,
			permissions: {
				version: 1,
				projects: { access: 'write', scope: [PROJECT] },
				workspace: 'none',
				control_plane: 'none'
			}
		};

		await expect(deleteComment(t.db, t.env, writeOnly, issue, created.id)).rejects.toMatchObject({
			status: 403,
			code: 'insufficient_permissions',
			details: { operation: 'comment.delete', domain: 'project', access: 'delete' }
		});
		expect(await loadComments(t.db, issue)).toMatchObject([{ id: created.id, body: 'keep me' }]);
		expect(events(issue).map((event) => event.type)).not.toContain('issue.comment_deleted');
	});

	it('lets a session and a named key edit and delete a run key’s comment', async () => {
		const issue = addIssue(t);
		const run = runActor(issue);
		const byRun = await createComment(t.db, t.env, run, issue, { body: 'mangled' });

		const edited = await updateComment(t.db, t.env, session, issue, byRun.id, { body: 'fixed' });
		expect(edited.body).toBe('fixed');
		// Attribution stays with the original author; only the body moved.
		expect(edited.actor.api_key_id).toBe(run.apiKeyId);
		await deleteComment(t.db, t.env, pat, issue, byRun.id);
		expect(await loadComments(t.db, issue)).toEqual([]);
	});

	it('lets a run key fix its own comment', async () => {
		const issue = addIssue(t);
		const run = runActor(issue);
		const own = await createComment(t.db, t.env, run, issue, { body: 'half-written' });
		const edited = await updateComment(t.db, t.env, run, issue, own.id, { body: 'whole' });
		expect(edited.body).toBe('whole');
		await deleteComment(t.db, t.env, run, issue, own.id);
		expect(await loadComments(t.db, issue)).toEqual([]);
	});

	it('403s a run key on another run’s comment, leaving it untouched', async () => {
		const issue = addIssue(t);
		const first = runActor(issue, { id: 'arun_first' });
		const second = runActor(issue, { id: 'arun_second' });
		const byFirst = await createComment(t.db, t.env, first, issue, { body: 'handoff notes' });

		const edit = await fail(
			updateComment(t.db, t.env, second, issue, byFirst.id, { body: 'rewritten' })
		);
		expect(edit.status).toBe(403);
		expect(edit.code).toBe('run_key_forbidden');
		const del = await fail(deleteComment(t.db, t.env, second, issue, byFirst.id));
		expect(del.status).toBe(403);
		expect(del.code).toBe('run_key_forbidden');

		const comments = await loadComments(t.db, issue);
		expect(comments).toHaveLength(1);
		expect(comments[0].body).toBe('handoff notes');
		expect(comments[0].updated_at).toBeNull();
		expect(events(issue).map((e) => e.type)).not.toContain('issue.comment_edited');
	});

	it('403s a run key on a session-authored comment', async () => {
		const issue = addIssue(t);
		const run = runActor(issue);
		const bySession = await createComment(t.db, t.env, session, issue, { body: 'human says' });
		expect(
			(await fail(updateComment(t.db, t.env, run, issue, bySession.id, { body: 'no' }))).status
		).toBe(403);
		expect((await fail(deleteComment(t.db, t.env, run, issue, bySession.id))).status).toBe(403);
	});

	it('404s another user before authorization is even considered', async () => {
		const issue = addIssue(t);
		const created = await createComment(t.db, t.env, session, issue, { body: 'mine' });
		t.sqlite.exec(
			`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
				VALUES ('u2', 'bob', 'b@x', 1, 0, 0)`
		);
		const bob: ActorContext = { ...session, userId: 'u2', userName: 'bob' };
		expect(
			(await fail(updateComment(t.db, t.env, bob, issue, created.id, { body: 'x' }))).status
		).toBe(404);
		expect((await fail(deleteComment(t.db, t.env, bob, issue, created.id))).status).toBe(404);
	});
});
