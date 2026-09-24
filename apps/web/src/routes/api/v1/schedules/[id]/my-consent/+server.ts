import { json } from '@sveltejs/kit';
import type { ScheduleConsentRequest } from '@tines/shared';
import { ApiFail, api, apiContext, readJson, runKeyForbidden } from '$lib/server/api/core';
import { readScheduleConsent, writeScheduleConsent } from '$lib/server/api/schedule-consent';
import {
	waitForE2eSchedulePreparation,
	releaseE2eSchedulePreparation
} from '$lib/server/api/schedule-e2e-race';
import type { RequestHandler } from './$types';
import { resolveProjectAccess } from '$lib/server/api/project-access';
import { notFound } from '$lib/server/api/core';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	if (actor.agentRunId) throw runKeyForbidden({ operation: 'schedule.consent.read' });
	const schedule = await db
		.selectFrom('scheduled_task')
		.select('project_id')
		.where('id', '=', event.params.id)
		.executeTakeFirst();
	if (!schedule) throw notFound();
	await resolveProjectAccess(db, actor, schedule.project_id);
	return json(await readScheduleConsent(db, actor.userId, event.params.id));
});

export const PUT: RequestHandler = api(async (event) => {
	const origin = event.request.headers.get('origin');
	if (!origin || origin !== event.url.origin)
		throw new ApiFail(
			403,
			'origin_required',
			'Personal permission changes require this browser origin'
		);
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<ScheduleConsentRequest>(event);
	await waitForE2eSchedulePreparation(event.request, event.params.id);
	try {
		return json(await writeScheduleConsent(db, env, actor, event.params.id, body));
	} finally {
		releaseE2eSchedulePreparation(event.request, event.params.id);
	}
});
