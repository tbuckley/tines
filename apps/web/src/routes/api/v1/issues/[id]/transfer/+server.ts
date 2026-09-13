import { json } from '@sveltejs/kit';
import { api, apiContext, ApiFail, readJson, requireString } from '$lib/server/api/core';
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
 * Review a move to another project. Read-only in every case: it allocates no
 * number, writes nothing, and answers for a busy or archived issue too — the
 * blockers are part of what the operator needs to see. A run key may read this
 * (it is on the control-plane fence as readable) but always gets an authority
 * blocker and a null token.
 */
export const GET: RequestHandler = api(async (event) => {
	const { env, actor } = await apiContext(event);
	const destination = destinationParam(event.url.searchParams.get('project'));
	return json(await previewIssueTransfer(env, actor, event.params.id, destination));
});

/** Commit the reviewed move. The token must come from a fresh preview. */
export const POST: RequestHandler = api(async (event) => {
	const { env, actor, effects } = await apiContext(event);
	const body = await readJson<IssueTransferRequest>(event);
	const destination = requireString(body.project_id, 'project_id', { max: 64 });
	const token = requireString(body.preview_token, 'preview_token', { max: 4096 });
	return json(await commitIssueTransfer(env, actor, effects, event.params.id, destination, token));
});
