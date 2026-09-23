import {
	prUrlOf,
	renderTemplate,
	requirementFix,
	templateVars,
	type AllowedTransition,
	type ArchivedFilter,
	type ArrivedVia,
	type ArtifactType,
	type ArtifactRequirementCheck,
	type Comment,
	type CreateCommentRequest,
	type CreateIssueRequest,
	type CreateIssueResponse,
	type Issue,
	type IssueDetail,
	type IssueConsentReceipt,
	type IssueLabel,
	type IssueLinks,
	type IssueListItem,
	type IssueRef,
	type LinkedIssue,
	type ModelTier,
	type StateCategory,
	type TransitionIssueRequest,
	type UpdateCommentRequest,
	type UpdateIssueRequest,
	type WorkflowResponse,
	type WorkflowState
} from '@tines/shared';
import { sql, type CompiledQuery, type Kysely } from 'kysely';
import { IN_LIST_CHUNK, chunked, idChunks, newId, type Database } from '$lib/server/db';
import type { DispatchEffects } from '$lib/server/dispatch-effects';
import {
	ApiFail,
	notFound,
	optionalString,
	requireString,
	runAtomic,
	runKeyForbidden,
	type ActorContext,
	type Page
} from './core';
import { assertWritable, issueProject } from './archive';
import {
	artifactTypeOf,
	checkRequirements,
	listArtifacts,
	loadIssueVersions,
	requirementSpecLabel,
	versionQuery,
	initialFileArtifactQueries,
	type InitialIssueFile
} from './artifacts';
import { contextSummaryForIssue } from './context';
import { actorOf, eventInsert, eventQuery, serializeEvent } from './events';
import { deriveRound, deriveSinceLastRun } from './handoff';
import { issueLabelInserts, labelInserts, resolveOrCreateLabels } from './labels';
import { runQuery, serializeRun } from './runs';
import { requireTier } from './runners';
import { getSchedule, prepareSchedule, scheduleInsertQueries } from './schedules';
import { insertValues, type QueryGuard } from './query-guard';
import {
	assertCreateIssueLinksCommitted,
	createIssueLinkAdmissionGuard,
	createIssueLinkQueries,
	prepareCreateIssueLinkPlan,
	preflightCreateIssueLinkPlan,
	recheckCreateIssueLinkPlan
} from './issue-links';
import { substringMatch } from './search';
import { loadWorkflow, loadWorkflows } from './workflows';
import { nextIssueNumber } from '../issue-address';
import {
	assertConsentFieldsSupported,
	createProjectWriteGuard,
	readIssueConsent
} from './personal-consent';
import { releaseAssignedIssueQueries } from '../supervisor/consent-admission';

/**
 * SQL for the effective category of the blocker on a `blocks` edge into
 * `issue.id` — its own state's category unless it is a duplicate, then the
 * chain terminus's (via the `effective` CTE). Used both to list open
 * blockers and to filter for readiness.
 */
const openBlockerFrom = sql`
	FROM issue_link bl
	JOIN issue bi ON bi.id = bl.source_issue_id
	JOIN project bp ON bp.id = bi.project_id
	LEFT JOIN effective be ON be.issue_id = bi.id
	LEFT JOIN issue bei ON bei.id = be.effective_issue_id
	JOIN workflow_state bs ON bs.id = COALESCE(bei.state_id, bi.state_id)
	WHERE bl.target_issue_id = issue.id AND bl.kind = 'blocks' AND bs.category != 'done'`;

export function issueQuery(db: Kysely<Database>, userId: string) {
	return (
		db
			// Every hop along every duplicate chain. Cycles are rejected at write
			// time; the depth cap makes a racing cycle degrade to "resolution
			// stops" instead of unbounded recursion.
			.withRecursive('dup_chain', (cte) =>
				cte
					.selectFrom('issue_link')
					.where('issue_link.kind', '=', 'duplicate_of')
					.select([
						'issue_link.source_issue_id as issue_id',
						'issue_link.target_issue_id as next_id',
						sql<number>`1`.as('depth')
					])
					.unionAll(
						cte
							.selectFrom('dup_chain')
							.innerJoin('issue_link', (join) =>
								join
									.onRef('issue_link.source_issue_id', '=', 'dup_chain.next_id')
									.on('issue_link.kind', '=', 'duplicate_of')
							)
							.where('dup_chain.depth', '<', 32)
							.select([
								'dup_chain.issue_id as issue_id',
								'issue_link.target_issue_id as next_id',
								sql<number>`dup_chain.depth + 1`.as('depth')
							])
					)
			)
			// The chain terminus per duplicate: the hop whose target has no
			// further duplicate edge. One outgoing edge per issue + no cycles
			// ⇒ at most one row per issue_id.
			.with('effective', (cte) =>
				cte
					.selectFrom('dup_chain')
					.select(['dup_chain.issue_id', 'dup_chain.next_id as effective_issue_id'])
					.where(({ not, exists, selectFrom }) =>
						not(
							exists(
								selectFrom('issue_link')
									.select('issue_link.id')
									.whereRef('issue_link.source_issue_id', '=', 'dup_chain.next_id')
									.where('issue_link.kind', '=', 'duplicate_of')
							)
						)
					)
			)
			.selectFrom('issue')
			.innerJoin('project', 'project.id', 'issue.project_id')
			.innerJoin('workflow_state as state', 'state.id', 'issue.state_id')
			.leftJoin('effective', 'effective.issue_id', 'issue.id')
			.leftJoin('issue as eff_issue', 'eff_issue.id', 'effective.effective_issue_id')
			.leftJoin('workflow_state as eff_state', 'eff_state.id', 'eff_issue.state_id')
			.leftJoin('scheduled_task', 'scheduled_task.id', 'issue.scheduled_task_id')
			.leftJoin(
				'project as scheduled_task_project',
				'scheduled_task_project.id',
				'scheduled_task.project_id'
			)
			.leftJoin('runner as pin_runner', 'pin_runner.id', 'issue.pinned_runner_id')
			.selectAll('issue')
			.select([
				'project.name as project_name',
				'project.archived_at as project_archived_at',
				'state.name as state_name',
				'state.category as state_category',
				'state.position as state_position',
				'state.inherits_from_state_id as state_inherits_from',
				'scheduled_task.name as scheduled_task_name',
				'scheduled_task_project.id as scheduled_task_project_id',
				'scheduled_task_project.name as scheduled_task_project_name',
				'pin_runner.name as pinned_runner_name'
			])
			.select([
				sql<string>`COALESCE(eff_state.id, state.id)`.as('eff_state_id'),
				sql<string>`COALESCE(eff_state.name, state.name)`.as('eff_state_name'),
				sql<StateCategory>`COALESCE(eff_state.category, state.category)`.as('eff_state_category'),
				sql<number>`COALESCE(eff_state.position, state.position)`.as('eff_state_position'),
				sql<
					string | null
				>`COALESCE(eff_state.inherits_from_state_id, state.inherits_from_state_id)`.as(
					'eff_state_inherits_from'
				),
				sql<string | null>`(
					SELECT json_object('project_name', dp.name, 'number', di.number, 'title', di.title)
					FROM issue_link dl
					JOIN issue di ON di.id = dl.target_issue_id
					JOIN project dp ON dp.id = di.project_id
					WHERE dl.source_issue_id = issue.id AND dl.kind = 'duplicate_of'
				)`.as('duplicate_of_json'),
				sql<string | null>`(
					SELECT json_group_array(json_object('project_name', b.pn, 'number', b.num, 'title', b.t))
					FROM (
						SELECT bp.name AS pn, bi.number AS num, bi.title AS t ${openBlockerFrom}
						ORDER BY bi.created_at, bi.id
					) AS b
				)`.as('open_blockers_json'),
				// SQLite only honours ORDER BY inside json_group_array when the
				// ordering happens in a subquery, hence the nested SELECT.
				sql<string | null>`(
					SELECT json_group_array(json_object('id', l.id, 'name', l.name, 'color', l.color))
					FROM (
						SELECT lb.id, lb.name, lb.color
						FROM issue_label il
						JOIN label lb ON lb.id = il.label_id
						WHERE il.issue_id = issue.id AND lb.user_id = ${userId}
						ORDER BY lb.name COLLATE NOCASE
					) AS l
				)`.as('labels_json'),
				// The run currently holding the issue's exclusive claim (at most
				// one exists; LIMIT 1 guards against a racing double-claim).
				sql<string | null>`(
					SELECT json_object('run_id', ar.id, 'runner_name', arr.name, 'status', ar.status)
					FROM agent_run ar
					JOIN runner arr ON arr.id = ar.runner_id
					WHERE ar.issue_id = issue.id AND ar.status IN ('assigned', 'launching', 'running')
					ORDER BY ar.created_at DESC
					LIMIT 1
				)`.as('active_run_json'),
				// The handoff derivations below are for awaiting-human rows only
				// — SQLite short-circuits CASE, so active rows (and the dispatch
				// path's loadIssue) run neither subquery. Both hit event_issue_id_idx.
				//
				// The transition into the current state. The `created_at >=
				// state_entered_at` guard is what nulls this after a workflow
				// change, which re-stamps state_entered_at without transitioning.
				sql<
					string | null
				>`CASE WHEN COALESCE(eff_state.category, state.category) = 'awaiting_human' THEN (
					SELECT json_object(
						'action', json_extract(av.payload, '$.action'),
						'from_state_name', json_extract(av.payload, '$.from_state_name'),
						'by_run', avk.agent_run_id IS NOT NULL,
						'at', av.created_at)
					FROM event av
					LEFT JOIN api_key avk ON avk.id = av.actor_api_key_id
					WHERE av.issue_id = issue.id AND av.type = 'issue.transitioned'
						AND av.created_at >= COALESCE(issue.state_entered_at, issue.created_at)
					ORDER BY av.created_at DESC, av.id DESC
					LIMIT 1
				) END`.as('arrived_via_json'),
				// Where the current round starts: the last human-taken
				// transition, else the issue's creation. Feeds round_summary.
				sql<
					number | null
				>`CASE WHEN COALESCE(eff_state.category, state.category) = 'awaiting_human' THEN COALESCE((
					SELECT MAX(rb.created_at)
					FROM event rb
					LEFT JOIN api_key rbk ON rbk.id = rb.actor_api_key_id
					WHERE rb.issue_id = issue.id AND rb.type = 'issue.transitioned'
						AND (rb.actor_api_key_id IS NULL OR rbk.agent_run_id IS NULL)
				), issue.created_at) END`.as('round_boundary_at')
			])
			.select((eb) =>
				eb
					.selectFrom('event')
					.whereRef('event.issue_id', '=', 'issue.id')
					.select((eb2) => eb2.fn.max('event.created_at').as('m'))
					.as('last_event_at')
			)
			.where('project.user_id', '=', userId)
	);
}

