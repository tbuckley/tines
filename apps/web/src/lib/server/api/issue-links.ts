import type { AddIssueLinkRequest, IssueLink, IssueLinkKind } from '@tines/shared';
import type { Kysely } from 'kysely';
import { newId, type Database } from '$lib/server/db';
import { ApiFail, notFound, requireString, runAtomic, type ActorContext } from './core';
import { eventInsert } from './events';
import { issueQuery, serializeIssue } from './issues';

export interface LinkEdge {
	source: string;
	target: string;
}

/**
 * Shortest-hop path `from → … → to` over the directed link graph (both
 * kinds), as issue ids, or null when `to` is unreachable. BFS with a visited
 * set, so it terminates even on a cycle that raced past write-time checks.
 */
export function findLinkPath(edges: LinkEdge[], from: string, to: string): string[] | null {
	const adjacency = new Map<string, string[]>();
	for (const edge of edges) {
		const targets = adjacency.get(edge.source);
		if (targets) targets.push(edge.target);
		else adjacency.set(edge.source, [edge.target]);
	}
	const visited = new Set([from]);
	let frontier: string[][] = [[from]];
	while (frontier.length > 0) {
		const next: string[][] = [];
		for (const path of frontier) {
			const node = path[path.length - 1];
			if (node === to) return path;
			for (const neighbor of adjacency.get(node) ?? []) {
				if (!visited.has(neighbor)) {
					visited.add(neighbor);
					next.push([...path, neighbor]);
				}
			}
		}
		frontier = next;
	}
	return null;
}

const LINK_KINDS = ['blocks', 'blocked_by', 'duplicate_of'] as const;

/** All directed edges in the user's link graph (both kinds). */
async function loadUserEdges(db: Kysely<Database>, userId: string): Promise<LinkEdge[]> {
	const rows = await db
		.selectFrom('issue_link')
		.innerJoin('issue', 'issue.id', 'issue_link.source_issue_id')
		.innerJoin('project', 'project.id', 'issue.project_id')
		.select(['issue_link.source_issue_id as source', 'issue_link.target_issue_id as target'])
		.where('project.user_id', '=', userId)
		.execute();
	return rows;
}

export async function addIssueLink(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	issueId: string,
	body: AddIssueLinkRequest
): Promise<IssueLink> {
	const kindInput = requireString(body.kind, 'kind', { max: 20 }) as (typeof LINK_KINDS)[number];
	if (!LINK_KINDS.includes(kindInput)) {
		throw new ApiFail(422, 'invalid_field', `"kind" must be one of ${LINK_KINDS.join(', ')}`, {
			field: 'kind'
		});
	}
	const otherId = requireString(body.issue_id, 'issue_id', { max: 100 }).trim();
	if (otherId === issueId) {
		throw new ApiFail(422, 'self_link', 'An issue cannot be linked to itself', {
			field: 'issue_id'
		});
	}

	const rows = await issueQuery(db, actor.userId)
		.where('issue.id', 'in', [issueId, otherId])
		.execute();
	const issue = rows.find((r) => r.id === issueId);
	const other = rows.find((r) => r.id === otherId);
	// The addressed issue missing = 404 like any bad issue URL; the referenced
	// issue missing = 404 too (cross-user references must be indistinguishable
	// from nonexistent ones).
	if (!issue || !other) throw notFound();

	// `blocked_by` is sugar: a `blocks` edge in the other direction, so
	// callers never reason about orientation.
	const kind: IssueLinkKind = kindInput === 'duplicate_of' ? 'duplicate_of' : 'blocks';
	const source = kindInput === 'blocked_by' ? other : issue;
	const target = kindInput === 'blocked_by' ? issue : other;

	const refOf = (r: typeof issue) => `${r!.project_name}/${r!.number}`;

	if (kind === 'duplicate_of') {
		const existing = serializeIssue(source).duplicate_of;
		if (existing) {
			throw new ApiFail(
				422,
				'already_duplicate',
				`${refOf(source)} is already a duplicate of ${existing.project_name}/${existing.number} — remove that link first`,
				{ duplicate_of: existing }
			);
		}
	}

	const duplicateLink = await db
		.selectFrom('issue_link')
		.select('id')
		.where('source_issue_id', '=', source.id)
		.where('target_issue_id', '=', target.id)
		.where('kind', '=', kind)
		.executeTakeFirst();
	if (duplicateLink) {
		throw new ApiFail(
			409,
			'conflict',
			`${refOf(source)} already ${kind === 'blocks' ? 'blocks' : 'duplicates'} ${refOf(target)}`
		);
	}

	// Cycle check over the combined graph: the new source→target edge closes
	// a cycle exactly when target already reaches source.
	const edges = await loadUserEdges(db, actor.userId);
	const backPath = findLinkPath(edges, target.id, source.id);
	if (backPath) {
		const cycleIds = [source.id, ...backPath];
		const refRows = await issueQuery(db, actor.userId)
			.where('issue.id', 'in', [...new Set(cycleIds)])
			.execute();
		const byId = new Map(refRows.map((r) => [r.id, r]));
		const path = cycleIds.map((id) => {
			const r = byId.get(id);
			return r
				? { issue_id: id, project_name: r.project_name, number: r.number, title: r.title }
				: { issue_id: id };
		});
		const pretty = path
			.map((p) => ('number' in p ? `${p.project_name}/${p.number}` : p.issue_id))
			.join(' → ');
		throw new ApiFail(422, 'link_cycle', `Adding this link would create a cycle: ${pretty}`, {
			path
		});
	}

	const id = newId('lnk');
	const now = Date.now();
	const eventFor = (self: typeof issue, peer: typeof issue, role: 'source' | 'target') =>
		eventInsert(db, actor, {
			type: 'issue.link_added',
			issueId: self!.id,
			projectId: self!.project_id,
			payload: {
				link_id: id,
				kind,
				role,
				other_issue_id: peer!.id,
				other_project_name: peer!.project_name,
				other_number: peer!.number,
				other_title: peer!.title
			}
		});
	await runAtomic(env, [
		db
			.insertInto('issue_link')
			.values({
				id,
				source_issue_id: source.id,
				target_issue_id: target.id,
				kind,
				created_at: now
			})
			.compile(),
		eventFor(source, target, 'source'),
		eventFor(target, source, 'target')
	]);

	return { id, kind, source_issue_id: source.id, target_issue_id: target.id, created_at: now };
}

