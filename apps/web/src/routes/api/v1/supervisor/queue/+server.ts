import { json } from '@sveltejs/kit';
import { api, apiContext } from '$lib/server/api/core';
import { loadFleetQueue } from '$lib/server/api/supervisor';
import type { RequestHandler } from './$types';
import { requireAccess } from '$lib/server/api/permissions';

/**
 * The fleet's waiting work, grouped by why it is waiting. Readable with a run
 * key: it discloses no more than the per-issue dispatch explainer agents
 * already have, and an agent asking "why is nothing moving?" should be able
 * to see the answer (Tines/256).
 */
export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	requireAccess(actor, [{ domain: 'control_plane', access: 'read' }], 'supervisor.read');
	return json(
		await loadFleetQueue(db, actor.userId, Date.now(), {
			project: event.url.searchParams.get('project') ?? undefined
		})
	);
});
