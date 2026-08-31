/**
 * Route-level wiring for comment edit/delete: the service is unit-tested in
 * lib/server/api/comments.test.ts, but a handler that forgets to pass
 * `params.commentId`, or returns the wrong status, is invisible there.
 */
import { describe, expect, it } from 'vitest';
import type { Comment } from '@tines/shared';
import { createTestDb } from '$lib/server/api/test-db';
import { createComment, loadComments } from '$lib/server/api/issues';
import { addIssue, seedBase, USER } from '$lib/server/supervisor/test-fixtures';
import { DELETE, PATCH } from './+server';

const session = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

function eventFor(t: ReturnType<typeof createTestDb>, type: string): unknown {
	return t.sqlite.prepare(`SELECT payload FROM event WHERE type = ?`).get(type);
}

/** The slice of RequestEvent these handlers touch. */
function requestEvent(
	t: ReturnType<typeof createTestDb>,
	issueId: string,
	commentId: string,
	init: RequestInit
) {
	const url = `http://test/api/v1/issues/${issueId}/comments/${commentId}`;
	return {
		params: { id: issueId, commentId },
		locals: { user: { id: USER, name: 'alice' } },
		platform: { env: t.env, ctx: { waitUntil: () => {} } },
		request: new Request(url, init),
		url: new URL(url)
	};
}

describe('PATCH /api/v1/issues/:id/comments/:commentId', () => {
	it('returns the updated comment with updated_at set', async () => {
		const t = createTestDb();
		seedBase(t);
		const issue = addIssue(t);
		const created = await createComment(t.db, t.env, session, issue, { body: 'befor' });

		const event = requestEvent(t, issue, created.id, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ body: 'before' })
		});
		const res = await PATCH(event as unknown as Parameters<typeof PATCH>[0]);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Comment;
		expect(body.id).toBe(created.id);
		expect(body.body).toBe('before');
		expect(body.updated_at).toBeGreaterThan(0);
		expect(eventFor(t, 'issue.comment_edited')).toBeTruthy();
	});
});

describe('DELETE /api/v1/issues/:id/comments/:commentId', () => {
	it('removes the comment and answers 204', async () => {
		const t = createTestDb();
		seedBase(t);
		const issue = addIssue(t);
		const created = await createComment(t.db, t.env, session, issue, { body: 'oops' });

		const event = requestEvent(t, issue, created.id, { method: 'DELETE' });
		const res = await DELETE(event as unknown as Parameters<typeof DELETE>[0]);
		expect(res.status).toBe(204);
		expect(await loadComments(t.db, issue)).toEqual([]);
		expect(eventFor(t, 'issue.comment_deleted')).toBeTruthy();
	});
});
