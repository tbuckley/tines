import type { AddIssueLinkRequest, IssueLink, IssueLinkKind } from '@tines/shared';
import { sql, type CompiledQuery, type Kysely } from 'kysely';
import { newId, type Database } from '$lib/server/db';
import type { DispatchEffects } from '$lib/server/dispatch-effects';
import { ApiFail, notFound, requireString, runAtomic, type ActorContext } from './core';
import { assertWritable, issueProject } from './archive';
import { eventInsert } from './events';
import { issueQuery } from './issues';

export interface LinkEdge {
	source: string;
	target: string;
}

/**
 * Shortest-hop path `from → … → to` over the directed link graph (both
 * kinds), as issue ids, or null when `to` is unreachable. BFS with a visited
 * set, so it terminates even when reading legacy corruption.
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
const STORED_GRAPH_KINDS = ['blocks', 'duplicate_of'] as const;

interface LinkEndpoint {
	id: string;
	project_id: string;
	project_name: string;
	number: number;
	title: string;
}

interface LinkReceipt {
	inserted: number;
	endpoints_owned: number;
	exact_exists: number;
	duplicate_link_id: string | null;
	duplicate_project_name: string | null;
	duplicate_number: number | null;
	duplicate_title: string | null;
	source_project_name: string | null;
	source_number: number | null;
	source_title: string | null;
	target_project_name: string | null;
	target_number: number | null;
	target_title: string | null;
}

interface DiagnosticEdge extends LinkEdge {
	source_project_name: string;
	source_number: number;
	source_title: string;
	target_project_name: string;
	target_number: number;
	target_title: string;
}

/**
 * The authoritative link write. Exported only so the native-D1 probe can run
 * this exact batch; callers should normally use addIssueLink.
 */
