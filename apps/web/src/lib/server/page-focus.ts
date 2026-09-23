import { redirect } from '@sveltejs/kit';
import type { Kysely } from 'kysely';
import type { FocusNotice } from '$lib/focus-types';
import type { Database } from '$lib/server/db';
import { resolveFocus, setFocus } from './api/preferences';
import { listProjects } from './api/projects';
import { sessionActor } from './api/core';

/** Resolve the sticky focus and consume the legacy `?project=` one-shot. */
export async function resolvePageFocus(
	db: Kysely<Database>,
	env: App.Platform['env'],
	userId: string,
	url: URL
) {
	const resolved = await resolveFocus(db, userId);
	const ref = url.searchParams.get('project');
	let notice: FocusNotice | null = null;
	if (ref) {
		const all = await listProjects(db, sessionActor({ id: userId }), { archived: 'all' });
		const hit = all.find((project) => project.id === ref || project.name === ref);
		if (hit?.archived_at === null) {
			await setFocus(db, env, userId, hit.id);
			const rest = new URLSearchParams(url.searchParams);
			rest.delete('project');
			const query = rest.toString();
			redirect(303, `${url.pathname}${query ? `?${query}` : ''}`);
		}
		notice = hit
			? { kind: 'archived', ref, project: { id: hit.id, name: hit.name } }
			: { kind: 'unknown', ref };
	}
	return { ...resolved, notice };
}
