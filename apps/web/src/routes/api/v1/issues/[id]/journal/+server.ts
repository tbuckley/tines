import { json } from '@sveltejs/kit';
import { journalForIssue } from '$lib/server/api/context';
import { api, apiContext } from '$lib/server/api/core';
import type { RequestHandler } from './$types';
import { requireIssueAccess } from '$lib/server/api/permissions';

/** Journal scope: which journal this caller owns — run-anchored for run keys. */
export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	await requireIssueAccess(db, actor, event.params.id, 'read', 'journal.read', [
		{ domain: 'workspace', access: 'read' }
	]);
	return json(await journalForIssue(db, actor, event.params.id));
});