export async function removeIssueLink(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	issueId: string,
	linkId: string
): Promise<void> {
	const link = await db
		.selectFrom('issue_link')
		.innerJoin('issue as source', 'source.id', 'issue_link.source_issue_id')
		.innerJoin('project as source_project', 'source_project.id', 'source.project_id')
		.innerJoin('issue as target', 'target.id', 'issue_link.target_issue_id')
		.selectAll('issue_link')
		.select([
			'source.project_id as source_project_id',
			'source_project.name as source_project_name',
			'source.number as source_number',
			'source.title as source_title',
			'target.project_id as target_project_id',
			'target.number as target_number',
			'target.title as target_title'
		])
		.select((eb) =>
			eb
				.selectFrom('project as target_project')
				.whereRef('target_project.id', '=', 'target.project_id')
				.select('target_project.name')
				.as('target_project_name')
		)
		.where('issue_link.id', '=', linkId)
		.where('source_project.user_id', '=', actor.userId)
		.executeTakeFirst();
	// Either endpoint's issue id addresses the link; anything else is a 404.
	if (!link || (link.source_issue_id !== issueId && link.target_issue_id !== issueId)) {
		throw notFound();
	}

	const eventFor = (
		selfIssue: string,
		selfProject: string,
		role: 'source' | 'target',
		peer: { id: string; project: string | null; number: number; title: string }
	) =>
		eventInsert(db, actor, {
			type: 'issue.link_removed',
			issueId: selfIssue,
			projectId: selfProject,
			payload: {
				link_id: link.id,
				kind: link.kind,
				role,
				other_issue_id: peer.id,
				other_project_name: peer.project,
				other_number: peer.number,
				other_title: peer.title
			}
		});
	await runAtomic(env, [
		db.deleteFrom('issue_link').where('id', '=', link.id).compile(),
		eventFor(link.source_issue_id, link.source_project_id, 'source', {
			id: link.target_issue_id,
			project: link.target_project_name,
			number: link.target_number,
			title: link.target_title
		}),
		eventFor(link.target_issue_id, link.target_project_id, 'target', {
			id: link.source_issue_id,
			project: link.source_project_name,
			number: link.source_number,
			title: link.source_title
		})
	]);
}
