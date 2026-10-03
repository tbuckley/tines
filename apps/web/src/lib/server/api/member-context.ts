import type { ContextItem, ContextScope, IssueLinks, IssueRef, LinkedIssue } from '@tines/shared';
import type { Kysely } from 'kysely';
import type { Database } from '$lib/server/db';
import { listContextItems, type ContextItemFilters } from './context';
import { ApiFail, notFound, type ActorContext, type Page } from './core';
import {
	actorForProject,
	assertMemberStillCurrent,
	memberActor,
	resolveProjectAccess,
	runProjectActor
} from './project-access';
import { listSharedProjects } from './shared-projects';

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
	if (!projectId) return requester;
	if (requester.agentRunId) return runProjectActor(requester, projectId) ?? requester;
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
	if (!item || item.user_id === requester.userId) return requester;
	const projectId = await contextScopeProject(db, item);
	if (requester.agentRunId)
		return (projectId && runProjectActor(requester, projectId)) || requester;
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

/**
 * A member's shared-project context across every project shared with them,
 * each list fenced in SQL to its own project (so pages never come back short)
 * and re-checked against the membership before it is returned. A project the
 * member lost mid-request contributes no rows; the rest still list.
 */
export async function listSharedContextItems(
	db: Kysely<Database>,
	requester: ActorContext,
	filters: Pick<ContextItemFilters, 'kind' | 'state' | 'label' | 'q' | 'archived'>,
	page: Page
): Promise<{ items: ContextItem[]; hasMore: boolean }> {
	const projects = await listSharedProjects(db, requester, filters.archived ?? 'false');
	const pages = await Promise.all(
		projects.map(async (project) => {
			try {
				const access = await resolveProjectAccess(db, requester, project.id);
				if (access.role !== 'member') return { items: [], hasMore: false };
				const actor = memberActor(requester, access, project.owner.name);
				const { items, hasMore } = await listContextItems(
					db,
					actor,
					{ ...filters, touchesProjectId: project.id },
					page
				);
				await assertMemberStillCurrent(db, actor);
				return { items: items.map((item) => redactForMember(actor, item)), hasMore };
			} catch (error) {
				if (error instanceof ApiFail && error.status === 404) return { items: [], hasMore: false };
				throw error;
			}
		})
	);
	const merged = mergeContextPages(pages.flatMap((p) => p.items));
	return {
		items: merged.slice(0, page.limit),
		hasMore: merged.length > page.limit || pages.some((p) => p.hasMore)
	};
}

/** The list order: `updated_at` desc, then `id` desc. */
export function mergeContextPages(items: ContextItem[]): ContextItem[] {
	return [...items].sort((a, b) => b.updated_at - a.updated_at || (a.id < b.id ? 1 : -1));
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