type IssueRow = Awaited<ReturnType<ReturnType<typeof issueQuery>['execute']>>[number];

/** `by_run` crosses SQLite's JSON as 0/1; everything else is already shaped. */
function parseArrivedVia(json: string): ArrivedVia {
	const raw = JSON.parse(json) as Omit<ArrivedVia, 'by_run'> & { by_run: number | boolean };
	return { ...raw, by_run: Boolean(raw.by_run) };
}

export function serializeIssue(row: IssueRow): Issue {
	return {
		id: row.id,
		project_id: row.project_id,
		project_name: row.project_name,
		project_archived_at: row.project_archived_at,
		number: row.number,
		title: row.title,
		description: row.description,
		workflow_id: row.workflow_id,
		state: {
			id: row.state_id,
			name: row.state_name,
			category: row.state_category,
			position: row.state_position,
			inherits_from: row.state_inherits_from
		},
		effective_state: {
			id: row.eff_state_id,
			name: row.eff_state_name,
			category: row.eff_state_category,
			position: row.eff_state_position,
			inherits_from: row.eff_state_inherits_from
		},
		duplicate_of: row.duplicate_of_json ? (JSON.parse(row.duplicate_of_json) as IssueRef) : null,
		open_blockers: row.open_blockers_json ? (JSON.parse(row.open_blockers_json) as IssueRef[]) : [],
		labels: row.labels_json ? (JSON.parse(row.labels_json) as IssueLabel[]) : [],
		scheduled_task_id: row.scheduled_task_id,
		scheduled_task_name: row.scheduled_task_name,
		scheduled_task_project_id: row.scheduled_task_project_id,
		scheduled_task_project_name: row.scheduled_task_project_name,
		pinned_runner_id: row.pinned_runner_id,
		pinned_runner_name: row.pinned_runner_name,
		pinned_tier: row.pinned_tier as ModelTier | null,
		attempt_count: row.attempt_count,
		needs_attention: row.needs_attention === 1,
		active_run: row.active_run_json
			? (JSON.parse(row.active_run_json) as Issue['active_run'])
			: null,
		arrived_via: row.arrived_via_json ? parseArrivedVia(row.arrived_via_json) : null,
		// Backfilled with created_at by migration 0011; the fallback covers
		// rows inserted without the column (e.g. raw test fixtures).
		state_entered_at: Number(row.state_entered_at ?? row.created_at),
		created_at: row.created_at,
		updated_at: row.updated_at,
		last_activity_at: Number(row.last_event_at ?? row.created_at)
	};
}

/**
 * A list item without its description body. Descriptions are most of a list
 * payload (76% of a 50-issue page of this project), and list callers read
 * ref/title/state — so `brief=1` drops the key entirely rather than emptying it,
 * which keeps "absent" distinguishable from "the issue has no description".
 */
export function briefIssue(row: IssueRow): IssueListItem {
	const { description: _description, ...rest } = serializeIssue(row);
	return rest;
}

export interface IssueListFilters {
	project?: string;
	state?: string;
	category?: string;
	workflow?: string;
	/** Schedule id: only issues created by that scheduled task. */
	schedule?: string;
	hideDone?: boolean;
	/** Hide issues with an outgoing duplicate link. Defaults to true. */
	hideDuplicates?: boolean;
	/** Only not-done, non-duplicate issues whose blockers are all effectively done. */
	ready?: boolean;
	/** Restrict to one project id (the nested per-project route). */
	projectId?: string;
	/** Literal title/description substring search, case-insensitive for ASCII. */
	q?: string;
	/** Label names or ids; every one must be present (AND). */
	labels?: string[];
	/** Omit `description` from every item — the bulk of a list payload. */
	brief?: boolean;
	/**
	 * Archived projects' issues, when no project is named: `'false'` (the
	 * default) hides them, `'true'` shows only them, `'all'` shows both. A
	 * named project is listed whatever its state.
	 */
	archived?: ArchivedFilter;
}

/**
 * Every filter but the two the category tabs own (`category`, `hideDone`),
 * so a list and its per-category counts read the same population.
 */
type IssueQuery = ReturnType<typeof issueQuery>;

function applyScopeFilters(q: IssueQuery, userId: string, filters: IssueListFilters): IssueQuery {
	if (filters.projectId) q = q.where('issue.project_id', '=', filters.projectId);
	// An explicitly named project is listed whatever its state; without one,
	// archived projects drop out of every list by default.
	if (!filters.projectId && !filters.project) {
		if ((filters.archived ?? 'false') === 'false') q = q.where('project.archived_at', 'is', null);
		else if (filters.archived === 'true') q = q.where('project.archived_at', 'is not', null);
	}
	if (filters.project) {
		const p = filters.project;
		q = q.where((eb) => eb.or([eb('project.id', '=', p), eb('project.name', '=', p)]));
	}
	// State-shaped filters match the effective state, so duplicates follow
	// their canonical issue through every list (virtual passthrough).
	if (filters.state) {
		const s = filters.state;
		q = q.where(
			sql<boolean>`(COALESCE(eff_state.id, state.id) = ${s} OR COALESCE(eff_state.name, state.name) = ${s})`
		);
	}
	if (filters.workflow) {
		const w = filters.workflow;
		q = q.where((eb) =>
			eb.or([
				eb('issue.workflow_id', '=', w),
				eb(
					'issue.workflow_id',
					'in',
					eb
						.selectFrom('workflow')
						.select('id')
						.where('name', '=', w)
						// Only the user's own workflows (or the system one) can
						// match by name — never another user's.
						.where((eb2) => eb2.or([eb2('user_id', '=', userId), eb2('user_id', 'is', null)]))
				)
			])
		);
	}
	if (filters.schedule) q = q.where('issue.scheduled_task_id', '=', filters.schedule);
	// Ordinary issue lists omit duplicates by default. Ready uses the same
	// predicate even when callers explicitly include duplicates.
	if (filters.hideDuplicates !== false || filters.ready) {
		q = q.where(
			sql<boolean>`NOT EXISTS (SELECT 1 FROM issue_link dl WHERE dl.source_issue_id = issue.id AND dl.kind = 'duplicate_of')`
		);
	}
	if (filters.ready) {
		// Ready = effectively not done and no blocker still effectively open.
		// Duplicate exclusion is shared with the ordinary-list default above.
		q = q
			.where(sql<boolean>`COALESCE(eff_state.category, state.category) != 'done'`)
			.where(sql<boolean>`NOT EXISTS (SELECT 1 ${openBlockerFrom})`);
	}
	// One EXISTS per label, so repeated labels narrow rather than widen. An
	// unknown label simply matches nothing — reads never 422 on a filter.
	for (const ref of filters.labels ?? []) {
		q = q.where(
			sql<boolean>`EXISTS (
				SELECT 1 FROM issue_label il JOIN label l ON l.id = il.label_id
				WHERE il.issue_id = issue.id AND l.user_id = ${userId}
					AND (l.id = ${ref} OR l.name = ${ref} COLLATE NOCASE)
			)`
		);
	}
	if (filters.q) {
		const term = filters.q;
		q = q.where((eb) =>
			eb.or([
				substringMatch(eb.ref('issue.title'), term),
				substringMatch(eb.ref('issue.description'), term)
			])
		);
	}
	return q;
}

function applyCategoryFilters(q: IssueQuery, filters: IssueListFilters): IssueQuery {
	if (filters.category) {
		q = q.where(
			sql<boolean>`COALESCE(eff_state.category, state.category) = ${filters.category as StateCategory}`
		);
	}
	if (filters.hideDone) {
		q = q.where(sql<boolean>`COALESCE(eff_state.category, state.category) != 'done'`);
	}
	return q;
}

/**
 * How many issues each category holds under the given filters, ignoring
 * `category` and `hideDone` — the numbers a list's category tabs show, so a
 * tab's count is what clicking it will list. Categories with no issues are
 * present as 0.
 */
