/**
 * The read-only gate for archived projects.
 *
 * Archiving freezes a project: every write anchored on it or on one of its
 * issues is refused with a 422 `project_archived`, while every read keeps
 * working. This module is the single place that decision is made — one
 * predicate, called by every gated write.
 *
 * It takes the project row the caller *already has*: `issueQuery`,
 * `createIssue`, the lean `requireIssue` helpers, `resolveScope`,
 * `scheduleQuery` and `getProject` all join `project` anyway, so carrying
 * `archived_at` on those selects costs no extra round trip. Every gate site
 * turned out to have a row in hand, so there is deliberately no by-id
 * fallback: a new caller should carry the column rather than re-query.
 *
 * **Archive drains, it does not refuse.** A run that was already active when
 * the project was archived is allowed to finish its own issue: it may update,
 * transition, comment, attach artifacts and label *that issue*. It may not
 * create issues, write project- or state-scoped context (so `tines journal
 * append` is refused — the lesson goes in the handoff comment), or touch
 * schedules. No snapshot is needed: nothing can dispatch a run after
 * `archived_at` is set, so any live run key with an active run predates the
 * archive. "Until the run ends" enforces itself — `endRun` revokes the key
 * and `requireActor` filters revoked keys.
 *
 * **Deliberately not gated**, so the drain cannot deadlock: everything under
 * `/api/v1/runs/*` and `/api/v1/runners/*` (log appends, finish, cancel, poll
 * delivery) and the supervisor engine's own writes (strikes, parking, the
 * timeout sweep). Reads are never gated anywhere.
 */
import { ACTIVE_RUN_STATUSES } from '@tines/shared';
import type { Kysely } from 'kysely';
import type { Database } from '$lib/server/db';
import { ApiFail, type ActorContext } from './core';
import { assertMemberStillCurrent } from './project-access';

/** The three columns the gate needs; every write path already has them. */
export interface ArchivableProject {
	id: string;
	name: string;
	archived_at: number | null;
}

/** `YYYY-MM-DD` of the archive instant — what the 422 and the CLI print. */
export function archivedDate(archivedAt: number): string {
	return new Date(archivedAt).toISOString().slice(0, 10);
}

/** The 422 every gated write throws. One wording, asserted once. */
export function projectArchivedError(project: ArchivableProject): ApiFail {
	const since = archivedDate(project.archived_at ?? 0);
	const unarchive = `tines projects unarchive "${project.name}"`;
	return new ApiFail(
		422,
		'project_archived',
		`project "${project.name}" is archived (since ${since}); run \`${unarchive}\` to make changes`,
		{
			project_id: project.id,
			project_name: project.name,
			archived_at: project.archived_at,
			unarchive_command: unarchive
		}
	);
}

/**
 * Throws `project_archived` unless the project is live, or the actor is the
 * run key of a run still active on `opts.issueId` (the drain exemption).
 * Costs nothing on the live path; one primary-key select on the archived +
 * run-key + issue path.
 */
export async function assertWritable(
	db: Kysely<Database>,
	actor: ActorContext,
	project: ArchivableProject,
	opts: { issueId?: string } = {}
): Promise<void> {
	// Every gated write passes here, so a member removed since the request
	// began is refused before anything is written.
	await assertMemberStillCurrent(db, actor);
	if (project.archived_at === null) return;
	if (opts.issueId && actor.agentRunId) {
		const run = await db
			.selectFrom('agent_run')
			.select('id')
			.where('id', '=', actor.agentRunId)
			.where('issue_id', '=', opts.issueId)
			.where('status', 'in', [...ACTIVE_RUN_STATUSES])
			.executeTakeFirst();
		if (run) return;
	}
	throw projectArchivedError(project);
}

/** Shape adapter for anything carrying an issue's denormalised project columns. */
export function issueProject(issue: {
	project_id: string;
	project_name: string;
	project_archived_at: number | null;
}): ArchivableProject {
	return {
		id: issue.project_id,
		name: issue.project_name,
		archived_at: issue.project_archived_at
	};
}

/**
 * Context writes: the scope's own project is gated with no exemption (a
 * project- or state-scoped item is not the run's issue), and an issue-scoped
 * item is gated on that issue's project with the drain exemption.
 */
export async function assertScopeWritable(
	db: Kysely<Database>,
	actor: ActorContext,
	scope: {
		projectId: string | null;
		projectName: string | null;
		projectArchivedAt: number | null;
		issueId: string | null;
		issueProjectId: string | null;
		issueProjectName: string | null;
		issueProjectArchivedAt: number | null;
	}
): Promise<void> {
	if (scope.projectId && scope.projectArchivedAt !== null) {
		await assertWritable(db, actor, {
			id: scope.projectId,
			name: scope.projectName ?? scope.projectId,
			archived_at: scope.projectArchivedAt
		});
	}
	if (scope.issueId && scope.issueProjectId && scope.issueProjectArchivedAt !== null) {
		await assertWritable(
			db,
			actor,
			{
				id: scope.issueProjectId,
				name: scope.issueProjectName ?? scope.issueProjectId,
				archived_at: scope.issueProjectArchivedAt
			},
			{ issueId: scope.issueId }
		);
	}
}
