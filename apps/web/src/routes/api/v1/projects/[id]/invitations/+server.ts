import { json } from '@sveltejs/kit';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { createInvitation, listInvitations } from '$lib/server/api/invitations';
import { sql } from 'kysely';
import { createIssue } from '$lib/server/api/issues';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	return json({ items: await listInvitations(db, actor, event.params.id), next_cursor: null });
});
export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor, effects } = await apiContext(event);
	const body = await readJson<{
		email?: unknown;
		landing_issue_id?: unknown;
		confirm_sharing?: unknown;
		expected_sharing_revision?: unknown;
	}>(event);
	const race =
		import.meta.env.VITE_TINES_E2E === '1'
			? event.request.headers.get('x-tines-e2e-membership-race')
			: null;
	const beforeCommit = race
		? async () => {
				if (race === 'stale-conversion') {
					await db
						.updateTable('project')
						.set({ sharing_revision: sql`sharing_revision + 1` })
						.where('id', '=', event.params.id)
						.execute();
				} else if (race === 'preempt-conversion') {
					const otherEmail = event.request.headers.get('x-tines-e2e-other-email');
					if (!otherEmail) throw new Error('Missing E2E other email');
					await createInvitation(
						db,
						env,
						actor,
						event.params.id,
						{
							email: otherEmail,
							confirm_sharing: true,
							expected_sharing_revision: body.expected_sharing_revision
						},
						event.url.origin
					);
				} else if (race === 'create-before-conversion') {
					await createIssue(db, env, actor, effects, event.params.id, {
						title: 'Created at conversion boundary'
					});
				} else throw new Error(`Unsupported E2E membership race: ${race}`);
			}
		: undefined;
	return json(
		await createInvitation(db, env, actor, event.params.id, body, event.url.origin, beforeCommit),
		{
			status: 201
		}
	);
});