export async function countIssuesByCategory(
	db: Kysely<Database>,
	userId: string,
	filters: IssueListFilters
): Promise<Record<StateCategory, number>> {
	const rows = await applyScopeFilters(issueQuery(db, userId), userId, filters)
		.clearSelect()
		.select([
			sql<StateCategory>`COALESCE(eff_state.category, state.category)`.as('category'),
			sql<number>`COUNT(*)`.as('n')
		])
		.groupBy(sql`COALESCE(eff_state.category, state.category)`)
		.execute();
	const counts: Record<StateCategory, number> = {
		backlog: 0,
		active: 0,
		awaiting_human: 0,
		done: 0
	};
	for (const row of rows) if (row.category in counts) counts[row.category] = Number(row.n);
	return counts;
}

/** Open issue counts for every workflow in one focused project. */
export async function countOpenIssuesByWorkflow(
	db: Kysely<Database>,
	userId: string,
	projectId: string
): Promise<Record<string, number>> {
	const rows = await applyScopeFilters(issueQuery(db, userId), userId, { projectId })
		.clearSelect()
		.where(sql<boolean>`COALESCE(eff_state.category, state.category) != 'done'`)
		.select(['issue.workflow_id', sql<number>`COUNT(*)`.as('n')])
		.groupBy('issue.workflow_id')
		.execute();
	return Object.fromEntries(rows.map((row) => [row.workflow_id, Number(row.n)]));
}

export async function listIssues(
	db: Kysely<Database>,
	userId: string,
	filters: IssueListFilters,
	page: Page & { direction?: 'after' | 'before' }
): Promise<{ items: IssueListItem[]; hasMore: boolean }> {
	let q = applyCategoryFilters(applyScopeFilters(issueQuery(db, userId), userId, filters), filters);
	const backwards = page.direction === 'before';
	if (page.cursor) {
		const { createdAt, id } = page.cursor;
		q = q.where((eb) =>
			eb.or([
				eb('issue.created_at', backwards ? '>' : '<', createdAt),
				eb.and([eb('issue.created_at', '=', createdAt), eb('issue.id', backwards ? '>' : '<', id)])
			])
		);
	}
	const rows = await q
		.orderBy('issue.created_at', backwards ? 'asc' : 'desc')
		.orderBy('issue.id', backwards ? 'asc' : 'desc')
		.limit(page.limit + 1)
		.execute();
	const serialize = filters.brief ? briefIssue : serializeIssue;
	const pageRows = rows.slice(0, page.limit);
	if (backwards) pageRows.reverse();
	const items = pageRows.map(serialize);
	await attachRoundSummaries(db, userId, pageRows, items);
	return { items, hasMore: rows.length > page.limit };
}

/**
 * `round_summary` on the awaiting-human rows of one page: what the round that
 * just ended produced, so the Awaiting list can say "impl-pr v2 · PR #78"
 * without a read per row. A page with no awaiting row issues no statement.
 */
async function attachRoundSummaries(
	db: Kysely<Database>,
	userId: string,
	rows: IssueRow[],
	items: IssueListItem[]
): Promise<void> {
	const awaiting = rows
		.map((row, i) => ({ row, i }))
		.filter(({ row }) => row.eff_state_category === 'awaiting_human');
	for (const item of items) item.round_summary = null;
	if (awaiting.length === 0) return;

	// Each awaiting row binds two parameters (issue id, round boundary), and a
	// page is up to 100 rows — an all-awaiting page such as the Awaiting tab
	// would bind 200, twice D1's cap, so the rows are queried in chunks.
	const versions = (
		await Promise.all(
			chunked(awaiting, Math.floor(IN_LIST_CHUNK / 2)).map((chunk) =>
				versionQuery(db)
					.innerJoin('context_item', 'context_item.id', 'artifact_version.context_item_id')
					.select([
						'context_item.issue_id as item_issue_id',
						'context_item.name as item_name',
						'context_item.config as item_config'
					])
					.where('context_item.user_id', '=', userId)
					.where('context_item.kind', '=', 'artifact')
					.where((eb) =>
						eb.or(
							chunk.map(({ row }) =>
								eb.and([
									eb('context_item.issue_id', '=', row.id),
									eb(
										'artifact_version.created_at',
										'>',
										Number(row.round_boundary_at ?? row.created_at)
									)
								])
							)
						)
					)
					.orderBy('artifact_version.created_at asc')
					.execute()
			)
		)
	).flat();

	for (const { row, i } of awaiting) {
		// Attribution by run id, and only runs on this issue: a version a run on
		// another issue attached here is not part of this issue's round.
		const mine = versions.filter(
			(v) =>
				v.item_issue_id === row.id && v.actor_run_id !== null && v.actor_run_issue_id === row.id
		);
		const byName = new Map<
			string,
			{ name: string; artifact_type: ArtifactType; version: number }
		>();
		let prUrl: string | null = null;
		for (const v of mine) {
			const seen = byName.get(v.item_name);
			if (!seen || v.version > seen.version) {
				byName.set(v.item_name, {
					name: v.item_name,
					artifact_type: artifactTypeOf(v.item_config),
					version: v.version
				});
			}
			prUrl = prUrlOf(v) ?? prUrl;
		}
		items[i].round_summary = {
			pr_url: prUrl,
			artifacts: [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1))
		};
	}
}

// ---------------------------------------------------------------------------
// Detail

export function allowedTransitions(
	workflow: WorkflowResponse,
	fromStateId: string
): AllowedTransition[] {
	const stateById = new Map(workflow.states.map((s) => [s.id, s]));
	return workflow.transitions
		.filter((t) => t.from_state_id === fromStateId)
		.flatMap((t) => {
			const toState = stateById.get(t.to_state_id);
			return toState ? [{ transition_id: t.id, name: t.name, to_state: toState }] : [];
		});
}

/** Resolves a state reference (id or name) within a workflow, or 422s. */
export function resolveStateRef(
	workflow: WorkflowResponse,
	ref: string,
	field = 'state'
): WorkflowState {
	const state =
		workflow.states.find((s) => s.id === ref) ?? workflow.states.find((s) => s.name === ref);
	if (!state) {
		throw new ApiFail(422, 'unknown_state', `Workflow "${workflow.name}" has no state "${ref}"`, {
			field,
			known_states: workflow.states.map((s) => ({ id: s.id, name: s.name }))
		});
	}
	return state;
}

async function loadCommentHistory(db: Kysely<Database>, issueId: string) {
	const rows = await db
		.selectFrom('comment')
		.innerJoin('user as actor_user', 'actor_user.id', 'comment.actor_user_id')
		.leftJoin('api_key', 'api_key.id', 'comment.actor_api_key_id')
		// Run-key attribution (see eventQuery for the rendering these feed).
		.leftJoin('agent_run as actor_run', 'actor_run.id', 'api_key.agent_run_id')
		.leftJoin('runner as actor_runner', 'actor_runner.id', 'actor_run.runner_id')
		.leftJoin('issue as actor_run_issue', 'actor_run_issue.id', 'actor_run.issue_id')
		.leftJoin('project as actor_run_project', 'actor_run_project.id', 'actor_run_issue.project_id')
		.selectAll('comment')
		.select([
			'actor_user.name as actor_user_name',
			'api_key.name as actor_api_key_name',
			'actor_run.id as actor_run_id',
			'actor_runner.name as actor_runner_name',
			'api_key.run_workflow_name as actor_run_workflow_name',
			'api_key.run_state_name as actor_run_state_name',
			'actor_run_project.name as actor_run_project_name',
			'actor_run_issue.number as actor_run_issue_number',
			'actor_run.issue_id as actor_run_issue_id',
			'actor_run.status as actor_run_status',
			'actor_run.created_at as actor_run_created_at'
		])
		.where('comment.issue_id', '=', issueId)
		.orderBy('comment.created_at asc')
		.orderBy('comment.id asc')
		.execute();
	const comments = rows.map((row) => ({
		id: row.id,
		issue_id: row.issue_id,
		body: row.body,
		actor: actorOf(row),
		created_at: row.created_at,
		updated_at: row.updated_at
	}));
	let selectedRun: { id: string; createdAt: number } | null = null;
	for (const row of rows) {
		if (
			row.actor_run_id === null ||
			row.actor_run_issue_id !== issueId ||
			row.actor_run_status !== 'completed' ||
			row.actor_run_created_at === null
		)
			continue;
		if (
			selectedRun === null ||
			row.actor_run_created_at > selectedRun.createdAt ||
			(row.actor_run_created_at === selectedRun.createdAt && row.actor_run_id > selectedRun.id)
		)
			selectedRun = { id: row.actor_run_id, createdAt: row.actor_run_created_at };
	}
	const latestCompletedRunCommentId = selectedRun
		? ([...rows].reverse().find((row) => row.actor_run_id === selectedRun!.id)?.id ?? null)
		: null;
	return { comments, latestCompletedRunCommentId };
}

async function loadComments(db: Kysely<Database>, issueId: string): Promise<Comment[]> {
	return (await loadCommentHistory(db, issueId)).comments;
}

/**
 * All four link groups for an issue, pre-joined for display. Link rows are
 * not user-scoped here (links only ever connect one user's issues, and the
 * linked-issue lookup below is scoped), sorted oldest link first.
 */
