import { json } from '@sveltejs/kit';
import { api, apiContext } from '$lib/server/api/core';
import { loadStageStats } from '$lib/server/api/supervisor';
import type { RequestHandler } from './$types';
import { requireAccess } from '$lib/server/api/permissions';

/**
 * Per-stage flow over a rolling window — the flow board's "This week" row.
 * Readable with a run key like the queue beside it (Tines/257 criterion 3):
 * it aggregates the issue history agents can already read one event at a
 * time, and an agent asking "is my stage looping?" should see the answer.
 */
export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	requireAccess(actor, [{ domain: 'control_plane', access: 'read' }], 'supervisor.read');
	const url = event.url;
	const phases: string[] = [];
	const response = json(
		await loadStageStats(
			db,
			actor.userId,
			{
				window: url.searchParams.get('window') ?? undefined,
				compare: (url.searchParams.get('compare') as 'previous' | 'none' | null) ?? undefined,
				project: url.searchParams.get('project') ?? undefined
			},
			Date.now(),
			{
				phase: (name, durationMs) => phases.push(`stats_${name};dur=${durationMs.toFixed(1)}`),
				profileRepeatPreparation: event.platform?.env.STATS_SCALE_REPEAT_PREPARATION === '1'
			}
		)
	);
	response.headers.append('Server-Timing', phases.join(', '));
	return response;
});
