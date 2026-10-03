import { error } from '@sveltejs/kit';
import { AGENT_GUIDELINES_NAME, CONTEXT_KINDS } from '@tines/shared';
import { countSharedContextItems, listContextItems } from '$lib/server/api/context';
import { listLabelsInternal } from '$lib/server/api/labels';
import { redactForMember } from '$lib/server/api/member-context';
import {
	actorForProject,
	assertMemberStillCurrent,
	resolveProjectAccess
} from '$lib/server/api/project-access';
import { loadWorkflows } from '$lib/server/api/workflows';
import { getDb } from '$lib/server/db';
import { resolvePageFocus } from '$lib/server/page-focus';
import { ApiFail, sessionActor } from '$lib/server/api/core';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, url, depends }) => {
	depends('app:preferences');
	const db = getDb(platform!.env);
	const userId = locals.user!.id;
	const { focusId, notice } = await resolvePageFocus(db, platform!.env, userId, url);
	// Focused on a project shared with this user: its items live in the owner's
	// account, so the list loads with the owner's scope (project-access.ts),
	// fenced below to that one project.
	let scopeActor = sessionActor(locals.user!);
	let viewerRole: 'owner' | 'member' = 'owner';
	if (focusId) {
		try {
			const access = await resolveProjectAccess(db, scopeActor, focusId);
			if (access.role === 'member') {
				scopeActor = await actorForProject(db, scopeActor, focusId);
				viewerRole = 'member';
			}
		} catch (e) {
			if (e instanceof ApiFail) error(e.status, e.message);
			throw e;
		}
	}
	const isMember = viewerRole === 'member';
	const scopeUserId = scopeActor.userId;

	// An unrecognized kind (typo, stale link) would throw a 422 out of
	// listContextItems and 500 the page; treat it as "no kind filter".
	const rawKind = url.searchParams.get('kind');
	const filters = {
		kind: rawKind && (CONTEXT_KINDS as readonly string[]).includes(rawKind) ? rawKind : undefined,
		workflow: url.searchParams.get('workflow') ?? undefined,
		label: url.searchParams.get('label') ?? undefined,
		q: url.searchParams.get('q') ?? undefined
	};
	const [{ items: listed }, workflows, labels, guidelines, sharedItemCount] = await Promise.all([
		listContextItems(
			db,
			scopeActor,
			{ ...filters, touchesProjectId: focusId ?? undefined },
			{ cursor: null, limit: 100 }
		),
		loadWorkflows(db, scopeUserId),
		listLabelsInternal(db, scopeUserId),
		// Offer the starter guidance until a global item by that name exists. Not
		// to a member: it would seed their own account, which this list does not show.
		isMember
			? Promise.resolve(null)
			: listContextItems(
					db,
					scopeActor,
					{ kind: 'prompt', exact: true },
					{ cursor: null, limit: 100 }
				),
		// The owner's global and state-scoped library is not a member's to count.
		focusId && !isMember ? countSharedContextItems(db, scopeUserId) : Promise.resolve(null)
	]);
	let items = listed;
	if (isMember) {
		// `touchesProjectId` already fenced the rows to the shared project in SQL;
		// this drops an issue-scoped row that also names another project, and env
		// values are write-only for members.
		items = listed
			.filter((item) => !item.scope.project_id || item.scope.project_id === focusId)
			.map((item) => redactForMember(scopeActor, item));
		// A removal that won mid-load discards the response.
		try {
			await assertMemberStillCurrent(db, scopeActor);
		} catch (e) {
			if (e instanceof ApiFail) error(e.status, e.message);
			throw e;
		}
	}
	// The project halves come from the app layout; the page derives the archived
	// name it needs (so a ?project= naming an archived project is not "All projects").
	return {
		items,
		workflows,
		labels,
		filters,
		focusId,
		notice,
		sharedItemCount,
		viewerRole,
		hasAgentGuidelines:
			guidelines === null || guidelines.items.some((i) => i.name === AGENT_GUIDELINES_NAME)
	};
};
