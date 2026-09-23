import { json } from '@sveltejs/kit';
import { api, apiContext, notFound } from '$lib/server/api/core';
import { explainDispatch } from '$lib/server/supervisor/explain';
import type { RequestHandler } from './$types';
import { requireIssueAccess } from '$lib/server/api/permissions';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	await requireIssueAccess(db, actor, event.params.id, 'read', 'supervisor.read', [
		{ domain: 'control_plane', access: 'read' },
		{ domain: 'workspace', access: 'read' }
	]);
	const explainer = await explainDispatch(db, actor.userId, event.params.id);
	if (!explainer) throw notFound();
	return json(explainer);
});
