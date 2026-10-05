import { json } from '@sveltejs/kit';
import { journalForIssue } from '$lib/server/api/context';
import { api, apiContext } from '$lib/server/api/core';
import type { RequestHandler } from './$types';
import { requireAccess, requireIssueAccess } from '$lib/server/api/permissions';
import { actorForIssue } from '$lib/server/api/project-access';

/** Journal scope: which journal this caller owns — run-anchored for run keys. */
export const GET: RequestHandler = api(async (event) => {
	const { db, actor: requester } = await apiContext(event);
	// Only a run delegates here (to its admitted project); human members keep
	// today's owner-only read.
	const actor = requester.agentRunId
		? await actorForIssue(db, requester, event.params.id)
		: requester;
	const workspaceRead = [{ domain: 'workspace', access: 'read' }] as const;
	// Existence and reach first, so a missing issue 404s the same for everyone.
	const issue = await requireIssueAccess(
		db,
		actor,
		event.params.id,
		'read',
		'issue.read',
		workspaceRead
	);
	// Then the journal itself: a run reads only the journal it is anchored to.
	const journal = await journalForIssue(db, actor, event.params.id);
	requireAccess(
		actor,
		[{ domain: 'project', access: 'read', projectId: issue.projectId }, ...workspaceRead],
		'journal.read',
		{ projectId: issue.projectId, issueId: issue.id, boundJournal: journal.anchor === 'run' }
	);
	return json(journal);
});
