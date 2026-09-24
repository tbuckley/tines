import { json } from '@sveltejs/kit';
import type { UpdateScheduleRequest } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { deleteSchedule, getScheduleForActor, updateSchedule } from '$lib/server/api/schedules';
import { readSharedScheduleSummary } from '$lib/server/api/schedule-consent';
import { actorForSchedule, resolveProjectAccess } from '$lib/server/api/project-access';
import { notFound } from '$lib/server/api/core';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const schedule = await db
		.selectFrom('scheduled_task')
		.select('project_id')
		.where('id', '=', event.params.id)
		.executeTakeFirst();
	if (!schedule) throw notFound();
	const access = await resolveProjectAccess(db, actor, schedule.project_id);
	if (access.role === 'owner') return json(await getScheduleForActor(db, actor, event.params.id));
	const summary = await readSharedScheduleSummary(db, actor, event.params.id, async () => true);
	if (
		(await resolveProjectAccess(db, actor, schedule.project_id)).membershipRevision !==
		access.membershipRevision
	)
		throw notFound();
	return json(summary);
});

export const PATCH: RequestHandler = api(async (event) => {
	const { db, env, actor: requester } = await apiContext(event);
	// Members work on shared projects with the owner's scope (project-access.ts).
	const actor = await actorForSchedule(db, requester, event.params.id);
	const body = await readJson<UpdateScheduleRequest>(event);
	return json(await updateSchedule(db, env, actor, event.params.id, body));
});

export const DELETE: RequestHandler = api(async (event) => {
	const { db, env, actor: requester } = await apiContext(event);
	// Members work on shared projects with the owner's scope (project-access.ts).
	const actor = await actorForSchedule(db, requester, event.params.id);
	await deleteSchedule(db, env, actor, event.params.id);
	return new Response(null, { status: 204 });
});
