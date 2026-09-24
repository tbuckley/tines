import { json } from '@sveltejs/kit';
import type { Kysely } from 'kysely';
import {
	api,
	apiContext,
	ApiFail,
	readJson,
	requireString,
	type ActorContext
} from '$lib/server/api/core';
import { actorForIssue, resolveProjectAccess } from '$lib/server/api/project-access';
import type { Database } from '$lib/server/db';
import { commitIssueTransfer, previewIssueTransfer } from '$lib/server/api/issue-transfer';
import type { IssueTransferRequest } from '@tines/shared';
import type { RequestHandler } from './$types';

function destinationParam(value: string | null): string {
	if (!value) {
		throw new ApiFail(422, 'invalid_field', 'project is required: the destination project ID');
	}
	return value;
}

/**
 * A member moves an issue with the owner's scope, but only into another of
 * the owner's projects that they are also a member of.
 */
async function transferActor(
	db: Kysely<Database>,
	requester: ActorContext,
	issueId: string,
	destination: string
): Promise<ActorContext> {
	const actor = await actorForIssue(db, requester, issueId);
	if (actor.member) await resolveProjectAccess(db, requester, destination);
	return actor;
}

/**
 * Review a move to another project. Read-only in every case: it allocates no
 * number, writes nothing, and answers for a busy or archived issue too — the
 * blockers are part of what the operator needs to see. A run key may read this
 * (it is on the control-plane fence as readable) but always gets an authority
 * blocker and a null token.
 */
export const GET: RequestHandler = api(async (event) => {
	const { db, env, actor: requester } = await apiContext(event);
	const destination = destinationParam(event.url.searchParams.get('project'));
	const actor = await transferActor(db, requester, event.params.id, destination);
	return json(await previewIssueTransfer(env, actor, event.params.id, destination));
});

/** Commit the reviewed move. The token must come from a fresh preview. */
export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor: requester, effects } = await apiContext(event);
	const body = await readJson<IssueTransferRequest>(event);
	const destination = requireString(body.project_id, 'project_id', { max: 64 });
	const actor = await transferActor(db, requester, event.params.id, destination);
	const token = requireString(body.preview_token, 'preview_token', { max: 4096 });
	return json(await commitIssueTransfer(env, actor, effects, event.params.id, destination, token));
});
