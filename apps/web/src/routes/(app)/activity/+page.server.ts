import { encodeCursor } from '$lib/server/api/core';
import { eventQuery, serializeEvent } from '$lib/server/api/events';
import { findProject, partitionProjects } from '$lib/archived';
import { listProjects } from '$lib/server/api/projects';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 50;

export const load: PageServerLoad = async ({ locals, platform, url }) => {
	const db = getDb(platform!.env);
	const userId = locals.user!.id;

	const project = url.searchParams.get('project') ?? undefined;
	const type = url.searchParams.get('type') ?? undefined;

	let q = eventQuery(db, userId);
	if (project) {
		q = q.where((eb) =>
			eb.or([eb('event.project_id', '=', project), eb('project.name', '=', project)])
		);
	}
	if (type) q = q.where('event.type', '=', type);

	const [rows, projects] = await Promise.all([
		q
			.orderBy('event.created_at desc')
			.orderBy('event.id desc')
			.limit(PAGE_SIZE + 1)
			.execute(),
		listProjects(db, userId, { archived: 'all' })
	]);

	const events = rows.slice(0, PAGE_SIZE).map(serializeEvent);
	const last = events[events.length - 1];
	return {
		events,
		nextCursor: rows.length > PAGE_SIZE && last ? encodeCursor(last.created_at, last.id) : null,
		projects: partitionProjects(projects).live,
		// So a ?project= naming an archived project shows its name, not "All projects".
		archivedProject: findProject(partitionProjects(projects).archived, project),
		filters: { project: project ?? '', type: type ?? '' }
	};
};
