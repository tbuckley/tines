/**
 * Who may do what with a project's packs (docs/packs.md, "Who can do what").
 * Any person who can work in the project may; a member of a shared project
 * acts with the owner's scope (`actorForProject`), so the pack's rows belong
 * to the project owner either way. Run keys may read and export only.
 */
import type { Kysely } from 'kysely';
import type { Database, PackRow } from '$lib/server/db';
import { ApiFail, attributedUserId, notFound, type ActorContext } from '../core';
import { actorForProject } from '../project-access';
import { requireAccess } from '../permissions';
import { assertWritable } from '../archive';

export interface PackProject {
	/** The actor to act as: the owner's scope, with `member` set for a member. */
	actor: ActorContext;
	/** The person acting (for their own secrets and attribution). */
	personId: string;
	project: { id: string; name: string; user_id: string; archived_at: number | null };
}

/**
 * Resolves a project for a pack operation. `write` also needs workspace write
 * (packs create workflows) and a live project.
 */
export async function packProject(
	db: Kysely<Database>,
	actor: ActorContext,
	projectId: string,
	mode: 'read' | 'write',
	operation: string
): Promise<PackProject> {
	const scoped = await actorForProject(db, actor, projectId);
	const project = await db
		.selectFrom('project')
		.select(['id', 'name', 'user_id', 'archived_at'])
		.where('id', '=', projectId)
		.executeTakeFirst();
	if (!project || project.user_id !== scoped.userId) throw notFound();
	requireAccess(
		scoped,
		[
			{ domain: 'project', access: mode, projectId },
			...(mode === 'write' ? [{ domain: 'workspace' as const, access: 'write' as const }] : [])
		],
		operation,
		{ projectId }
	);
	if (mode === 'write') await assertWritable(db, scoped, project);
	return { actor: scoped, personId: attributedUserId(scoped), project };
}

export async function loadPack(
	db: Kysely<Database>,
	projectId: string,
	packId: string
): Promise<PackRow> {
	const pack = await db
		.selectFrom('pack')
		.selectAll()
		.where('id', '=', packId)
		.where('project_id', '=', projectId)
		.executeTakeFirst();
	if (!pack) throw notFound();
	return pack;
}

/** Widening agent authority is a browser decision (as `run-scope` changes are). */
export function assertBrowser(actor: ActorContext, what: string): void {
	if (!actor.viaSession || actor.bearerPresent || actor.apiKeyId !== null)
		throw new ApiFail(
			403,
			'browser_required',
			`${what} gives agents authority past their own issue; confirm it in the browser`
		);
}

export function assertAuthored(pack: PackRow, what: string): void {
	if (pack.kind !== 'authored')
		throw new ApiFail(
			403,
			'pack_read_only',
			`${what}: "${pack.name}" is an installed pack and is read-only. Detach it to edit it, or replace it with a new version.`
		);
}

export function revisionConflict(pack: PackRow): ApiFail {
	return new ApiFail(
		409,
		'pack_conflict',
		'This pack changed after you read it; reload and try again',
		{
			current_revision: pack.revision
		}
	);
}
