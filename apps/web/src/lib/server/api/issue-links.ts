import type {
	AddIssueLinkRequest,
	CreateIssueRequest,
	IssueLink,
	IssueLinkKind
} from '@tines/shared';
import { sql, type CompiledQuery, type Kysely } from 'kysely';
import { newId, type Database } from '$lib/server/db';
import type { DispatchEffects } from '$lib/server/dispatch-effects';
import { ApiFail, notFound, requireString, runAtomic, type ActorContext } from './core';
import { assertWritable } from './archive';
import { eventInsert } from './events';
import type { QueryGuard } from './query-guard';
import { nextIssueNumber } from '../issue-address';
import { requireAccess } from './permissions';

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

interface LinkEndpoint {
	id: string;
	project_id: string;
	project_name: string;
	project_archived_at: number | null;
	number: number;
	title: string;
}

interface PlannedIssueLink {
	ordinal: number;
	field: string;
	id: string;
	source_issue_id: string;
	target_issue_id: string;
	kind: 'blocks' | 'duplicate_of';
	source_event_id: string;
	target_event_id: string;
}

export interface CreateIssueLinkPlan {
	edges: PlannedIssueLink[];
	prospective?: { id: string; projectId: string; title: string };
	now: number;
}

interface PlanReceipt {
	ordinal: number;
	field: string;
	source_issue_id: string;
	target_issue_id: string;
	kind: 'blocks' | 'duplicate_of';
	endpoints_owned: number;
	exact_exists: number;
	duplicate_target_id: string | null;
	cycle_exists: number;
	issue_inserted: number;
	links_inserted: number;
	source_events_inserted: number;
	target_events_inserted: number;
}

interface PlanDiagnosticEdge extends DiagnosticEdge {
	ordinal: number | null;
}

async function loadOwnedLinkEndpoints(
	db: Kysely<Database>,
	actor: Pick<ActorContext, 'userId' | 'member'>,
	ids: string[]
): Promise<LinkEndpoint[]> {
	if (ids.length === 0) return [];
	// A member links only within the shared project: the owner's other
	// projects are not theirs to see.
	return sql<LinkEndpoint>`
		SELECT issue.id, issue.project_id, project.name AS project_name,
			project.archived_at AS project_archived_at, issue.number, issue.title
		FROM issue JOIN project ON project.id = issue.project_id
		WHERE project.user_id = ${actor.userId}
			${actor.member ? sql`AND project.id = ${actor.member.projectId}` : sql``}
			AND issue.id IN (SELECT value FROM json_each(${JSON.stringify([...new Set(ids)])}))
	`
		.execute(db)
		.then((result) => result.rows);
}

const endpointProject = (endpoint: LinkEndpoint) => ({
	id: endpoint.project_id,
	name: endpoint.project_name,
	archived_at: endpoint.project_archived_at
});

interface DiagnosticEdge extends LinkEdge {
	source_project_name: string;
	source_number: number;
	source_title: string;
	target_project_name: string;
	target_number: number;
	target_title: string;
}

