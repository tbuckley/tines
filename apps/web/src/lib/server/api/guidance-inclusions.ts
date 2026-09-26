import type { Kysely } from 'kysely';
import type { GuidanceInclusion } from '@tines/shared';
import type { Database } from '$lib/server/db';
import { ApiFail, notFound, requireString, runAtomic, type ActorContext } from './core';
import { contextItemQuery } from './context';
import { eventInsert } from './events';
import { requireAccess } from './permissions';
import { resolveProjectAccess } from './project-access';
import { scopeLabel } from './scope';
import { sharedExecutionEnabled } from './shared-execution';

/**
 * Owner-managed inclusion of library items into one shared project's
 * guidance (Tines/752). Only a global or label-only prompt, skill or repo is
 * includable: project-, issue- and state-anchored items share automatically
 * or never. The shared projection re-checks that on every read, so nothing
 * here needs to clean up after a later rescope.
 */

const INCLUDABLE_KINDS = ['prompt', 'skill', 'repo'] as const;

/** Owner-only, human-only, behind the release flag; returns the owner's id. */
async function requireOwner(
	db: Kysely<Database>,
	env: Pick<Env, 'SHARED_EXECUTION'>,
	actor: ActorContext,
	projectId: string,
	access: 'read' | 'write' | 'delete'
): Promise<string> {
	if (!sharedExecutionEnabled(env)) throw notFound();
	if (actor.agentRunId)
		throw new ApiFail(403, 'run_key_forbidden', 'Run keys cannot manage shared guidance');
	const project = await resolveProjectAccess(db, actor, projectId);
	if (project.role !== 'owner')
		throw new ApiFail(403, 'owner_only', 'Shared guidance belongs to the project owner.');
	requireAccess(actor, [{ domain: 'project', access, projectId }], `project.guidance.${access}`, {
		projectId
	});
	return project.ownerId;
}

/** The owner's items with no project, state or issue dimension, of an includable kind. */
function libraryItems(db: Kysely<Database>, ownerId: string) {
	return contextItemQuery(db, ownerId)
		.where('context_item.kind', 'in', INCLUDABLE_KINDS)
		.where('context_item.project_id', 'is', null)
		.where('context_item.workflow_state_id', 'is', null)
		.where('context_item.issue_id', 'is', null);
}

type LibraryRow = Awaited<ReturnType<ReturnType<typeof libraryItems>['execute']>>[number];

function label(row: LibraryRow): string {
	return scopeLabel({ labelId: row.label_id, labelName: row.scope_label_name });
}

export async function listInclusions(
	db: Kysely<Database>,
	env: Pick<Env, 'SHARED_EXECUTION'>,
	actor: ActorContext,
	projectId: string
): Promise<{ items: GuidanceInclusion[] }> {
	const ownerId = await requireOwner(db, env, actor, projectId, 'read');
	const rows = await contextItemQuery(db, ownerId)
		.innerJoin('project_guidance_inclusion as g', 'g.context_item_id', 'context_item.id')
		.select(['g.revision as inclusion_revision', 'g.created_at as included_at'])
		.where('g.project_id', '=', projectId)
		.orderBy('g.created_at')
		.orderBy('context_item.id')
		.execute();
	return {
		items: rows.map((row) => ({
			item_id: row.id,
			kind: row.kind as GuidanceInclusion['kind'],
			name: row.name,
			scope_label: label(row),
			version: row.version,
			revision: row.inclusion_revision,
			created_at: row.included_at
		}))
	};
}

/** Page loader only: what the "Include from library" dialog offers. */
export async function listInclusionCandidates(
	db: Kysely<Database>,
	env: Pick<Env, 'SHARED_EXECUTION'>,
	actor: ActorContext,
	projectId: string
): Promise<
	{ item_id: string; kind: GuidanceInclusion['kind']; name: string; scope_label: string }[]
> {
	const ownerId = await requireOwner(db, env, actor, projectId, 'read');
	const rows = await libraryItems(db, ownerId)
		.where((eb) =>
			eb.not(
				eb.exists(
					eb
						.selectFrom('project_guidance_inclusion as g')
						.select('g.context_item_id')
						.whereRef('g.context_item_id', '=', 'context_item.id')
						.where('g.project_id', '=', projectId)
				)
			)
		)
		.orderBy('context_item.kind')
		.orderBy('context_item.name')
		.orderBy('context_item.id')
		.execute();
	return rows.map((row) => ({
		item_id: row.id,
		kind: row.kind as GuidanceInclusion['kind'],
		name: row.name,
		scope_label: label(row)
	}));
}

export async function includeItem(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	projectId: string,
	body: { item_id?: unknown }
): Promise<{ created: boolean; inclusion: GuidanceInclusion }> {
	const ownerId = await requireOwner(db, env, actor, projectId, 'write');
	const itemId = requireString(body.item_id, 'item_id', { max: 200 });
	const row = await libraryItems(db, ownerId)
		.where('context_item.id', '=', itemId)
		.executeTakeFirst();
	if (!row)
		throw new ApiFail(
			422,
			'inclusion_not_admissible',
			'Only a prompt, skill or repo from your library with no project, state or issue scope can be included.'
		);
	const existing = await db
		.selectFrom('project_guidance_inclusion')
		.select(['revision', 'created_at'])
		.where('project_id', '=', projectId)
		.where('context_item_id', '=', itemId)
		.executeTakeFirst();
	const view = (revision: number, createdAt: number): GuidanceInclusion => ({
		item_id: row.id,
		kind: row.kind as GuidanceInclusion['kind'],
		name: row.name,
		scope_label: label(row),
		version: row.version,
		revision,
		created_at: createdAt
	});
	if (existing) return { created: false, inclusion: view(existing.revision, existing.created_at) };
	const now = Date.now();
	await runAtomic(env, [
		db
			.insertInto('project_guidance_inclusion')
			.values({ project_id: projectId, context_item_id: itemId, created_at: now })
			.onConflict((oc) => oc.doNothing())
			.compile(),
		eventInsert(db, actor, {
			type: 'project.guidance_included',
			projectId,
			createdAt: now,
			payload: { item_id: row.id, kind: row.kind, name: row.name }
		})
	]);
	return { created: true, inclusion: view(1, now) };
}

export async function excludeItem(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	projectId: string,
	itemId: string
): Promise<GuidanceInclusion> {
	await requireOwner(db, env, actor, projectId, 'delete');
	const listed = (await listInclusions(db, env, actor, projectId)).items.find(
		(item) => item.item_id === itemId
	);
	if (!listed) throw notFound();
	await runAtomic(env, [
		db
			.deleteFrom('project_guidance_inclusion')
			.where('project_id', '=', projectId)
			.where('context_item_id', '=', itemId)
			.compile(),
		eventInsert(db, actor, {
			type: 'project.guidance_excluded',
			projectId,
			payload: { item_id: itemId, kind: listed.kind, name: listed.name }
		})
	]);
	return listed;
}
