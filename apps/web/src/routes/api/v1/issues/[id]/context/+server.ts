import { json } from '@sveltejs/kit';
import { effectiveContextForIssue } from '$lib/server/api/context';
import { api, apiContext } from '$lib/server/api/core';
import type { RequestHandler } from './$types';

/**
 * Effective context: the assembled bundle for the issue, computed on read.
 * `?skill_files=false` (or `0`) omits skill file contents — display surfaces
 * show counts, never the contents, which can run to 100KB per skill.
 */
export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const raw = event.url.searchParams.get('skill_files');
	const skillFiles = raw !== 'false' && raw !== '0';
	return json(await effectiveContextForIssue(db, actor.userId, event.params.id, { skillFiles }));
});