export async function loadIssueLinks(
	db: Kysely<Database>,
	userId: string,
	issueId: string
): Promise<IssueLinks> {
	const rows = await db
		.selectFrom('issue_link')
		.selectAll()
		.where((eb) =>
			eb.or([eb('source_issue_id', '=', issueId), eb('target_issue_id', '=', issueId)])
		)
		.orderBy('created_at asc')
		.orderBy('id asc')
		.execute();

	const otherIds = [
		...new Set(
			rows.map((l) => (l.source_issue_id === issueId ? l.target_issue_id : l.source_issue_id))
		)
	];
	const others =
		otherIds.length === 0
			? []
			: (
					await Promise.all(
						idChunks(otherIds).map((chunk) =>
							issueQuery(db, userId).where('issue.id', 'in', chunk).execute()
						)
					)
				).flat();
	const byId = new Map(others.map((r) => [r.id, serializeIssue(r)]));

	const links: IssueLinks = { blocked_by: [], blocks: [], duplicate_of: null, duplicated_by: [] };
	for (const row of rows) {
		const otherId = row.source_issue_id === issueId ? row.target_issue_id : row.source_issue_id;
		const other = byId.get(otherId);
		if (!other) continue;
		const linked: LinkedIssue = {
			link_id: row.id,
			issue_id: other.id,
			project_name: other.project_name,
			number: other.number,
			title: other.title,
			effective_state: other.effective_state
		};
		if (row.kind === 'blocks') {
			if (row.source_issue_id === issueId) links.blocks.push(linked);
			else links.blocked_by.push(linked);
		} else {
			if (row.source_issue_id === issueId) links.duplicate_of = linked;
			else links.duplicated_by.push(linked);
		}
	}
	return links;
}

/**
 * How to find an issue. `projectName` is the URL shape: it is resolved in the
 * *same* statement as the issue row rather than in a lookup wave of its own.
 * (Names are unique per user; the ordering is belt-and-braces.)
 */
export type IssueLookup =
	{ id: string } | { projectId: string; number: number } | { projectName: string; number: number };

/** The issue row alone: one statement, no fan-out. */
export async function loadIssue(
	db: Kysely<Database>,
	userId: string,
	ref: IssueLookup
): Promise<Issue> {
	let q = issueQuery(db, userId);
	if ('id' in ref) q = q.where('issue.id', '=', ref.id);
	else if ('projectId' in ref)
		q = q.where(({ exists, selectFrom }) =>
			exists(
				selectFrom('issue_address')
					.select('issue_address.issue_id')
					.whereRef('issue_address.issue_id', '=', 'issue.id')
					.where('issue_address.project_id', '=', ref.projectId)
					.where('issue_address.number', '=', ref.number)
			)
		);
	else
		q = q.where(({ exists, selectFrom }) =>
			exists(
				selectFrom('issue_address')
					.innerJoin('project as address_project', 'address_project.id', 'issue_address.project_id')
					.select('issue_address.issue_id')
					.whereRef('issue_address.issue_id', '=', 'issue.id')
					.where('address_project.user_id', '=', userId)
					.where('address_project.name', '=', ref.projectName)
					.where('issue_address.number', '=', ref.number)
			)
		);
	const row = await q.executeTakeFirst();
	if (!row) throw notFound();
	return serializeIssue(row);
}

export interface IssueDetailOptions {
	/** Include metadata used only by launch-prompt comment selection. */
	launchComments?: boolean;
	/**
	 * Every workflow the user can see, when the caller already has (or is
	 * already fetching) them — saves the two-statement `loadWorkflow`. A promise
	 * is fine and preferred: it is awaited alongside comments/links/context, so
	 * an in-flight `loadWorkflows` costs no extra round-trip wave.
	 */
	workflows?: WorkflowResponse[] | Promise<WorkflowResponse[]>;
	/**
	 * Include the issue's artifacts on the result. Off by default so API
	 * responses keep their current shape; the issue page needs them for its
	 * artifacts panel and would otherwise fetch them a second time.
	 */
	artifacts?: boolean;
	/**
	 * Derive `round` and `since_last_run` — the handoff. Off by default:
	 * `getIssueDetail` sits on every mutation's return path, and this costs
	 * three more reads. The four read paths (the issue endpoints, the prompt
	 * route and the runner's prompt delivery) opt in.
	 */
	round?: boolean;
}

/** "Project/42" — the ref an agent types, and the one the fix commands quote. */
function issueRef(issue: Pick<Issue, 'project_name' | 'number'>): string {
	return `${issue.project_name}/${issue.number}`;
}

export async function getIssueDetail(
	db: Kysely<Database>,
	userId: string,
	ref: IssueLookup | Issue,
	opts: IssueDetailOptions = {}
): Promise<IssueDetail> {
	// An already-loaded issue can be passed straight in (the page resolves the
	// row first so everything below it starts in one wave).
	const issue = 'workflow_id' in ref ? ref : await loadIssue(db, userId, ref);

	// Artifacts are needed unconditionally when the caller asked for them, and
	// otherwise only if some outgoing transition declares requirements — which
	// we cannot know until the workflow lands. Fetching them in this wave when
	// asked keeps the requirement pre-flight off the critical path entirely.
	const [workflows, commentHistory, links, contextSummary, preloadedArtifacts, handoff] =
		await Promise.all([
			opts.workflows ?? loadWorkflows(db, userId, issue.workflow_id),
			loadCommentHistory(db, issue.id),
			loadIssueLinks(db, userId, issue.id),
			contextSummaryForIssue(db, userId, {
				projectId: issue.project_id,
				stateId: issue.state.id,
				issueId: issue.id
			}),
			opts.artifacts ? listArtifacts(db, userId, issue.id) : null,
			opts.round ? loadHandoffRows(db, userId, issue.id) : null
		]);
	const comments = commentHistory.comments;

	const workflow = workflows.find((w) => w.id === issue.workflow_id);
	if (!workflow) throw notFound();

	// Pre-flight requirement visibility: each allowed transition's declared
	// requirements with live status. The artifact load only happens when some
	// outgoing transition actually declares requirements (a handful of rows).
	const transitionById = new Map(workflow.transitions.map((t) => [t.id, t]));
	let allowed = allowedTransitions(workflow, issue.state.id);
	if (allowed.some((t) => (transitionById.get(t.transition_id)?.requires ?? []).length > 0)) {
		const artifacts = preloadedArtifacts ?? (await listArtifacts(db, userId, issue.id));
		allowed = allowed.map((t) => {
			const requires = transitionById.get(t.transition_id)?.requires;
			return requires?.length
				? { ...t, requires: checkRequirements(requires, artifacts, issueRef(issue)) }
				: t;
		});
	}

	return {
		...issue,
		workflow,
		comments,
		allowed_transitions: allowed,
		links,
		context_summary: contextSummary,
		...(preloadedArtifacts ? { artifacts: preloadedArtifacts } : {}),
		...(opts.launchComments
			? {
					launch_comments: {
						latest_completed_run_comment_id: commentHistory.latestCompletedRunCommentId
					}
				}
			: {}),
		...(handoff
			? {
					round: deriveRound({ issue, workflow, comments, ...handoff }),
					since_last_run: deriveSinceLastRun({ issue, comments, ...handoff })
				}
			: {})
	};
}

/** How many runs of an issue's history the round derivation reads back. */
const ROUND_RUN_CAP = 50;

/**
 * The three extra reads the handoff derivations need. Issued inside
 * `getIssueDetail`'s existing wave, so opting in costs no round trip.
 */
async function loadHandoffRows(db: Kysely<Database>, userId: string, issueId: string) {
	const [eventRows, runRows, versions] = await Promise.all([
		eventQuery(db, userId)
			.where('event.issue_id', '=', issueId)
			.where('event.type', '=', 'issue.transitioned')
			.orderBy('event.created_at asc')
			.orderBy('event.id asc')
			.execute(),
		runQuery(db, userId)
			.where('agent_run.issue_id', '=', issueId)
			.orderBy('agent_run.created_at desc')
			.limit(ROUND_RUN_CAP)
			.execute(),
		loadIssueVersions(db, userId, issueId)
	]);
	return { events: eventRows.map(serializeEvent), runs: runRows.map(serializeRun), versions };
}

// ---------------------------------------------------------------------------
// Mutations

/**
 * The issue row plus its `issue.created` event, as statements — so numbering
 * and the event payload have one definition whether the issue is created on
 * its own, by a schedule, or spliced into a project-creation batch by a
 * starter (Tines/248).
 */
export function issueInsertQueries(
	db: Kysely<Database>,
	actor: ActorContext,
	opts: {
		id: string;
		projectId: string;
		title: string;
		description: string;
		workflowId: string;
		workflowName: string;
		stateId: string;
		stateName: string;
		stateCategory: StateCategory;
		now: number;
		scheduledTask?: { id: string; name: string };
		guard?: QueryGuard;
		eventGuard?: QueryGuard;
	}
): CompiledQuery[] {
	const { id, projectId, workflowId, stateId, now, scheduledTask } = opts;
	return [
		// The permanent ledger prevents reuse after the highest issue moves away.
		insertValues(
			db,
			'issue',
			{
				id,
				project_id: projectId,
				number: nextIssueNumber(projectId) as unknown as number,
				title: opts.title,
				description: opts.description,
				workflow_id: workflowId,
				state_id: stateId,
				scheduled_task_id: scheduledTask?.id ?? null,
				pinned_runner_id: null,
				pinned_tier: null,
				attempt_count: 0,
				needs_attention: 0,
				state_entered_at: now,
				created_at: now,
				updated_at: now,
				project_assignment_token: ''
			},
			opts.guard
		),
		eventInsert(
			db,
			actor,
			{
				type: 'issue.created',
				issueId: id,
				projectId,
				payload: {
					state_entry_version: 1,
					title: opts.title,
					workflow_id: workflowId,
					workflow_name: opts.workflowName,
					state_id: stateId,
					state_name: opts.stateName,
					state_category: opts.stateCategory,
					...(scheduledTask
						? { scheduled_task_id: scheduledTask.id, scheduled_task_name: scheduledTask.name }
						: {})
				}
			},
			opts.eventGuard ?? opts.guard
		)
	];
}

