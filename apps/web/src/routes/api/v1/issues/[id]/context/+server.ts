import { json } from '@sveltejs/kit';
import type { IssueContextResponse } from '@tines/shared';
import { effectiveContextForIssue } from '$lib/server/api/context';
import { api, apiContext } from '$lib/server/api/core';
import type { RequestHandler } from './$types';
import { requireIssueAccess, type Requirement } from '$lib/server/api/permissions';
import { readSharedBundle } from '$lib/server/api/shared-execution-bundle';

const EXTRAS: Requirement[] = [{ domain: 'workspace', access: 'read' }];

/**
 * Effective context: the assembled bundle for the issue, computed on read. In
 * a shared project (flag on) it is the shared projection every member and
 * run reads, marked with `shared_bundle`.
 */
export const GET: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const shared = await readSharedBundle(env, db, actor, event.params.id, EXTRAS, {
		skillFiles: true
	});
	if (shared) {
		const { bundle } = shared;
		const body: IssueContextResponse = {
			...bundle.guidance,
			shared_bundle: { version: 1, digest: bundle.digest, owner: bundle.project.owner }
		};
		return json(body);
	}
	await requireIssueAccess(db, actor, event.params.id, 'read', 'context.read', EXTRAS);
	return json(await effectiveContextForIssue(db, actor.userId, event.params.id));
});
