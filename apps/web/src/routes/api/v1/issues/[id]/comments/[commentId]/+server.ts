import { json } from '@sveltejs/kit';
import type { UpdateCommentRequest } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { deleteComment, updateComment } from '$lib/server/api/issues';
import type { RequestHandler } from './$types';

export const PATCH: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<UpdateCommentRequest>(event);
	const comment = await updateComment(
		db,
		env,
		actor,
		event.params.id,
		event.params.commentId,
		body
	);
	return json(comment);
});

// Hard delete: nothing references comment.id, and the event keeps the record
// of the action. Comments never affect readiness, so no dispatch pass.
export const DELETE: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	await deleteComment(db, env, actor, event.params.id, event.params.commentId);
	return new Response(null, { status: 204 });
});