/** Validate and orient create-time relationship fields before any bytes are staged. */
export async function prepareCreateIssueLinkPlan(
	db: Kysely<Database>,
	actor: ActorContext,
	prospective: NonNullable<CreateIssueLinkPlan['prospective']>,
	body: Pick<CreateIssueRequest, 'blocked_by' | 'blocks' | 'duplicate_of'>,
	now: number
): Promise<CreateIssueLinkPlan | null> {
	const raw = body as Record<string, unknown>;
	const requested: Array<{
		field: string;
		otherId: string;
		inputKind: (typeof LINK_KINDS)[number];
	}> = [];
	for (const [field, inputKind] of [
		['blocked_by', 'blocked_by'],
		['blocks', 'blocks']
	] as const) {
		const value = raw[field];
		if (value === undefined) continue;
		if (!Array.isArray(value)) {
			throw new ApiFail(422, 'invalid_field', `"${field}" must be an array of issue ids`, {
				field
			});
		}
		for (const [index, entry] of value.entries()) {
			const itemField = `${field}[${index}]`;
			requested.push({
				field: itemField,
				otherId: requireString(entry, itemField, { max: 100 }).trim(),
				inputKind
			});
		}
	}
	if (raw.duplicate_of !== undefined) {
		requested.push({
			field: 'duplicate_of',
			otherId: requireString(raw.duplicate_of, 'duplicate_of', { max: 100 }).trim(),
			inputKind: 'duplicate_of'
		});
	}
	for (const item of requested) {
		if (item.otherId === prospective.id) {
			throw new ApiFail(422, 'self_link', 'An issue cannot be linked to itself', {
				field: item.field
			});
		}
	}
	if (requested.length === 0) return null;

	const endpoints = await loadOwnedLinkEndpoints(
		db,
		actor,
		requested.map((item) => item.otherId)
	);
	const byId = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
	for (const item of requested) {
		const endpoint = byId.get(item.otherId);
		if (!endpoint) throw notFound();
		requireAccess(
			actor,
			[{ domain: 'project', access: 'write', projectId: endpoint.project_id }],
			'issue_link.create',
			{ projectId: endpoint.project_id, issueId: endpoint.id }
		);
		await assertWritable(db, actor, endpointProject(endpoint), { issueId: endpoint.id });
	}
	// A prospective issue is not the run's bound issue, so a run key cannot
	// attach a relationship while creating an unrelated issue.
	requireAccess(
		actor,
		[{ domain: 'project', access: 'write', projectId: prospective.projectId }],
		'issue_link.create',
		{ projectId: prospective.projectId, issueId: prospective.id }
	);

	return {
		prospective,
		now,
		edges: requested.map((item, ordinal) => {
			const reverse = item.inputKind === 'blocked_by';
			return {
				ordinal,
				field: item.field,
				id: newId('lnk'),
				source_issue_id: reverse ? item.otherId : prospective.id,
				target_issue_id: reverse ? prospective.id : item.otherId,
				kind: item.inputKind === 'duplicate_of' ? 'duplicate_of' : 'blocks',
				source_event_id: newId('evt'),
				target_event_id: newId('evt')
			};
		})
	};
}

function planJson(plan: CreateIssueLinkPlan): string {
	return JSON.stringify(plan.edges);
}

function pendingCte(plan: CreateIssueLinkPlan) {
	return sql`pending AS (
		SELECT
			CAST(json_extract(value, '$.ordinal') AS INTEGER) AS ordinal,
			json_extract(value, '$.field') AS field,
			json_extract(value, '$.id') AS id,
			json_extract(value, '$.source_issue_id') AS source_issue_id,
			json_extract(value, '$.target_issue_id') AS target_issue_id,
			json_extract(value, '$.kind') AS kind,
			json_extract(value, '$.source_event_id') AS source_event_id,
			json_extract(value, '$.target_event_id') AS target_event_id
		FROM json_each(${planJson(plan)})
	)`;
}

function reachableCte(actor: ActorContext) {
	return sql`reachable(ordinal, issue_id) AS (
		SELECT ordinal, target_issue_id FROM pending
		UNION
		SELECT reachable.ordinal, link.target_issue_id
		FROM reachable
		JOIN issue_link link ON link.source_issue_id = reachable.issue_id
		JOIN issue link_source ON link_source.id = link.source_issue_id
		JOIN project link_source_project ON link_source_project.id = link_source.project_id
		JOIN issue link_target ON link_target.id = link.target_issue_id
		JOIN project link_target_project ON link_target_project.id = link_target.project_id
		WHERE link.kind IN ('blocks', 'duplicate_of')
			AND link_source_project.user_id = ${actor.userId}
			AND link_target_project.user_id = ${actor.userId}
		UNION
		SELECT reachable.ordinal, earlier.target_issue_id
		FROM reachable
		JOIN pending earlier ON earlier.source_issue_id = reachable.issue_id
			AND earlier.ordinal < reachable.ordinal
	)`;
}

function endpointOwned(
	actor: ActorContext,
	plan: CreateIssueLinkPlan,
	column: 'source_issue_id' | 'target_issue_id'
) {
	if (!plan.prospective) {
		return sql`EXISTS (
			SELECT 1 FROM issue endpoint
			JOIN project endpoint_project ON endpoint_project.id = endpoint.project_id
			WHERE endpoint.id = p.${sql.id(column)} AND endpoint_project.user_id = ${actor.userId}
		)`;
	}
	return sql`(
		p.${sql.id(column)} = ${plan.prospective.id}
		OR EXISTS (
			SELECT 1 FROM issue endpoint
			JOIN project endpoint_project ON endpoint_project.id = endpoint.project_id
			WHERE endpoint.id = p.${sql.id(column)} AND endpoint_project.user_id = ${actor.userId}
		)
	)`;
}

