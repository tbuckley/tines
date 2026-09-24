import type { ContextItem, ContextScope, IssueLinks, IssueRef, LinkedIssue } from '@tines/shared';
import type { Kysely } from 'kysely';
import type { Database } from '$lib/server/db';
import { notFound, type ActorContext } from './core';
import { actorForProject } from './project-access';

/**
 * Members of a shared project work on the context that belongs to it: items
 * scoped to the project (alone or narrowed by state or label) or to one of
 * its issues. Global items and other projects' items are the owner's account
 * and stay out of reach. Env values are write-only for members, secret or
 * not, because they are usually credentials for the owner's agents.
 */

/** The shared project a context scope belongs to, or null for account-level scopes. */
export async function contextScopeProject(
	db: Kysely<Database>,
	scope: { project_id?: string | null; issue_id?: string | null }
): Promise<string | null> {
	if (scope.project_id) return scope.project_id;
	if (!scope.issue_id) return null;
	const row = await db
		.selectFrom('issue')
		.select('project_id')
		.where('id', '=', scope.issue_id)
		.executeTakeFirst();
	return row?.project_id ?? null;
}

/**
 * The actor for a context operation on `projectId`'s scope: the requester
 * unchanged when they own it (or it is account-level), or the delegated
 * member actor.
 */
export async function actorForContextScope(
	db: Kysely<Database>,
	requester: ActorContext,
	projectId: string | null
): Promise<ActorContext> {
	if (!projectId || requester.agentRunId) return requester;
	return actorForProject(db, requester, projectId);
}

/** The actor for an existing item: delegated only when it sits in a project the requester shares. */
export async function actorForContextItem(
	db: Kysely<Database>,
	requester: ActorContext,
	itemId: string
): Promise<ActorContext> {
	const item = await db
		.selectFrom('context_item')
		.select(['user_id', 'project_id', 'issue_id'])
		.where('id', '=', itemId)
		.executeTakeFirst();
	if (!item || item.user_id === requester.userId || requester.agentRunId) return requester;
	const projectId = await contextScopeProject(db, item);
	if (!projectId) throw notFound();
	return actorForProject(db, requester, projectId);
}

export async function memberScopeAllowed(
	db: Kysely<Database>,
	actor: ActorContext,
	scope: Pick<ContextScope, 'project_id' | 'issue_id'>
): Promise<boolean> {
	if (!actor.member) return true;
	return (await contextScopeProject(db, scope)) === actor.member.projectId;
}

/** A member never reads an env value back. */
export function redactForMember<T extends ContextItem>(actor: ActorContext, item: T): T {
	if (!actor.member || item.kind !== 'env') return item;
	const { value: _value, ...rest } = item;
	return { ...rest, value_set: true } as T;
}

/** An issue in one of the owner's other projects, as a member sees it. */
const PRIVATE_BLOCKER = {
	project_name: 'Another project',
	number: 0,
	title: 'Not shared with you'
};

/**
 * A member's copy of owner-scoped issue rows: blockers in the owner's other
 * projects keep their count but not their name.
 */
export function scopeBlockersForMember<
	T extends { project_name: string; open_blockers: IssueRef[]; duplicate_of: IssueRef | null }
>(actor: ActorContext, rows: T[]): T[] {
	if (!actor.member) return rows;
	const scope = (row: T, ref: IssueRef) =>
		ref.project_name === row.project_name ? ref : PRIVATE_BLOCKER;
	return rows.map((row) => ({
		...row,
		open_blockers: row.open_blockers.map((blocker) => scope(row, blocker)),
		duplicate_of: row.duplicate_of && scope(row, row.duplicate_of)
	}));
}

/**
 * A member's copy of an owner-scoped issue read: links to the owner's other
 * projects are dropped (they are not the member's to see), leaving a flag so
 * the page can still say the issue is blocked elsewhere.
 */
export async function scopeIssueLinksForMember<
	T extends {
		project_name: string;
		open_blockers: IssueRef[];
		duplicate_of: IssueRef | null;
		links: IssueLinks;
	}
>(
	db: Kysely<Database>,
	actor: ActorContext,
	detail: T
): Promise<T & { blocked_by_private_issue?: boolean }> {
	if (!actor.member) return detail;
	const [scoped] = scopeBlockersForMember(actor, [detail]);
	const { links } = scoped;
	const ends = [
		...links.blocked_by,
		...links.blocks,
		...links.duplicated_by,
		...(links.duplicate_of ? [links.duplicate_of] : [])
	];
	if (ends.length === 0) return scoped;
	const rows = await db
		.selectFrom('issue')
		.select(['id', 'project_id'])
		.where(
			'id',
			'in',
			ends.map((end) => end.issue_id)
		)
		.execute();
	const projectId = actor.member.projectId;
	const inProject = new Set(
		rows.filter((row) => row.project_id === projectId).map((row) => row.id)
	);
	const keep = (end: LinkedIssue) => inProject.has(end.issue_id);
	return {
		...scoped,
		links: {
			blocked_by: links.blocked_by.filter(keep),
			blocks: links.blocks.filter(keep),
			duplicated_by: links.duplicated_by.filter(keep),
			duplicate_of: links.duplicate_of && keep(links.duplicate_of) ? links.duplicate_of : null
		},
		blocked_by_private_issue: links.blocked_by.some((end) => !keep(end))
	};
}
