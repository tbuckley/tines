import { json } from '@sveltejs/kit';
import { api, apiContext, ApiFail, requireString } from '$lib/server/api/core';
import { loadSentBackDrilldown } from '$lib/server/api/supervisor';
import type { RequestHandler } from './$types';
import { requireAccess } from '$lib/server/api/permissions';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	requireAccess(
		actor,
		[
			{ domain: 'control_plane', access: 'read' },
			{ domain: 'workspace', access: 'read' }
		],
		'supervisor.read'
	);
	const project = event.url.searchParams.get('project');
	if (project) {
		const row = await db
			.selectFrom('project')
			.select('id')
			.where('user_id', '=', actor.userId)
			.where((eb) => eb.or([eb('id', '=', project), eb('name', '=', project)]))
			.executeTakeFirst();
		if (!row) throw new ApiFail(404, 'not_found', `No project "${project}"`);
		requireAccess(
			actor,
			[{ domain: 'project', access: 'read', projectId: row.id }],
			'supervisor.read',
			{ projectId: row.id }
		);
	}
	return json(
		await loadSentBackDrilldown(
			db,
			actor.userId,
			{
				state: requireString(event.url.searchParams.get('state'), 'state'),
				window: event.url.searchParams.get('window') ?? undefined,
				project: event.url.searchParams.get('project') ?? undefined,
				until: event.url.searchParams.has('until')
					? event.url.searchParams.get('until')?.trim()
						? Number(event.url.searchParams.get('until'))
						: NaN
					: undefined
			},
			Date.now(),
			actor
		)
	);
});