function exactExists() {
	return sql`(
		EXISTS (
			SELECT 1 FROM issue_link existing
			WHERE existing.source_issue_id = p.source_issue_id
				AND existing.target_issue_id = p.target_issue_id AND existing.kind = p.kind
		)
		OR EXISTS (
			SELECT 1 FROM pending earlier
			WHERE earlier.ordinal < p.ordinal
				AND earlier.source_issue_id = p.source_issue_id
				AND earlier.target_issue_id = p.target_issue_id AND earlier.kind = p.kind
		)
	)`;
}

function duplicateTarget() {
	return sql`CASE WHEN p.kind = 'duplicate_of' THEN COALESCE(
		(SELECT existing.target_issue_id FROM issue_link existing
		 WHERE existing.source_issue_id = p.source_issue_id AND existing.kind = 'duplicate_of'
		 LIMIT 1),
		(SELECT earlier.target_issue_id FROM pending earlier
		 WHERE earlier.ordinal < p.ordinal AND earlier.source_issue_id = p.source_issue_id
			AND earlier.kind = 'duplicate_of' ORDER BY earlier.ordinal LIMIT 1)
	) END`;
}

/** The commit-time admission predicate shared by every root row in a linked create. */
export function createIssueLinkAdmissionGuard(
	actor: ActorContext,
	plan: CreateIssueLinkPlan
): QueryGuard {
	const ownedSource = endpointOwned(actor, plan, 'source_issue_id');
	const ownedTarget = endpointOwned(actor, plan, 'target_issue_id');
	const exact = exactExists();
	const duplicate = duplicateTarget();
	const prospectiveOwned = plan.prospective
		? sql`EXISTS (SELECT 1 FROM project WHERE id = ${plan.prospective.projectId}
			AND user_id = ${actor.userId})`
		: sql`1`;
	return {
		predicate: sql<boolean>`
			${prospectiveOwned}
			AND NOT EXISTS (
				WITH RECURSIVE ${pendingCte(plan)}, ${reachableCte(actor)}
				SELECT 1 FROM pending p
				WHERE NOT ${ownedSource} OR NOT ${ownedTarget}
					OR ${duplicate} IS NOT NULL
					OR ${exact}
					OR EXISTS (SELECT 1 FROM reachable r
						WHERE r.ordinal = p.ordinal AND r.issue_id = p.source_issue_id)
			)`
	};
}

export interface CreateIssueLinkBatch {
	queries: CompiledQuery[];
	receiptIndex: number;
	diagnosticIndex: number;
}

