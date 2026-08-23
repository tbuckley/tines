import { json } from '@sveltejs/kit';
import type { Comment, CreateCommentRequest, ListResponse } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { createComment, getIssueDetail, loadComments } from '$lib/server/api/issues';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const issue = await getIssueDetail(db, actor.userId, { id: event.params.id });
	// Comment threads are small in phase one; return them all, oldest first.
	const body: ListResponse<Comment> = { items: await loadComments(db, issue.id), next_cursor: null };
	return json(body);
});

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<CreateCommentRequest>(event);
	const comment = await createComment(db, env, actor, event.params.id, body);
	return json(comment, { status: 201 });
});