export async function createIssue(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	effects: DispatchEffects,
	projectId: string,
	body: CreateIssueRequest,
	initialFiles: InitialIssueFile[] = [],
	beforeCommit?: () => Promise<void>
): Promise<CreateIssueResponse> {
	assertConsentFieldsSupported(actor, body, ['allow_my_agents', 'disclosure_version']);
	if (
		body.disclosure_version !== undefined &&
		(!Number.isInteger(body.disclosure_version) || body.disclosure_version < 1)
	) {
		throw new ApiFail(422, 'invalid_field', '"disclosure_version" must be a positive integer', {
			field: 'disclosure_version'
		});
	}
	if (body.disclosure_version !== undefined && body.allow_my_agents !== true) {
		throw new ApiFail(
			422,
			'invalid_field',
			'Disclosure is acknowledged only with an explicit permission choice',
			{
				field: 'disclosure_version'
			}
		);
	}
	const project = await db
		.selectFrom('project')
		.selectAll()
		.where('id', '=', projectId)
		.where('user_id', '=', actor.userId)
		.executeTakeFirst();
	if (!project) throw notFound();
	// Creating issues (and the schedules that ride along) is a project-level
	// write: no draining run is exempt from it.
	await assertWritable(db, actor, project);
	if (
		body.expected_sharing_revision !== undefined &&
		body.expected_sharing_revision !== project.sharing_revision
	) {
		throw new ApiFail(
			409,
			'conflict',
			'Project sharing changed; refresh before creating the issue',
			{
				committed: false,
				current_sharing_revision: project.sharing_revision
			}
		);
	}

	const title = requireString(body.title, 'title', { max: 500 }).trim();
	const description = optionalString(body.description, 'description') ?? '';

	const workflowId = body.workflow_id ?? project.default_workflow_id ?? 'wf_standard';
	const workflow = await loadWorkflow(db, actor.userId, workflowId).catch(() => {
		throw new ApiFail(422, 'unknown_workflow', `Workflow "${workflowId}" does not exist`, {
			field: 'workflow_id'
		});
	});
	const initialState = body.state
		? resolveStateRef(workflow, requireString(body.state, 'state', { max: 100 }).trim())
		: resolveStateRef(workflow, workflow.initial_state_id);
	if (body.allow_my_agents !== undefined) {
		if (!actor.viaSession) {
			throw new ApiFail(
				403,
				'consent_browser_required',
				'Personal permission must be chosen in the browser'
			);
		}
		if (project.shared_at === null) {
			throw new ApiFail(
				409,
				'sharing_not_active',
				'Personal permission is available after project sharing begins'
			);
		}
		if (body.allow_my_agents && initialState.category !== 'active') {
			throw new ApiFail(
				422,
				'permission_state_invalid',
				'Permission can be enabled only when the issue starts in an active state'
			);
		}
	}

	// Resolved before anything is inserted, so a run key's unknown label 422s
	// without leaving a half-created issue behind.
	const resolvedLabels = body.labels?.length
		? await resolveOrCreateLabels(db, actor, body.labels)
		: null;

	const now = Date.now();
	const id = newId('iss');

	// With a recurrence, the title/description double as the schedule's
	// templates: the first issue is created immediately (placeholders
	// rendered) and the schedule takes over from there.
	const schedule = body.schedule
		? await prepareSchedule(db, projectId, body.schedule, title, now)
		: null;
	const vars = schedule ? templateVars(schedule.name, 1, schedule.timezone, now) : null;
	const issueTitle = vars ? renderTemplate(title, vars) : title;
	const issueDescription = vars ? renderTemplate(description, vars) : description;
	const linkPlan = await prepareCreateIssueLinkPlan(
		db,
		actor,
		{ id, projectId, title: issueTitle },
		body,
		now
	);
	if (linkPlan) await preflightCreateIssueLinkPlan(db, actor, linkPlan);

	// A non-initial starting state pins the schedule too: future instances
	// start where the first issue does. NULL keeps following the workflow's
	// initial state.
	const scheduleStateId = initialState.id === workflow.initial_state_id ? null : initialState.id;

	const queries: CompiledQuery[] = [];
	const projectGuard = createProjectWriteGuard(actor, projectId, project.sharing_revision);
	const linkGuard = linkPlan ? createIssueLinkAdmissionGuard(actor, linkPlan) : undefined;
	const admissionGuard: QueryGuard = {
		predicate: sql<boolean>`${projectGuard.predicate} AND ${linkGuard?.predicate ?? sql<boolean>`1`}`
	};
	const freshIssueGuard: QueryGuard = {
		predicate: sql<boolean>`EXISTS (SELECT 1 FROM issue WHERE id = ${id} AND project_id = ${projectId})
			AND ${projectGuard.predicate}`
	};
	const scheduleQueries = schedule
		? scheduleInsertQueries(db, actor, {
				schedule,
				projectId,
				workflowId: workflow.id,
				stateId: scheduleStateId,
				stateName: initialState.name,
				titleTemplate: title,
				descriptionTemplate: description,
				now,
				mode: 'initial-issue',
				guard: admissionGuard,
				eventGuard: freshIssueGuard
			})
		: null;
	if (scheduleQueries) queries.push(scheduleQueries[0]);
	queries.push(
		...issueInsertQueries(db, actor, {
			id,
			projectId,
			title: issueTitle,
			description: issueDescription,
			workflowId: workflow.id,
			workflowName: workflow.name,
			stateId: initialState.id,
			stateName: initialState.name,
			stateCategory: initialState.category,
			now,
			guard: admissionGuard,
			eventGuard: freshIssueGuard,
			...(schedule ? { scheduledTask: { id: schedule.id, name: schedule.name } } : {})
		})
	);
	if (scheduleQueries) queries.push(scheduleQueries[1]);
	if (resolvedLabels) {
		queries.push(
			...labelInserts(db, actor, resolvedLabels.toCreate, freshIssueGuard),
			...issueLabelInserts(
				db,
				actor,
				{ id, project_id: projectId },
				resolvedLabels.labels,
				now,
				freshIssueGuard
			)
		);
	}
	if (initialFiles.length > 0) {
		queries.push(
			...(await initialFileArtifactQueries(
				db,
				env,
				actor,
				{ id, projectId },
				initialFiles,
				now,
				freshIssueGuard
			))
		);
		const currentProject = await db
			.selectFrom('project')
			.selectAll()
			.where('id', '=', projectId)
			.where('user_id', '=', actor.userId)
			.executeTakeFirst();
		if (!currentProject) throw notFound();
		await assertWritable(db, actor, currentProject);
		if (currentProject.sharing_revision !== project.sharing_revision) {
			throw new ApiFail(
				409,
				'conflict',
				'Project sharing changed while files were staged; refresh and retry',
				{
					committed: false,
					current_sharing_revision: currentProject.sharing_revision
				}
			);
		}
		if (linkPlan) await recheckCreateIssueLinkPlan(db, actor, linkPlan);
	}
	if (body.allow_my_agents !== undefined) {
		queries.push(
			sql`INSERT INTO issue_personal_choice
				(issue_id, user_id, value, revision, issue_epoch, membership_revision, source_kind, updated_at)
			SELECT ${id}, ${actor.userId}, ${body.allow_my_agents ? 'on' : 'off'}, 1,
				i.consent_epoch, 0, 'explicit_issue', ${now}
			FROM issue i JOIN project p ON p.id = i.project_id
			WHERE i.id = ${id} AND p.user_id = ${actor.userId}
				AND p.shared_at IS NOT NULL AND p.sharing_revision = ${project.sharing_revision}
				AND ${freshIssueGuard.predicate}`.compile(db),
			eventInsert(
				db,
				actor,
				{
					type: 'issue.personal_permission_changed',
					issueId: id,
					projectId,
					payload: { value: body.allow_my_agents ? 'on' : 'off', revision: 1 }
				},
				freshIssueGuard
			)
		);
		if (body.disclosure_version !== undefined) {
			queries.push(
				db
					.insertInto('personal_disclosure')
					.values({ user_id: actor.userId, version: body.disclosure_version, acknowledged_at: now })
					.onConflict((oc) => oc.columns(['user_id', 'version']).doNothing())
					.compile()
			);
		}
	}
	let linkBatch: ReturnType<typeof createIssueLinkQueries> | null = null;
	let linkBatchOffset = 0;
	if (linkPlan && freshIssueGuard) {
		linkBatch = createIssueLinkQueries(db, actor, linkPlan, freshIssueGuard);
		linkBatchOffset = queries.length;
		queries.push(...linkBatch.queries);
	}
	if (beforeCommit) await beforeCommit();
	const results = await runAtomic(env, queries);
	if (linkPlan && linkBatch) {
		assertCreateIssueLinksCommitted(linkPlan, results, linkBatch, linkBatchOffset);
	}
	effects.signalDispatch();

	const issue = await getIssueDetail(db, actor.userId, { id });
	const response: CreateIssueResponse = schedule
		? { ...issue, schedule: await getSchedule(db, actor.userId, schedule.id) }
		: issue;
	if (project.shared_at !== null) {
		response.permission_receipt = {
			...(await readIssueConsent(db, actor.userId, id)),
			actor: actor.viaSession ? 'owner' : 'key',
			...(actor.viaSession
				? {}
				: { message: 'Permission unchanged; manage your permission in the browser.' })
		};
	}
	return response;
}