/** Link rows, their two-sided events, and a same-snapshot receipt/diagnostic. */
export function createIssueLinkQueries(
	db: Kysely<Database>,
	actor: ActorContext,
	plan: CreateIssueLinkPlan,
	freshIssue: QueryGuard
): CreateIssueLinkBatch {
	const json = planJson(plan);
	const pending = pendingCte(plan);
	const reachable = reachableCte(actor);
	const ownedSource = endpointOwned(actor, plan, 'source_issue_id');
	const ownedTarget = endpointOwned(actor, plan, 'target_issue_id');
	const exact = exactExists();
	const duplicate = duplicateTarget();
	const prospectiveOwned = plan.prospective
		? sql`EXISTS (SELECT 1 FROM project WHERE id = ${plan.prospective.projectId}
			AND user_id = ${actor.userId})`
		: sql`1`;
	const issueInserted = plan.prospective
		? sql`CASE WHEN EXISTS (SELECT 1 FROM issue WHERE id = ${plan.prospective.id}) THEN 1 ELSE 0 END`
		: sql`1`;
	const links = sql`
		WITH ${pending}
		INSERT INTO issue_link (id, source_issue_id, target_issue_id, kind, created_at)
		SELECT id, source_issue_id, target_issue_id, kind, ${plan.now} FROM pending
		WHERE ${freshIssue.predicate}
	`.compile(db);
	const eventQuery = (role: 'source' | 'target') => {
		const selfKey = role === 'source' ? 'source_issue_id' : 'target_issue_id';
		const peerKey = role === 'source' ? 'target_issue_id' : 'source_issue_id';
		const eventKey = role === 'source' ? 'source_event_id' : 'target_event_id';
		return sql`
			WITH ${pending}
			INSERT INTO event (id, user_id, type, actor_user_id, actor_api_key_id,
				issue_id, project_id, payload, created_at)
			SELECT p.${sql.id(eventKey)}, ${actor.userId}, 'issue.link_added', ${actor.userId},
				${actor.apiKeyId}, self.id, self.project_id,
				json_object('link_id', p.id, 'kind', p.kind, 'role', ${role},
					'other_issue_id', peer.id, 'other_project_name', peer_project.name,
					'other_number', peer.number, 'other_title', peer.title), ${plan.now}
			FROM pending p
			JOIN issue_link fresh_link ON fresh_link.id = p.id
			JOIN issue self ON self.id = p.${sql.id(selfKey)}
			JOIN issue peer ON peer.id = p.${sql.id(peerKey)}
			JOIN project peer_project ON peer_project.id = peer.project_id
		`.compile(db);
	};
	const receipt = sql<PlanReceipt>`
		WITH RECURSIVE ${pending}, ${reachable}
		SELECT p.ordinal, p.field, p.source_issue_id, p.target_issue_id, p.kind,
			CASE WHEN ${prospectiveOwned} AND ${ownedSource} AND ${ownedTarget}
				THEN 1 ELSE 0 END AS endpoints_owned,
			CASE WHEN ${exact} THEN 1 ELSE 0 END AS exact_exists,
			${duplicate} AS duplicate_target_id,
			CASE WHEN EXISTS (SELECT 1 FROM reachable r
				WHERE r.ordinal = p.ordinal AND r.issue_id = p.source_issue_id)
				THEN 1 ELSE 0 END AS cycle_exists,
			${issueInserted} AS issue_inserted,
			(SELECT COUNT(*) FROM issue_link l JOIN pending x ON x.id = l.id) AS links_inserted,
			(SELECT COUNT(*) FROM event e JOIN pending x ON x.source_event_id = e.id) AS source_events_inserted,
			(SELECT COUNT(*) FROM event e JOIN pending x ON x.target_event_id = e.id) AS target_events_inserted
		FROM pending p ORDER BY p.ordinal
	`.compile(db);
	// Diagnostics are read only on rejection. Restrict them to the first
	// rejected candidate's reachable subgraph: selecting every owner edge here
	// makes a one-edge conflict scale with the whole account.
	const writeMissing = plan.prospective
		? sql`NOT EXISTS (SELECT 1 FROM issue WHERE id = ${plan.prospective.id})`
		: sql`NOT EXISTS (SELECT 1 FROM issue_link JOIN pending ON pending.id = issue_link.id)`;
	const prospectiveNode = plan.prospective
		? sql`UNION ALL
			SELECT ${plan.prospective.id}, project.name, ${nextIssueNumber(plan.prospective.projectId)},
				${plan.prospective.title}
			FROM project WHERE project.id = ${plan.prospective.projectId}
				AND project.user_id = ${actor.userId}`
		: sql``;
	const diagnostic = sql<PlanDiagnosticEdge>`
		WITH RECURSIVE ${pending}, ${reachable}, rejections AS (
			SELECT p.ordinal, p.source_issue_id, p.target_issue_id,
				${duplicate} AS duplicate_target_id,
				CASE WHEN EXISTS (SELECT 1 FROM reachable r
					WHERE r.ordinal = p.ordinal AND r.issue_id = p.source_issue_id)
					THEN 1 ELSE 0 END AS cycle_exists
			FROM pending p
			WHERE NOT ${prospectiveOwned} OR NOT ${ownedSource} OR NOT ${ownedTarget}
				OR ${duplicate} IS NOT NULL OR ${exact}
				OR EXISTS (SELECT 1 FROM reachable r
					WHERE r.ordinal = p.ordinal AND r.issue_id = p.source_issue_id)
		), rejected AS (
			SELECT * FROM rejections ORDER BY ordinal LIMIT 1
		), graph AS (
			SELECT NULL AS ordinal, link.source_issue_id AS source, link.target_issue_id AS target
			FROM rejected
			JOIN reachable ON reachable.ordinal = rejected.ordinal
			JOIN issue_link link ON link.source_issue_id = reachable.issue_id
			JOIN issue link_source ON link_source.id = link.source_issue_id
			JOIN project link_source_project ON link_source_project.id = link_source.project_id
			JOIN issue link_target ON link_target.id = link.target_issue_id
			JOIN project link_target_project ON link_target_project.id = link_target.project_id
			WHERE rejected.cycle_exists = 1 AND link.kind IN ('blocks', 'duplicate_of')
				AND link_source_project.user_id = ${actor.userId}
				AND link_target_project.user_id = ${actor.userId}
			UNION ALL
			SELECT earlier.ordinal, earlier.source_issue_id, earlier.target_issue_id
			FROM rejected
			JOIN reachable ON reachable.ordinal = rejected.ordinal
			JOIN pending earlier ON earlier.source_issue_id = reachable.issue_id
				AND earlier.ordinal < rejected.ordinal
			WHERE rejected.cycle_exists = 1
			UNION ALL
			SELECT ordinal, source_issue_id, target_issue_id FROM rejected
			UNION ALL
			SELECT ordinal, duplicate_target_id, duplicate_target_id FROM rejected
			WHERE duplicate_target_id IS NOT NULL
		), nodes AS (
			SELECT issue.id, project.name AS project_name, issue.number, issue.title
			FROM issue JOIN project ON project.id = issue.project_id
			WHERE project.user_id = ${actor.userId}
				AND issue.id IN (SELECT source FROM graph UNION SELECT target FROM graph)
			${prospectiveNode}
		)
		SELECT graph.ordinal, graph.source, graph.target,
			source_node.project_name AS source_project_name, source_node.number AS source_number,
			source_node.title AS source_title, target_node.project_name AS target_project_name,
			target_node.number AS target_number, target_node.title AS target_title
		FROM graph
		JOIN nodes source_node ON source_node.id = graph.source
		JOIN nodes target_node ON target_node.id = graph.target
		WHERE ${writeMissing}
	`.compile(db);
	return {
		queries: [links, eventQuery('source'), eventQuery('target'), receipt, diagnostic],
		receiptIndex: 3,
		diagnosticIndex: 4
	};
}