export function addIssueLinkQueries(
	db: Kysely<Database>,
	actor: ActorContext,
	source: LinkEndpoint,
	target: LinkEndpoint,
	kind: IssueLinkKind,
	id: string,
	now: number
): { queries: CompiledQuery[]; receiptIndex: number; diagnosticIndex: number } {
	const ownedEndpoints = sql<boolean>`EXISTS (
		SELECT 1
		FROM issue current_source
		JOIN project source_project ON source_project.id = current_source.project_id
		JOIN issue current_target ON current_target.id = ${target.id}
		JOIN project target_project ON target_project.id = current_target.project_id
		WHERE current_source.id = ${source.id}
			AND source_project.user_id = ${actor.userId}
			AND target_project.user_id = ${actor.userId}
	)`;
	const exactLink = sql<boolean>`EXISTS (
		SELECT 1 FROM issue_link
		WHERE source_issue_id = ${source.id} AND target_issue_id = ${target.id} AND kind = ${kind}
	)`;
	const outgoingDuplicate = sql<boolean>`EXISTS (
		SELECT 1 FROM issue_link
		WHERE source_issue_id = ${source.id} AND kind = 'duplicate_of'
	)`;
	const freshLink = sql<boolean>`EXISTS (SELECT 1 FROM issue_link WHERE id = ${id})`;
	const reachable = sql`
		WITH RECURSIVE reachable(issue_id) AS (
			SELECT ${target.id}
			UNION
			SELECT link.target_issue_id
			FROM reachable
			JOIN issue_link link ON link.source_issue_id = reachable.issue_id
			JOIN issue link_source ON link_source.id = link.source_issue_id
			JOIN project link_source_project ON link_source_project.id = link_source.project_id
			JOIN issue link_target ON link_target.id = link.target_issue_id
			JOIN project link_target_project ON link_target_project.id = link_target.project_id
			WHERE link.kind IN (${sql.join(STORED_GRAPH_KINDS)})
				AND link_source_project.user_id = ${actor.userId}
				AND link_target_project.user_id = ${actor.userId}
		)`;

	const insert = sql`
		${reachable}
		INSERT INTO issue_link (id, source_issue_id, target_issue_id, kind, created_at)
		SELECT ${id}, ${source.id}, ${target.id}, ${kind}, ${now}
		WHERE ${ownedEndpoints}
			AND NOT ${exactLink}
			AND (${kind} <> 'duplicate_of' OR NOT ${outgoingDuplicate})
			AND NOT EXISTS (SELECT 1 FROM reachable WHERE issue_id = ${source.id})
	`.compile(db);

	const eventFor = (self: LinkEndpoint, peer: LinkEndpoint, role: 'source' | 'target') =>
		eventInsert(
			db,
			actor,
			{
				type: 'issue.link_added',
				issueId: self.id,
				projectId: self.project_id,
				payload: {
					link_id: id,
					kind,
					role,
					other_issue_id: peer.id,
					other_project_name: peer.project_name,
					other_number: peer.number,
					other_title: peer.title
				},
				createdAt: now
			},
			{ predicate: freshLink }
		);

	const receipt = sql<LinkReceipt>`
		SELECT
			${freshLink} AS inserted,
			${ownedEndpoints} AS endpoints_owned,
			${exactLink} AS exact_exists,
			duplicate_link.id AS duplicate_link_id,
			duplicate_project.name AS duplicate_project_name,
			duplicate_issue.number AS duplicate_number,
			duplicate_issue.title AS duplicate_title,
			source_project.name AS source_project_name,
			current_source.number AS source_number,
			current_source.title AS source_title,
			target_project.name AS target_project_name,
			current_target.number AS target_number,
			current_target.title AS target_title
		FROM (SELECT 1) singleton
		LEFT JOIN issue current_source ON current_source.id = ${source.id}
		LEFT JOIN project source_project ON source_project.id = current_source.project_id
		LEFT JOIN issue current_target ON current_target.id = ${target.id}
		LEFT JOIN project target_project ON target_project.id = current_target.project_id
		LEFT JOIN issue_link duplicate_link
			ON duplicate_link.source_issue_id = ${source.id} AND duplicate_link.kind = 'duplicate_of'
		LEFT JOIN issue duplicate_issue ON duplicate_issue.id = duplicate_link.target_issue_id
		LEFT JOIN project duplicate_project ON duplicate_project.id = duplicate_issue.project_id
	`.compile(db);

	const diagnostic = sql<DiagnosticEdge>`
		${reachable}
		SELECT
			link.source_issue_id AS source,
			link.target_issue_id AS target,
			link_source_project.name AS source_project_name,
			link_source.number AS source_number,
			link_source.title AS source_title,
			link_target_project.name AS target_project_name,
			link_target.number AS target_number,
			link_target.title AS target_title
		FROM reachable
		JOIN issue_link link ON link.source_issue_id = reachable.issue_id
		JOIN issue link_source ON link_source.id = link.source_issue_id
		JOIN project link_source_project ON link_source_project.id = link_source.project_id
		JOIN issue link_target ON link_target.id = link.target_issue_id
		JOIN project link_target_project ON link_target_project.id = link_target.project_id
		WHERE link.kind IN (${sql.join(STORED_GRAPH_KINDS)})
			AND link_source_project.user_id = ${actor.userId}
			AND link_target_project.user_id = ${actor.userId}
			AND NOT ${freshLink}
			AND ${ownedEndpoints}
			AND NOT ${exactLink}
			AND (${kind} <> 'duplicate_of' OR NOT ${outgoingDuplicate})
			AND EXISTS (SELECT 1 FROM reachable WHERE issue_id = ${source.id})
	`.compile(db);

	const queries = [
		insert,
		eventFor(source, target, 'source'),
		eventFor(target, source, 'target'),
		receipt,
		diagnostic
	];
	return { queries, receiptIndex: 3, diagnosticIndex: 4 };
}