/**
 * Field-level run-key guards on the issue PATCH (the route itself stays
 * run-key-legal — title/description authority remains):
 *
 * - A pin replaces routing-rule matching entirely, so it is re-route-work
 *   power: control plane.
 * - The forced `state` set (and the `workflow_id` change that re-seats the
 *   state) bypasses transition validation, artifact requirements included —
 *   an agent must not be able to route around its own gate, so the escape
 *   hatch is human/named-key only.
 */
export function assertPinFieldsAllowed(
	actor: Pick<ActorContext, 'agentRunId'>,
	body: Pick<UpdateIssueRequest, 'pinned_runner_id' | 'pinned_tier' | 'state' | 'workflow_id'>
): void {
	if (!actor.agentRunId) return;
	if (
		body.pinned_runner_id === undefined &&
		body.pinned_tier === undefined &&
		body.state === undefined &&
		body.workflow_id === undefined
	) {
		return;
	}
	throw runKeyForbidden();
}

export async function updateIssue(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	effects: DispatchEffects,
	id: string,
	body: UpdateIssueRequest
): Promise<IssueDetail> {
	assertConsentFieldsSupported(actor, body);
	assertPinFieldsAllowed(actor, body);
	const current = await getIssueDetail(db, actor.userId, { id });
	await assertWritable(db, actor, issueProject(current), { issueId: current.id });
	const title =
		body.title !== undefined
			? requireString(body.title, 'title', { max: 500 }).trim()
			: current.title;
	const description =
		body.description !== undefined
			? (optionalString(body.description, 'description') ?? '')
			: current.description;

	// Workflow move and forced state set: the escape hatch beside
	// transitionIssue's guarded moves.
	let workflow = current.workflow;
	if (body.workflow_id !== undefined) {
		const ref = requireString(body.workflow_id, 'workflow_id', { max: 100 }).trim();
		if (ref !== current.workflow.id) {
			workflow = await loadWorkflow(db, actor.userId, ref).catch(() => {
				throw new ApiFail(422, 'unknown_workflow', `Workflow "${ref}" does not exist`, {
					field: 'workflow_id'
				});
			});
		}
	}
	const workflowChanged = workflow.id !== current.workflow.id;
	let nextState = current.state;
	if (body.state !== undefined) {
		nextState = resolveStateRef(workflow, requireString(body.state, 'state', { max: 100 }).trim());
	} else if (workflowChanged) {
		nextState = resolveStateRef(workflow, workflow.initial_state_id);
	}
	const stateChanged = nextState.id !== current.state.id;

	// Pin merge-patch: omitted = unchanged, explicit null = unpin. The tier
	// belongs to the pin, so unpinning clears it and it cannot be set alone.
	let pinnedRunnerId = current.pinned_runner_id;
	let pinnedRunnerName = current.pinned_runner_name;
	if (body.pinned_runner_id !== undefined) {
		if (body.pinned_runner_id === null) {
			pinnedRunnerId = null;
			pinnedRunnerName = null;
		} else {
			const ref = requireString(body.pinned_runner_id, 'pinned_runner_id', { max: 100 });
			const runner = await db
				.selectFrom('runner')
				.select(['id', 'name'])
				.where('id', '=', ref)
				.where('user_id', '=', actor.userId)
				.executeTakeFirst();
			if (!runner) {
				throw new ApiFail(422, 'unknown_runner', `Runner "${ref}" does not exist`, {
					field: 'pinned_runner_id'
				});
			}
			pinnedRunnerId = runner.id;
			pinnedRunnerName = runner.name;
		}
	}
	let pinnedTier = current.pinned_tier;
	if (body.pinned_tier !== undefined) {
		pinnedTier = body.pinned_tier === null ? null : requireTier(body.pinned_tier, 'pinned_tier');
	}
	if (pinnedRunnerId === null) {
		if (pinnedTier !== null && body.pinned_tier !== undefined) {
			throw new ApiFail(422, 'invalid_field', '"pinned_tier" needs a pinned runner', {
				field: 'pinned_tier'
			});
		}
		pinnedTier = null;
	}
	const pinChanged =
		pinnedRunnerId !== current.pinned_runner_id || pinnedTier !== current.pinned_tier;

	const changed: string[] = [];
	if (title !== current.title) changed.push('title');
	if (description !== current.description) changed.push('description');
	if (workflowChanged) changed.push('workflow');
	if (pinChanged) changed.push('pin');
	if (changed.length === 0 && !stateChanged) {
		effects.signalDispatch();
		return current;
	}

	// Compare-and-swap on the state whenever it (or the workflow) moves, so a
	// concurrent transition can't be silently overwritten; the events are
	// guarded on the same write landing.
	const now = Date.now();
	const guarded = stateChanged || workflowChanged;
	let update = db
		.updateTable('issue')
		.set({
			// This is a merge patch: only assign values that this request actually
			// changed. Writing snapshot values for omitted fields lets an unrelated
			// concurrent update get silently reverted.
			...(title !== current.title ? { title } : {}),
			...(description !== current.description ? { description } : {}),
			...(workflowChanged ? { workflow_id: workflow.id } : {}),
			...(stateChanged || workflowChanged ? { state_id: nextState.id } : {}),
			...(pinChanged ? { pinned_runner_id: pinnedRunnerId, pinned_tier: pinnedTier } : {}),
			updated_at: now,
			// Every path that changes state_id stamps state_entered_at — the
			// timestamp artifact freshness is measured against. A workflow
			// change re-seats the state, so it stamps too.
			...(stateChanged || workflowChanged ? { state_entered_at: now } : {}),
			// Any non-run-key state move is a "manual" transition: it un-parks
			// the issue and restarts the attempt budget.
			...(stateChanged && !actor.agentRunId ? { needs_attention: 0, attempt_count: 0 } : {})
		})
		.where('id', '=', id);
	if (guarded) update = update.where('state_id', '=', current.state.id);
	const guard = guarded ? { issueId: id, stateId: nextState.id, updatedAt: now } : undefined;

	const queries: CompiledQuery[] = [update.compile()];
	if (changed.length > 0) {
		const payload: Record<string, unknown> = { changed, title };
		if (pinChanged) {
			payload.pinned_runner_id = pinnedRunnerId;
			payload.pinned_runner_name = pinnedRunnerName;
			payload.pinned_tier = pinnedTier;
		}
		if (workflowChanged) {
			payload.state_entry_version = 1;
			payload.workflow_from_id = current.workflow.id;
			payload.workflow_from_name = current.workflow.name;
			payload.workflow_to_id = workflow.id;
			payload.workflow_to_name = workflow.name;
			payload.from_state_id = current.state.id;
			payload.from_state_name = current.state.name;
			payload.to_state_id = nextState.id;
			payload.to_state_name = nextState.name;
			payload.to_state_category = nextState.category;
		}
		queries.push(
			eventInsert(
				db,
				actor,
				{ type: 'issue.updated', issueId: id, projectId: current.project_id, payload },
				guard
			)
		);
	}
	if (stateChanged && !workflowChanged) {
		queries.push(
			eventInsert(
				db,
				actor,
				{
					type: 'issue.transitioned',
					issueId: id,
					projectId: current.project_id,
					payload: {
						state_entry_version: 1,
						forced: true,
						workflow_id: current.workflow.id,
						workflow_name: current.workflow.name,
						from_state_id: current.state.id,
						from_state_name: current.state.name,
						to_state_id: nextState.id,
						to_state_name: nextState.name,
						to_state_category: nextState.category
					}
				},
				guard
			)
		);
	}

	const results = await runAtomic(env, queries);
	if (guarded && (results[0]?.meta.changes ?? 0) === 0) {
		const fresh = await getIssueDetail(db, actor.userId, { id });
		throw new ApiFail(
			409,
			'conflict',
			`The issue moved to state "${fresh.state.name}" while this update was in flight; re-check and retry`,
			{ current_state: fresh.state, allowed_transitions: fresh.allowed_transitions }
		);
	}
	effects.signalDispatch();
	return getIssueDetail(db, actor.userId, { id });
}

/**
 * The structured, self-correcting 422 for a gated transition: the message
 * names the fix, and each unmet entry carries a runnable `fix` command, so
 * an agent can attach/reaffirm and retry the same transition without help.
 *
 * The `fix` strings are not built here — they are computed once, with the
 * check itself (`checkRequirements` → `requirementFix`), so this error and
 * the issue read quote byte-identical commands.
 */
function unmetRequirements(
	issue: IssueDetail,
	target: AllowedTransition,
	unmet: ArtifactRequirementCheck[]
): ApiFail {
	const first = unmet[0];
	const more =
		unmet.length > 1
			? ` (and ${unmet.length - 1} more unmet requirement${unmet.length > 2 ? 's' : ''})`
			: '';
	// A wrong immutable type is the one case a new version cannot fix, so it
	// gets its own sentence rather than the generic "attach it" advice that
	// would send an agent into a 422 loop. The type it names is the one the
	// `fix` command attaches: an untyped gate would take text too, but a
	// summary and a command naming different types is what sent readers
	// looking for a third answer (Tines/255). The `?? 'file'` is defensive
	// only: an untyped requirement cannot reach `type_mismatch` (a workflow
	// refuses a `content_type` without a file/text `type`), so no gate the API
	// accepts renders this sentence untyped — `requirementFix` pins the same
	// word for the shape in @tines/shared.
	const wrongType =
		requirementFix(first, issueRef(issue)).kind === 'delete_and_attach'
			? `The attached "${first.artifact}" is a ${first.current_type} artifact and the gate needs ${first.type ?? 'file'} — artifact type is immutable, so a new version cannot help: delete the slot and attach again (each unmet entry's "fix" is the exact command).`
			: null;
	return new ApiFail(
		422,
		'transition_requirements_unmet',
		`Transition "${target.name}" requires a fresh artifact "${first.artifact}"${requirementSpecLabel(first)}${more}. ${
			wrongType ?? 'Attach it (or a new version), then retry the same transition.'
		}`,
		{
			transition: { name: target.name, to_state: target.to_state.name },
			state_entered_at: issue.state_entered_at,
			unmet
		}
	);
}