function diagnosticDetails(rows: PlanDiagnosticEdge[]) {
	const details = new Map<
		string,
		{ issue_id: string; project_name: string; number: number; title: string }
	>();
	for (const edge of rows) {
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
	return details;
}

/** Verify the guarded create receipt or throw the existing link error vocabulary. */
export function assertCreateIssueLinksCommitted(
	plan: CreateIssueLinkPlan,
	results: Awaited<ReturnType<typeof runAtomic>>,
	batch: CreateIssueLinkBatch,
	offset = 0
): void {
	const receiptRows = results[offset + batch.receiptIndex]?.results;
	const diagnosticResult = results[offset + batch.diagnosticIndex];
	const diagnosticRows = diagnosticResult?.results;
	if (!Array.isArray(receiptRows) || receiptRows.length !== plan.edges.length) {
		throw new Error('Issue create link batch returned a malformed receipt');
	}
	if (!Array.isArray(diagnosticRows)) {
		throw new Error('Issue create link batch returned no diagnostic result');
	}
	const receipts = receiptRows as unknown as PlanReceipt[];
	const expected = plan.edges.length;
	if (
		receipts.some(
			(row, index) =>
				Number(row.ordinal) !== index ||
				typeof row.field !== 'string' ||
				typeof row.source_issue_id !== 'string' ||
				typeof row.target_issue_id !== 'string' ||
				!['blocks', 'duplicate_of'].includes(row.kind) ||
				![0, 1].includes(Number(row.endpoints_owned)) ||
				![0, 1].includes(Number(row.exact_exists)) ||
				![0, 1].includes(Number(row.cycle_exists)) ||
				![0, 1].includes(Number(row.issue_inserted)) ||
				!Number.isInteger(Number(row.links_inserted)) ||
				!Number.isInteger(Number(row.source_events_inserted)) ||
				!Number.isInteger(Number(row.target_events_inserted)) ||
				(row.duplicate_target_id !== null && typeof row.duplicate_target_id !== 'string')
		)
	) {
		throw new Error('Issue link batch returned a malformed receipt');
	}
	const first = receipts[0];
	if (
		first?.issue_inserted === 1 &&
		Number(first.links_inserted) === expected &&
		Number(first.source_events_inserted) === expected &&
		Number(first.target_events_inserted) === expected
	) {
		return;
	}
	if (plan.prospective && receipts.some((row) => row.issue_inserted !== 0)) {
		throw new Error('Issue create link batch partially committed');
	}
	const rejected = receipts.find(
		(row) =>
			row.endpoints_owned !== 1 ||
			row.duplicate_target_id !== null ||
			row.exact_exists === 1 ||
			row.cycle_exists === 1
	);
	if (!rejected) throw new Error('Issue create link batch skipped insertion without a reason');
	if (rejected.endpoints_owned !== 1) throw notFound();
	const diagnostics = diagnosticRows as unknown as PlanDiagnosticEdge[];
	const details = diagnosticDetails(diagnostics);
	const e2eDiagnostic =
		import.meta.env.VITE_TINES_E2E === '1'
			? {
					e2e_diagnostic: {
						returned_rows: diagnostics.length,
						response_bytes: new TextEncoder().encode(JSON.stringify(diagnostics)).length,
						rows_read: diagnosticResult?.meta?.rows_read
					}
				}
			: {};
	const source = details.get(rejected.source_issue_id);
	const target = details.get(rejected.target_issue_id);
	if (!source || !target) throw new Error('Issue create link diagnostic omitted an endpoint');
	const sourceRef = `${source.project_name}/${source.number}`;
	const targetRef = `${target.project_name}/${target.number}`;
	if (rejected.kind === 'duplicate_of' && rejected.duplicate_target_id) {
		const duplicateOf = details.get(rejected.duplicate_target_id);
		if (!duplicateOf) throw new Error('Issue create link diagnostic omitted the canonical issue');
		throw new ApiFail(
			422,
			'already_duplicate',
			`${sourceRef} is already a duplicate of ${duplicateOf.project_name}/${duplicateOf.number} — remove that link first`,
			{ duplicate_of: duplicateOf }
		);
	}
	if (rejected.exact_exists === 1) {
		throw new ApiFail(
			409,
			'conflict',
			`${sourceRef} already ${rejected.kind === 'blocks' ? 'blocks' : 'duplicates'} ${targetRef}`
		);
	}
	if (rejected.cycle_exists === 1) {
		const usable = diagnostics.filter(
			(edge) => edge.ordinal === null || Number(edge.ordinal) < Number(rejected.ordinal)
		);
		const backPath = findLinkPath(usable, rejected.target_issue_id, rejected.source_issue_id);
		if (!backPath) throw new Error('Issue create link diagnostic omitted the cycle path');
		const path = [rejected.source_issue_id, ...backPath].map((id) => details.get(id)!);
		const pretty = path.map((item) => `${item.project_name}/${item.number}`).join(' → ');
		throw new ApiFail(422, 'link_cycle', `Adding this link would create a cycle: ${pretty}`, {
			path,
			...e2eDiagnostic
		});
	}
	throw new Error('Issue create link batch skipped insertion without a recognized reason');
}

/** Same predicates as the commit guard, run early so ordinary rejects stage no R2 bytes. */
export async function preflightCreateIssueLinkPlan(
	db: Kysely<Database>,
	actor: ActorContext,
	plan: CreateIssueLinkPlan
): Promise<void> {
	const never: QueryGuard = { predicate: sql<boolean>`0` };
	const batch = createIssueLinkQueries(db, actor, plan, never);
	const receiptResult = await db.executeQuery<PlanReceipt>(batch.queries[batch.receiptIndex]);
	const rejected = receiptResult.rows.some(
		(row) =>
			Number(row.endpoints_owned) !== 1 ||
			row.duplicate_target_id !== null ||
			Number(row.exact_exists) === 1 ||
			Number(row.cycle_exists) === 1
	);
	if (!rejected) return;
	const diagnosticResult = await db.executeQuery<PlanDiagnosticEdge>(
		batch.queries[batch.diagnosticIndex]
	);
	const results = Array.from({ length: batch.queries.length }, () => ({
		results: []
	})) as unknown as Awaited<ReturnType<typeof runAtomic>>;
	results[batch.receiptIndex] = { results: receiptResult.rows } as (typeof results)[number];
	results[batch.diagnosticIndex] = {
		results: diagnosticResult.rows
	} as (typeof results)[number];
	assertCreateIssueLinksCommitted(plan, results, batch);
}

/** Recheck slow-upload preflight facts without reallocating plan ids. */
export async function recheckCreateIssueLinkPlan(
	db: Kysely<Database>,
	actor: ActorContext,
	plan: CreateIssueLinkPlan
): Promise<void> {
	const ids = plan.edges
		.flatMap((edge) => [edge.source_issue_id, edge.target_issue_id])
		.filter((id) => id !== plan.prospective!.id);
	const endpoints = await loadOwnedLinkEndpoints(db, actor, ids);
	const byId = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
	for (const id of ids) {
		const endpoint = byId.get(id);
		if (!endpoint) throw notFound();
		await assertWritable(db, actor, endpointProject(endpoint), { issueId: endpoint.id });
	}
	await preflightCreateIssueLinkPlan(db, actor, plan);
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
): CreateIssueLinkBatch & { plan: CreateIssueLinkPlan } {
	const plan: CreateIssueLinkPlan = {
		now,
		edges: [
			{
				ordinal: 0,
				field: 'issue_id',
				id,
				source_issue_id: source.id,
				target_issue_id: target.id,
				kind: kind === 'duplicate_of' ? 'duplicate_of' : 'blocks',
				source_event_id: newId('evt'),
				target_event_id: newId('evt')
			}
		]
	};
	return {
		...createIssueLinkQueries(db, actor, plan, createIssueLinkAdmissionGuard(actor, plan)),
		plan
	};
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

	const rows = await loadOwnedLinkEndpoints(db, actor, [issueId, otherId]);
	const issue = rows.find((r) => r.id === issueId);
	const other = rows.find((r) => r.id === otherId);
	// The addressed issue missing = 404 like any bad issue URL; the referenced
	// issue missing = 404 too (cross-user references must be indistinguishable
	// from nonexistent ones).
	if (!issue || !other) throw notFound();
	requireAccess(
		actor,
		[
			{ domain: 'project', access: 'write', projectId: issue.project_id },
			{ domain: 'project', access: 'write', projectId: other.project_id }
		],
		'issue_link.create',
		{ projectId: issue.project_id, issueId: issue.id }
	);
	// Both ends are gated: a draining run's exemption covers its own issue
	// only, so linking it to another issue in the archived project still 422s.
	await assertWritable(db, actor, endpointProject(issue), { issueId: issue.id });
	await assertWritable(db, actor, endpointProject(other), { issueId: other.id });

	// `blocked_by` is sugar: a `blocks` edge in the other direction, so
	// callers never reason about orientation.
	const kind: IssueLinkKind = kindInput === 'duplicate_of' ? 'duplicate_of' : 'blocks';
	const source = kindInput === 'blocked_by' ? other : issue;
	const target = kindInput === 'blocked_by' ? issue : other;

	const id = newId('lnk');
	const now = Date.now();
	const batch = addIssueLinkQueries(db, actor, source, target, kind, id, now);
	const results = await runAtomic(env, batch.queries);
	assertCreateIssueLinksCommitted(batch.plan, results, batch);
	effects.signalDispatch();
	return { id, kind, source_issue_id: source.id, target_issue_id: target.id, created_at: now };
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
	if (
		link &&
		actor.member &&
		(link.source_project_id !== actor.member.projectId ||
			link.target_project_id !== actor.member.projectId)
	)
		throw notFound();
	// Either endpoint's issue id addresses the link; anything else is a 404.
	if (!link || (link.source_issue_id !== issueId && link.target_issue_id !== issueId)) {
		throw notFound();
	}
	requireAccess(
		actor,
		[
			{ domain: 'project', access: 'write', projectId: link.source_project_id },
			{ domain: 'project', access: 'write', projectId: link.target_project_id }
		],
		'issue_link.remove',
		{
			projectId: link.source_issue_id === issueId ? link.source_project_id : link.target_project_id,
			issueId
		}
	);
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
