import { error } from '@sveltejs/kit';
import { ApiFail, sessionActor } from '$lib/server/api/core';
import { packProject } from '$lib/server/api/packs/access';
import { getPack } from '$lib/server/api/packs/authoring';
import { workflowInputOptions } from '$lib/server/api/packs/views';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, params }) => {
	const db = getDb(platform!.env);
	const actor = sessionActor({ id: locals.user!.id, name: locals.user!.name });
	const fail = (e: unknown) => {
		if (e instanceof ApiFail) error(e.status, e.message);
		throw e;
	};
	const pp = await packProject(db, actor, params.id, 'read', 'pack.read').catch(fail);
	const pack = await getPack(db, actor, params.id, params.packId).catch(fail);
	const ownerId = pp.actor.userId;
	const [workflowOptions, copyable, projectItems, schedules] = await Promise.all([
		workflowInputOptions(db, ownerId, params.id),
		// Workflows this project can use that are not already in this pack.
		db
			.selectFrom('workflow')
			.leftJoin('pack', 'pack.id', 'workflow.pack_id')
			.select(['workflow.id', 'workflow.name', 'pack.name as pack_name'])
			.where((eb) =>
				eb.or([eb('workflow.user_id', '=', ownerId), eb('workflow.user_id', 'is', null)])
			)
			.where((eb) =>
				eb.or([
					eb('workflow.pack_id', 'is', null),
					eb.and([eb('pack.project_id', '=', params.id), eb('pack.id', '!=', pack.id)])
				])
			)
			.orderBy('workflow.name')
			.execute(),
		// The project's own project-wide items, which can move into an authored pack.
		db
			.selectFrom('context_item')
			.select(['id', 'kind', 'name'])
			.where('user_id', '=', ownerId)
			.where('project_id', '=', params.id)
			.where('workflow_state_id', 'is', null)
			.where('label_id', 'is', null)
			.where('issue_id', 'is', null)
			.where('pack_id', 'is', null)
			.where('kind', 'in', ['prompt', 'skill', 'env', 'repo'])
			.orderBy('name')
			.execute(),
		// Schedules on this pack's workflows, which can be suggested in it.
		db
			.selectFrom('scheduled_task')
			.innerJoin('workflow', 'workflow.id', 'scheduled_task.workflow_id')
			.select(['scheduled_task.id', 'scheduled_task.name', 'scheduled_task.pack_schedule_id'])
			.where('workflow.pack_id', '=', pack.id)
			.where('scheduled_task.project_id', '=', params.id)
			.orderBy('scheduled_task.name')
			.execute()
	]);
	return {
		project: {
			id: pp.project.id,
			name: pp.project.name,
			archived: pp.project.archived_at !== null
		},
		pack,
		workflowOptions,
		copyable: copyable.map((w) => ({
			id: w.id,
			label: w.pack_name ? `${w.name} · ${w.pack_name}` : w.name
		})),
		projectItems,
		schedules
	};
};