export async function transitionIssue(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	effects: DispatchEffects,
	id: string,
	body: TransitionIssueRequest
): Promise<IssueDetail> {
	assertConsentFieldsSupported(actor, body, [
		'allow_my_agents',
		'disclosure_version',
		'expected_consent_revision',
		'expected_consent_epoch',
		'expected_decision_revision'
	]);
	if (
		body.disclosure_version !== undefined &&
		(!Number.isInteger(body.disclosure_version) || body.disclosure_version < 1)
	) {
		throw new ApiFail(422, 'invalid_field', '"disclosure_version" must be a positive integer', {
			field: 'disclosure_version'
		});
	}
	const current = await getIssueDetail(db, actor.userId, { id });
	await assertWritable(db, actor, issueProject(current), { issueId: current.id });
	const decision = await db
		.selectFrom('issue as i')
		.innerJoin('project as p', 'p.id', 'i.project_id')
		.innerJoin('workflow as w', 'w.id', 'i.workflow_id')
		.leftJoin('issue_personal_choice as c', (join) =>
			join.onRef('c.issue_id', '=', 'i.id').on('c.user_id', '=', actor.userId)
		)
		.select([
			'i.project_id',
			'i.workflow_id',
			'i.project_assignment_token',
			'i.decision_revision',
			'i.consent_epoch',
			'p.shared_at',
			'p.sharing_revision',
			'w.decision_revision as workflow_revision',
			'c.value as consent_value',
			'c.revision as consent_revision',
			'c.source_kind as consent_source'
		])
		.where('i.id', '=', id)
		.where('p.user_id', '=', actor.userId)
		.executeTakeFirst();
	if (!decision) throw notFound();
	const consentMode = decision.shared_at !== null;
	const choiceRevision = decision.consent_revision ?? 0;

	const action = body.action?.trim();
	const transitionId = body.transition_id?.trim();
	if (consentMode) {
		if (!transitionId || action) {
			throw new ApiFail(
				409,
				'decision_refresh_required',
				'Refresh the issue and choose an exact transition',
				{
					committed: false,
					remedy: 'refresh_issue'
				}
			);
		}
		if (
			body.expected_state_id !== current.state.id ||
			body.expected_decision_revision !== decision.decision_revision ||
			body.expected_consent_revision !== choiceRevision ||
			body.expected_consent_epoch !== decision.consent_epoch ||
			body.expected_workflow_revision !== decision.workflow_revision
		) {
			throw new ApiFail(
				409,
				'decision_refresh_required',
				'Issue permission or workflow changed; refresh and choose again',
				{
					committed: false,
					current_state_id: current.state.id,
					current_decision_revision: decision.decision_revision,
					current_consent_revision: choiceRevision,
					current_consent_epoch: decision.consent_epoch,
					current_workflow_revision: decision.workflow_revision,
					remedy: 'refresh_issue'
				}
			);
		}
	}
	if (body.allow_my_agents !== undefined && typeof body.allow_my_agents !== 'boolean') {
		throw new ApiFail(422, 'invalid_field', '"allow_my_agents" must be a boolean', {
			field: 'allow_my_agents'
		});
	}
	if ((action ? 1 : 0) + (transitionId ? 1 : 0) !== 1) {
		throw new ApiFail(
			422,
			'invalid_field',
			'Pass exactly one of "action" (the transition name) or "transition_id"'
		);
	}

	const allowed = current.allowed_transitions;
	const target = transitionId
		? allowed.find((t) => t.transition_id === transitionId)
		: allowed.find((t) => t.name.toLowerCase() === action!.toLowerCase());
	if (!target) {
		const what = transitionId ? `Transition "${transitionId}"` : `Action "${action}"`;
		throw new ApiFail(
			422,
			'invalid_transition',
			`${what} is not available from state "${current.state.name}" in workflow "${current.workflow.name}"${
				allowed.length
					? `; allowed: ${allowed.map((t) => `"${t.name}" (→ ${t.to_state.name})`).join(', ')}`
					: '; this state is terminal'
			}`,
			{
				current_state: current.state,
				allowed_transitions: allowed
			}
		);
	}
	if (consentMode && !actor.viaSession && body.allow_my_agents !== undefined) {
		throw new ApiFail(
			403,
			'consent_browser_required',
			'Personal permission must be chosen in the browser'
		);
	}
	if (body.allow_my_agents !== undefined && target.to_state.category !== 'active') {
		throw new ApiFail(
			422,
			'permission_state_invalid',
			body.allow_my_agents
				? 'Permission can be enabled only when the issue enters an active state'
				: 'Use the issue permission control to turn permission off',
			{ field: 'allow_my_agents' }
		);
	}

	// Requirements are checked after resolving the target transition and
	// before the compare-and-swap write. The check and the CAS are not
	// atomic (an artifact could be deleted between them); that race window
	// is accepted — the gate is a process guard, not a security boundary.
	const unmet = (target.requires ?? []).filter((r) => r.status !== 'satisfied');
	if (unmet.length > 0) {
		throw unmetRequirements(current, target, unmet);
	}

	// Compare-and-swap: the update only applies while the issue is still in
	// the state the transition was validated against, and the event insert is
	// guarded on that same write landing — a lost race records nothing.
	const now = Date.now();
	const token = newId('dcn');
	const lifecycleReset = target.to_state.category === 'done' || current.state.category === 'done';
	const implicitChoice =
		consentMode &&
		actor.viaSession &&
		target.to_state.category === 'active' &&
		current.state.category !== 'done' &&
		decision.consent_value === null;
	const desiredChoice =
		consentMode && target.to_state.category === 'active' && current.state.category !== 'done'
			? body.allow_my_agents !== undefined
				? body.allow_my_agents
				: implicitChoice
					? true
					: null
			: null;
	const nextConsentValue = desiredChoice === null ? null : desiredChoice ? 'on' : 'off';
	const choiceChanged =
		nextConsentValue !== null &&
		(decision.consent_value !== nextConsentValue || decision.consent_source !== 'explicit_issue');
	const stateWrite = sql`
		UPDATE issue SET state_id = ${target.to_state.id}, state_entered_at = ${now}, updated_at = ${now},
			decision_revision = decision_revision + 1,
			consent_epoch = consent_epoch + ${lifecycleReset ? 1 : 0},
			last_decision_token = CASE WHEN ${consentMode ? 1 : 0} = 1 THEN ${token} ELSE last_decision_token END,
			needs_attention = CASE WHEN ${actor.agentRunId ? 1 : 0} = 1 THEN needs_attention ELSE 0 END,
			attempt_count = CASE WHEN ${actor.agentRunId ? 1 : 0} = 1 THEN attempt_count ELSE 0 END
		WHERE id = ${id} AND state_id = ${current.state.id}
			AND project_id = ${decision.project_id}
			AND project_assignment_token = ${decision.project_assignment_token}
			AND EXISTS (SELECT 1 FROM workflow_transition wt
				WHERE wt.id = ${target.transition_id} AND wt.workflow_id = issue.workflow_id
					AND wt.from_state_id = ${current.state.id} AND wt.to_state_id = ${target.to_state.id})
			${
				consentMode
					? sql`AND decision_revision = ${decision.decision_revision}
				AND consent_epoch = ${decision.consent_epoch}
				AND EXISTS (SELECT 1 FROM project p WHERE p.id = issue.project_id AND p.user_id = ${actor.userId}
					AND p.shared_at IS NOT NULL AND p.sharing_revision = ${decision.sharing_revision}
					AND p.archived_at IS NULL)
				AND COALESCE((SELECT c.revision FROM issue_personal_choice c
					WHERE c.issue_id = issue.id AND c.user_id = ${actor.userId}), 0) = ${choiceRevision}
				AND EXISTS (SELECT 1 FROM workflow w WHERE w.id = issue.workflow_id
					AND w.decision_revision = ${decision.workflow_revision})`
					: sql``
			}`.compile(db);
	const writeQueries = [stateWrite];
	if (consentMode) {
		writeQueries.push(
			...releaseAssignedIssueQueries(db, {
				issueId: id,
				userId: actor.userId,
				token,
				eventId: newId('evt'),
				now,
				reason: 'Issue decision changed before admission',
				guard: sql<boolean>`EXISTS (SELECT 1 FROM issue WHERE id = ${id} AND last_decision_token = ${token})`
			})
		);
	}
	if (lifecycleReset && consentMode) {
		writeQueries.push(
			sql`UPDATE issue_personal_choice SET value = 'unset', revision = revision + 1,
				issue_epoch = (SELECT consent_epoch FROM issue WHERE id = ${id}),
				source_kind = NULL, source_schedule_id = NULL, source_grant_revision = NULL,
				source_permission_epoch = NULL, updated_at = ${now}
			WHERE issue_id = ${id}
				AND EXISTS (SELECT 1 FROM issue WHERE id = ${id} AND last_decision_token = ${token})`.compile(db)
		);
	} else if (consentMode && choiceChanged && nextConsentValue) {
		writeQueries.push(
			sql`INSERT INTO issue_personal_choice
				(issue_id, user_id, value, revision, issue_epoch, membership_revision, source_kind, updated_at,
				 last_request_token)
			SELECT ${id}, ${actor.userId}, ${nextConsentValue}, 1, issue.consent_epoch, 0,
				'explicit_issue', ${now}, ${token}
			FROM issue WHERE id = ${id} AND last_decision_token = ${token}
			ON CONFLICT(issue_id, user_id) DO UPDATE SET value = excluded.value,
				revision = issue_personal_choice.revision + 1, issue_epoch = excluded.issue_epoch,
				source_kind = 'explicit_issue', source_schedule_id = NULL, source_grant_revision = NULL,
				source_permission_epoch = NULL, updated_at = excluded.updated_at,
				last_request_token = excluded.last_request_token
			WHERE issue_personal_choice.revision = ${choiceRevision}`.compile(db)
		);
	}
	const decisionGuard = consentMode
		? {
				predicate: sql<boolean>`EXISTS (SELECT 1 FROM issue WHERE id = ${id} AND last_decision_token = ${token})`
			}
		: { issueId: id, stateId: target.to_state.id, updatedAt: now };
	writeQueries.push(
		eventInsert(
			db,
			actor,
			{
				type: 'issue.transitioned',
				issueId: id,
				projectId: current.project_id,
				payload: {
					state_entry_version: 1,
					transition_id: target.transition_id,
					action: target.name,
					workflow_id: current.workflow.id,
					workflow_name: current.workflow.name,
					from_state_id: current.state.id,
					from_state_name: current.state.name,
					to_state_id: target.to_state.id,
					to_state_name: target.to_state.name,
					to_state_category: target.to_state.category
				}
			},
			decisionGuard
		)
	);
	if (consentMode && choiceChanged && nextConsentValue && !lifecycleReset) {
		writeQueries.push(
			eventInsert(
				db,
				actor,
				{
					type: 'issue.personal_permission_changed',
					issueId: id,
					projectId: current.project_id,
					payload: { value: nextConsentValue, revision: choiceRevision + 1 }
				},
				{
					predicate: sql<boolean>`EXISTS (SELECT 1 FROM issue_personal_choice WHERE issue_id = ${id}
					AND user_id = ${actor.userId} AND last_request_token = ${token})`
				}
			)
		);
	}
	if (consentMode && body.disclosure_version && nextConsentValue === 'on') {
		writeQueries.push(
			sql`INSERT INTO personal_disclosure (user_id, version, acknowledged_at)
				SELECT ${actor.userId}, ${body.disclosure_version}, ${now}
				WHERE EXISTS (SELECT 1 FROM issue_personal_choice WHERE issue_id = ${id}
					AND user_id = ${actor.userId} AND last_request_token = ${token})
				ON CONFLICT(user_id, version) DO NOTHING`.compile(db)
		);
	}
	const results = await runAtomic(env, writeQueries);
	if ((results[0]?.meta.changes ?? 0) === 0) {
		const fresh = await getIssueDetail(db, actor.userId, { id });
		throw new ApiFail(
			409,
			'conflict',
			`The issue moved to state "${fresh.state.name}" while this transition was in flight; re-check the allowed transitions`,
			{ current_state: fresh.state, allowed_transitions: fresh.allowed_transitions }
		);
	}
	effects.signalDispatch();
	const updated = await getIssueDetail(db, actor.userId, { id });
	if (!consentMode) return updated;
	const permission_receipt: IssueConsentReceipt = {
		...(await readIssueConsent(db, actor.userId, id)),
		actor: actor.viaSession ? 'owner' : 'key',
		committed_atomically: true,
		...(actor.viaSession
			? {}
			: { message: 'Permission unchanged; manage your permission in the browser.' })
	};
	return { ...updated, permission_receipt };
}

