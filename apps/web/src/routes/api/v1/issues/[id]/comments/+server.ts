import { json } from '@sveltejs/kit';
import type { Comment, CreateCommentRequest, ListResponse } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { createComment, getIssueDetailForActor, loadComments } from '$lib/server/api/issues';
import { resolveIssueAccess } from '$lib/server/api/project-access';
import { readSharedIssue } from '$lib/server/api/shared-issues';
import { memberWriteRace } from '$lib/server/api/member-e2e-race';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const access = await resolveIssueAccess(db, actor, event.params.id);
	if (access.role === 'member')
		return json({
			items: (await readSharedIssue(db, actor, { id: event.params.id })).comments,
			next_cursor: null
		});
	const issue = await getIssueDetailForActor(db, actor, { id: event.params.id });
	// Comment threads are small in phase one; return them all, oldest first.
	const body: ListResponse<Comment> = {
		items: await loadComments(db, issue.id),
		next_cursor: null
	};
	return json(body);
});

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<CreateCommentRequest>(event);
	const comment = await createComment(
		db,
		env,
		actor,
		event.params.id,
		body,
		memberWriteRace(event.request, db, actor, event.params.id)
	);
	return json(comment, { status: 201 });
});