export async function addIssueLink(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	effects: DispatchEffects,
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
	// Both ends are gated: a draining run's exemption covers its own issue
	// only, so linking it to another issue in the archived project still 422s.
	await assertWritable(db, actor, issueProject(issue), { issueId: issue.id });
	await assertWritable(db, actor, issueProject(other), { issueId: other.id });

	// `blocked_by` is sugar: a `blocks` edge in the other direction, so
	// callers never reason about orientation.
	const kind: IssueLinkKind = kindInput === 'duplicate_of' ? 'duplicate_of' : 'blocks';
	const source = kindInput === 'blocked_by' ? other : issue;
	const target = kindInput === 'blocked_by' ? issue : other;

	const id = newId('lnk');
	const now = Date.now();
	const batch = addIssueLinkQueries(db, actor, source, target, kind, id, now);
	const results = await runAtomic(env, batch.queries);
	const receiptRows = results[batch.receiptIndex]?.results;
	if (!Array.isArray(receiptRows) || receiptRows.length !== 1) {
		throw new Error('Issue link batch returned no receipt result');
	}
	const receipt = receiptRows[0] as Partial<LinkReceipt>;
	if (
		![0, 1].includes(receipt.inserted as number) ||
		![0, 1].includes(receipt.endpoints_owned as number) ||
		![0, 1].includes(receipt.exact_exists as number) ||
		(receipt.endpoints_owned === 1 &&
			(typeof receipt.source_project_name !== 'string' ||
				!Number.isInteger(receipt.source_number) ||
				typeof receipt.source_title !== 'string' ||
				typeof receipt.target_project_name !== 'string' ||
				!Number.isInteger(receipt.target_number) ||
				typeof receipt.target_title !== 'string')) ||
		(receipt.duplicate_link_id != null &&
			(typeof receipt.duplicate_project_name !== 'string' ||
				!Number.isInteger(receipt.duplicate_number) ||
				typeof receipt.duplicate_title !== 'string'))
	) {
		throw new Error('Issue link batch returned a malformed receipt');
	}
	if (receipt.inserted === 1) {
		effects.signalDispatch();
		return { id, kind, source_issue_id: source.id, target_issue_id: target.id, created_at: now };
	}
	if (receipt.endpoints_owned !== 1) throw notFound();

	const sourceRef = `${receipt.source_project_name}/${receipt.source_number}`;
	const targetRef = `${receipt.target_project_name}/${receipt.target_number}`;
	if (kind === 'duplicate_of' && receipt.duplicate_link_id) {
		const duplicateOf = {
			project_name: receipt.duplicate_project_name!,
			number: receipt.duplicate_number!,
			title: receipt.duplicate_title!
		};
		throw new ApiFail(
			422,
			'already_duplicate',
			`${sourceRef} is already a duplicate of ${duplicateOf.project_name}/${duplicateOf.number} — remove that link first`,
			{ duplicate_of: duplicateOf }
		);
	}
	if (receipt.exact_exists === 1) {
		throw new ApiFail(
			409,
			'conflict',
			`${sourceRef} already ${kind === 'blocks' ? 'blocks' : 'duplicates'} ${targetRef}`
		);
	}

	const diagnosticRows = results[batch.diagnosticIndex]?.results;
	if (!Array.isArray(diagnosticRows)) {
		throw new Error('Issue link batch returned no diagnostic result');
	}
	const diagnostic = diagnosticRows as unknown as DiagnosticEdge[];
	const backPath = findLinkPath(diagnostic, target.id, source.id);
	if (backPath) {
		const details = new Map<
			string,
			{ issue_id: string; project_name: string; number: number; title: string }
		>();
		for (const edge of diagnostic) {
			details.set(edge.source, {
				issue_id: edge.source,
				project_name: edge.source_project_name,
				number: edge.source_number,
				title: edge.source_title
			});
			details.set(edge.target, {
				issue_id: edge.target,
				project_name: edge.target_project_name,
				number: edge.target_number,
				title: edge.target_title
			});
		}
		const path = [source.id, ...backPath].map((issue_id) => {
			if (issue_id === source.id)
				return {
					issue_id,
					project_name: receipt.source_project_name!,
					number: receipt.source_number!,
					title: receipt.source_title!
				};
			return details.get(issue_id)!;
		});
		const pretty = path.map((p) => `${p.project_name}/${p.number}`).join(' → ');
		throw new ApiFail(422, 'link_cycle', `Adding this link would create a cycle: ${pretty}`, {
			path
		});
	}
	throw new Error('Issue link batch skipped insertion without a recognized reason');
}

export async function removeIssueLink(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	effects: DispatchEffects,
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
			'source_project.archived_at as source_project_archived_at',
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
		.select((eb) =>
			eb
				.selectFrom('project as target_project')
				.whereRef('target_project.id', '=', 'target.project_id')
				.select('target_project.archived_at')
				.as('target_project_archived_at')
		)
		.where('issue_link.id', '=', linkId)
		.where('source_project.user_id', '=', actor.userId)
		.executeTakeFirst();
	// Either endpoint's issue id addresses the link; anything else is a 404.
	if (!link || (link.source_issue_id !== issueId && link.target_issue_id !== issueId)) {
		throw notFound();
	}
	await assertWritable(
		db,
		actor,
		{
			id: link.source_project_id,
			name: link.source_project_name,
			archived_at: link.source_project_archived_at
		},
		{ issueId: link.source_issue_id }
	);
	await assertWritable(
		db,
		actor,
		{
			id: link.target_project_id,
			name: link.target_project_name ?? link.target_project_id,
			archived_at: link.target_project_archived_at ?? null
		},
		{ issueId: link.target_issue_id }
	);

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
	effects.signalDispatch();
}