/**
 * Un-park: clears `needs_attention` and resets the attempt count, so the
 * issue re-enters the pool on the next pass. Idempotent — resuming an
 * unparked, strike-free issue records nothing. The route is run-key-fenced
 * (control plane): an agent must not be able to un-park its own issue.
 */
export async function resumeIssue(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	effects: DispatchEffects,
	id: string
): Promise<IssueDetail> {
	const current = await getIssueDetail(db, actor.userId, { id });
	await assertWritable(db, actor, issueProject(current), { issueId: current.id });
	if (!current.needs_attention && current.attempt_count === 0) {
		effects.signalDispatch();
		return current;
	}
	await runAtomic(env, [
		db
			.updateTable('issue')
			.set({ needs_attention: 0, attempt_count: 0, updated_at: Date.now() })
			.where('id', '=', id)
			.compile(),
		eventInsert(db, actor, {
			type: 'issue.resumed',
			issueId: id,
			projectId: current.project_id,
			payload: { was_parked: current.needs_attention, attempt_count_was: current.attempt_count }
		})
	]);
	effects.signalDispatch();
	return getIssueDetail(db, actor.userId, { id });
}

export async function createComment(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	issueId: string,
	body: CreateCommentRequest
): Promise<Comment> {
	const issue = await getIssueDetail(db, actor.userId, { id: issueId });
	await assertWritable(db, actor, issueProject(issue), { issueId: issue.id });
	const text = requireString(body.body, 'body', { max: 100_000 });

	const id = newId('cmt');
	await runAtomic(env, [
		db
			.insertInto('comment')
			.values({
				id,
				issue_id: issue.id,
				body: text,
				actor_user_id: actor.userId,
				actor_api_key_id: actor.apiKeyId,
				created_at: Date.now()
			})
			.compile(),
		eventInsert(db, actor, {
			type: 'issue.commented',
			issueId: issue.id,
			projectId: issue.project_id,
			payload: { comment_id: id }
		})
	]);
	const comments = await loadComments(db, issue.id);
	const created = comments.find((c) => c.id === id);
	if (!created) throw new ApiFail(500, 'internal', 'Comment insert failed');
	return created;
}

/**
 * Who may rewrite the shared record. Sessions and named keys act with full
 * owner authority over their own workspace — the motivating case is a human
 * cleaning up an agent's mis-posted comment. A run key is narrower: it may fix
 * only what it wrote itself, so agents cannot rewrite each other's handoff
 * notes (the affordance asymmetry of specs/context/AGENT_EDITING.md).
 */
export function assertCommentActionAllowed(
	actor: Pick<ActorContext, 'agentRunId' | 'apiKeyId'>,
	comment: { actor_api_key_id: string | null }
): void {
	if (!actor.agentRunId) return;
	// The null check guards a state the types allow but auth cannot produce: a
	// run actor always carries its key, so a session-authored comment (key id
	// null) must never match by two nulls.
	if (comment.actor_api_key_id !== null && comment.actor_api_key_id === actor.apiKeyId) return;
	throw new ApiFail(
		403,
		'run_key_forbidden',
		'Run keys can only edit or delete comments they authored themselves. Other comments are ' +
			'the shared record — ask a human, or note the correction in a new comment.'
	);
}

/** The comment row itself, scoped to an issue the actor can see. */
async function requireComment(
	db: Kysely<Database>,
	actor: ActorContext,
	issueId: string,
	commentId: string
): Promise<{
	issue: IssueDetail;
	row: { id: string; body: string; actor_api_key_id: string | null };
}> {
	const issue = await getIssueDetail(db, actor.userId, { id: issueId });
	await assertWritable(db, actor, issueProject(issue), { issueId: issue.id });
	const row = await db
		.selectFrom('comment')
		.select(['id', 'body', 'actor_api_key_id'])
		.where('id', '=', commentId)
		.where('issue_id', '=', issue.id)
		.executeTakeFirst();
	if (!row) throw notFound();
	assertCommentActionAllowed(actor, row);
	return { issue, row };
}

export async function updateComment(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	issueId: string,
	commentId: string,
	body: UpdateCommentRequest
): Promise<Comment> {
	const { issue } = await requireComment(db, actor, issueId, commentId);
	const text = requireString(body.body, 'body', { max: 100_000 });

	await runAtomic(env, [
		db
			.updateTable('comment')
			.set({ body: text, updated_at: Date.now() })
			.where('id', '=', commentId)
			.compile(),
		// Payload stays content-free: the audit trail records the action, not
		// the text (events are append-only, and a mis-posted secret is exactly
		// what an edit is for).
		eventInsert(db, actor, {
			type: 'issue.comment_edited',
			issueId: issue.id,
			projectId: issue.project_id,
			payload: { comment_id: commentId, changed: ['body'] }
		})
	]);
	const comments = await loadComments(db, issue.id);
	const updated = comments.find((c) => c.id === commentId);
	if (!updated) throw new ApiFail(500, 'internal', 'Comment update failed');
	return updated;
}

export async function deleteComment(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	issueId: string,
	commentId: string
): Promise<void> {
	const { issue, row } = await requireComment(db, actor, issueId, commentId);
	await runAtomic(env, [
		db.deleteFrom('comment').where('id', '=', commentId).compile(),
		eventInsert(db, actor, {
			type: 'issue.comment_deleted',
			issueId: issue.id,
			projectId: issue.project_id,
			payload: { comment_id: commentId, body_length: row.body.length }
		})
	]);
}

export { loadComments };
