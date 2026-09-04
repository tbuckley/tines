import {
	renderTemplate,
	templateVars,
	type AllowedTransition,
	type ArtifactRequirementCheck,
	type Comment,
	type CreateCommentRequest,
	type CreateIssueRequest,
	type CreateIssueResponse,
	type Issue,
	type IssueDetail,
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
import { newId, type Database } from '$lib/server/db';
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
import { checkRequirements, listArtifacts, requirementSpecLabel } from './artifacts';
import { contextSummaryForIssue } from './context';
import { actorOf, eventInsert } from './events';
import { issueLabelInserts, labelInserts, resolveOrCreateLabels } from './labels';
import { requireTier } from './runners';
import { getSchedule, prepareSchedule } from './schedules';
import { loadWorkflow, loadWorkflows } from './workflows';

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
			.leftJoin('runner as pin_runner', 'pin_runner.id', 'issue.pinned_runner_id')
			.selectAll('issue')
			.select([
				'project.name as project_name',
				'state.name as state_name',
				'state.category as state_category',
				'state.position as state_position',
				'scheduled_task.name as scheduled_task_name',
				'pin_runner.name as pinned_runner_name'
			])
			.select([
				sql<string>`COALESCE(eff_state.id, state.id)`.as('eff_state_id'),
				sql<string>`COALESCE(eff_state.name, state.name)`.as('eff_state_name'),
				sql<StateCategory>`COALESCE(eff_state.category, state.category)`.as('eff_state_category'),
				sql<number>`COALESCE(eff_state.position, state.position)`.as('eff_state_position'),
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
				)`.as('active_run_json')
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

export function serializeIssue(row: IssueRow): Issue {
	return {
		id: row.id,
		project_id: row.project_id,
		project_name: row.project_name,
		number: row.number,
		title: row.title,
		description: row.description,
		workflow_id: row.workflow_id,
		state: {
			id: row.state_id,
			name: row.state_name,
			category: row.state_category,
			position: row.state_position
		},
		effective_state: {
			id: row.eff_state_id,
			name: row.eff_state_name,
			category: row.eff_state_category,
			position: row.eff_state_position
		},
		duplicate_of: row.duplicate_of_json ? (JSON.parse(row.duplicate_of_json) as IssueRef) : null,
		open_blockers: row.open_blockers_json ? (JSON.parse(row.open_blockers_json) as IssueRef[]) : [],
		labels: row.labels_json ? (JSON.parse(row.labels_json) as IssueLabel[]) : [],
		scheduled_task_id: row.scheduled_task_id,
		scheduled_task_name: row.scheduled_task_name,
		pinned_runner_id: row.pinned_runner_id,
		pinned_runner_name: row.pinned_runner_name,
		pinned_tier: row.pinned_tier as ModelTier | null,
		attempt_count: row.attempt_count,
		needs_attention: row.needs_attention === 1,
		active_run: row.active_run_json
			? (JSON.parse(row.active_run_json) as Issue['active_run'])
			: null,
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
	/** Only not-done, non-duplicate issues whose blockers are all effectively done. */
	ready?: boolean;
	/** Restrict to one project id (the nested per-project route). */
	projectId?: string;
	/** Title/description substring search. */
	q?: string;
	/** Label names or ids; every one must be present (AND). */
	labels?: string[];
	/** Omit `description` from every item — the bulk of a list payload. */
	brief?: boolean;
}

export async function listIssues(
	db: Kysely<Database>,
	userId: string,
	filters: IssueListFilters,
	page: Page
): Promise<{ items: IssueListItem[]; hasMore: boolean }> {
	let q = issueQuery(db, userId);
	if (filters.projectId) q = q.where('issue.project_id', '=', filters.projectId);
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
	if (filters.category) {
		q = q.where(
			sql<boolean>`COALESCE(eff_state.category, state.category) = ${filters.category as StateCategory}`
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
	if (filters.hideDone) {
		q = q.where(sql<boolean>`COALESCE(eff_state.category, state.category) != 'done'`);
	}
	if (filters.ready) {
		// Ready = effectively not done, not itself a duplicate, and no blocker
		// still effectively open. Readiness is the default; links only take it away.
		q = q
			.where(sql<boolean>`COALESCE(eff_state.category, state.category) != 'done'`)
			.where(
				sql<boolean>`NOT EXISTS (SELECT 1 FROM issue_link dl WHERE dl.source_issue_id = issue.id AND dl.kind = 'duplicate_of')`
			)
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
		// Plain substring search; % and _ act as wildcards, which is harmless
		// (and occasionally useful) for a search box.
		const like = `%${filters.q}%`;
		q = q.where((eb) =>
			eb.or([eb('issue.title', 'like', like), eb('issue.description', 'like', like)])
		);
	}
	if (page.cursor) {
		const { createdAt, id } = page.cursor;
		q = q.where((eb) =>
			eb.or([
				eb('issue.created_at', '<', createdAt),
				eb.and([eb('issue.created_at', '=', createdAt), eb('issue.id', '<', id)])
			])
		);
	}
	const rows = await q
		.orderBy('issue.created_at desc')
		.orderBy('issue.id desc')
		.limit(page.limit + 1)
		.execute();
	const serialize = filters.brief ? briefIssue : serializeIssue;
	return {
		items: rows.slice(0, page.limit).map(serialize),
		hasMore: rows.length > page.limit
	};
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

async function loadComments(db: Kysely<Database>, issueId: string): Promise<Comment[]> {
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
			'actor_run_project.name as actor_run_project_name',
			'actor_run_issue.number as actor_run_issue_number'
		])
		.where('comment.issue_id', '=', issueId)
		.orderBy('comment.created_at asc')
		.orderBy('comment.id asc')
		.execute();
	return rows.map((row) => ({
		id: row.id,
		issue_id: row.issue_id,
		body: row.body,
		actor: actorOf(row),
		created_at: row.created_at,
		updated_at: row.updated_at
	}));
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
			: await issueQuery(db, userId).where('issue.id', 'in', otherIds).execute();
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
		q = q.where('issue.project_id', '=', ref.projectId).where('issue.number', '=', ref.number);
	else
		q = q
			.where('project.name', '=', ref.projectName)
			.where('issue.number', '=', ref.number)
			.orderBy('project.created_at desc');
	const row = await q.executeTakeFirst();
	if (!row) throw notFound();
	return serializeIssue(row);
}

export interface IssueDetailOptions {
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
	const [workflows, comments, links, contextSummary, preloadedArtifacts] = await Promise.all([
		opts.workflows ?? loadWorkflows(db, userId, issue.workflow_id),
		loadComments(db, issue.id),
		loadIssueLinks(db, userId, issue.id),
		contextSummaryForIssue(db, userId, {
			projectId: issue.project_id,
			stateId: issue.state.id,
			issueId: issue.id
		}),
		opts.artifacts ? listArtifacts(db, userId, issue.id) : null
	]);

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
			return requires?.length ? { ...t, requires: checkRequirements(requires, artifacts) } : t;
		});
	}

	return {
		...issue,
		workflow,
		comments,
		allowed_transitions: allowed,
		links,
		context_summary: contextSummary,
		...(preloadedArtifacts ? { artifacts: preloadedArtifacts } : {})
	};
}

// ---------------------------------------------------------------------------
// Mutations

export async function createIssue(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	projectId: string,
	body: CreateIssueRequest
): Promise<CreateIssueResponse> {
	const project = await db
		.selectFrom('project')
		.selectAll()
		.where('id', '=', projectId)
		.where('user_id', '=', actor.userId)
		.executeTakeFirst();
	if (!project) throw notFound();

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

	// A non-initial starting state pins the schedule too: future instances
	// start where the first issue does. NULL keeps following the workflow's
	// initial state.
	const scheduleStateId = initialState.id === workflow.initial_state_id ? null : initialState.id;

	const queries: CompiledQuery[] = [];
	if (schedule) {
		queries.push(
			db
				.insertInto('scheduled_task')
				.values({
					id: schedule.id,
					project_id: projectId,
					name: schedule.name,
					title_template: title,
					description_template: description,
					workflow_id: workflow.id,
					state_id: scheduleStateId,
					cron: schedule.recurrence.cron,
					preset: schedule.recurrence.presetJson,
					timezone: schedule.timezone,
					require_all_closed: schedule.requireAllClosed ? 1 : 0,
					enabled: 1,
					next_run_at: schedule.nextRunAt,
					last_run_at: now,
					// The initial issue counts as the first run.
					run_count: 1,
					created_at: now,
					updated_at: now
				})
				.compile()
		);
	}
	queries.push(
		// MAX(number)+1 inside a single statement (and the batch's implicit
		// transaction) keeps per-project numbering race-free on D1.
		db
			.insertInto('issue')
			.values({
				id,
				project_id: projectId,
				number: sql<number>`(SELECT COALESCE(MAX(number), 0) + 1 FROM issue WHERE project_id = ${projectId})`,
				title: issueTitle,
				description: issueDescription,
				workflow_id: workflow.id,
				state_id: initialState.id,
				scheduled_task_id: schedule?.id ?? null,
				pinned_runner_id: null,
				pinned_tier: null,
				attempt_count: 0,
				needs_attention: 0,
				state_entered_at: now,
				created_at: now,
				updated_at: now
			})
			.compile(),
		eventInsert(db, actor, {
			type: 'issue.created',
			issueId: id,
			projectId,
			payload: {
				title: issueTitle,
				workflow_id: workflow.id,
				state_id: initialState.id,
				state_name: initialState.name,
				...(schedule ? { scheduled_task_id: schedule.id, scheduled_task_name: schedule.name } : {})
			}
		})
	);
	if (schedule) {
		queries.push(
			eventInsert(db, actor, {
				type: 'scheduled_task.created',
				projectId,
				payload: {
					schedule_id: schedule.id,
					name: schedule.name,
					cron: schedule.recurrence.cron,
					timezone: schedule.timezone,
					require_all_closed: schedule.requireAllClosed,
					...(scheduleStateId ? { start_state: initialState.name } : {})
				}
			})
		);
	}
	if (resolvedLabels) {
		queries.push(
			...labelInserts(db, actor, resolvedLabels.toCreate),
			...issueLabelInserts(db, actor, { id, project_id: projectId }, resolvedLabels.labels, now)
		);
	}
	await runAtomic(env, queries);

	const issue = await getIssueDetail(db, actor.userId, { id });
	if (!schedule) return issue;
	return { ...issue, schedule: await getSchedule(db, actor.userId, schedule.id) };
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
	id: string,
	body: UpdateIssueRequest
): Promise<IssueDetail> {
	assertPinFieldsAllowed(actor, body);
	const current = await getIssueDetail(db, actor.userId, { id });
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
	if (changed.length === 0 && !stateChanged) return current;

	// Compare-and-swap on the state whenever it (or the workflow) moves, so a
	// concurrent transition can't be silently overwritten; the events are
	// guarded on the same write landing.
	const now = Date.now();
	const guarded = stateChanged || workflowChanged;
	let update = db
		.updateTable('issue')
		.set({
			title,
			description,
			workflow_id: workflow.id,
			state_id: nextState.id,
			pinned_runner_id: pinnedRunnerId,
			pinned_tier: pinnedTier,
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
			payload.workflow_from_id = current.workflow.id;
			payload.workflow_from_name = current.workflow.name;
			payload.workflow_to_id = workflow.id;
			payload.workflow_to_name = workflow.name;
			payload.from_state_name = current.state.name;
			payload.to_state_name = nextState.name;
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
						forced: true,
						from_state_id: current.state.id,
						from_state_name: current.state.name,
						to_state_id: nextState.id,
						to_state_name: nextState.name
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
	return getIssueDetail(db, actor.userId, { id });
}

/**
 * The structured, self-correcting 422 for a gated transition: the message
 * names the fix, and each unmet entry carries a runnable `fix` command, so
 * an agent can attach/reaffirm and retry the same transition without help.
 */
function unmetRequirements(
	issue: IssueDetail,
	target: AllowedTransition,
	unmet: ArtifactRequirementCheck[]
): ApiFail {
	const ref = `${issue.project_name}/${issue.number}`;
	const attachFlag: Record<string, string> = {
		file: '--file <path>',
		folder: '--folder <dir>',
		text: '--text <markdown|@file>',
		link: '--link <url>',
		pr: '--pr <owner/repo#N>'
	};
	const fixFor = (r: ArtifactRequirementCheck): string => {
		const attach = (type: string) =>
			`tines issues artifacts attach ${ref} ${r.artifact} ${attachFlag[type]}`;
		if (r.status === 'missing' || r.current_type === null) return attach(r.type ?? 'file');
		if (r.status === 'stale') {
			// The slot passed the type checks, so a new version keeps the
			// artifact's own type — the artifact type is immutable, and an
			// attach under the requirement's declared type would 422 whenever
			// the two differ (e.g. an untyped requirement over a text slot).
			return `${attach(r.current_type)} — or, if the current content still stands: tines issues artifacts reaffirm ${ref} ${r.artifact}`;
		}
		// type_mismatch: when the artifact's own type can still satisfy the
		// requirement (a content_type-only miss on a file/text slot), a new
		// version under the same name is enough; otherwise the slot holds the
		// wrong immutable type and must be deleted before re-attaching.
		const reattachable =
			r.type === undefined
				? r.current_type === 'file' || r.current_type === 'text'
				: r.current_type === r.type;
		return reattachable
			? attach(r.current_type)
			: `tines issues artifacts delete ${ref} ${r.artifact} && ${attach(r.type ?? 'file')}`;
	};
	const first = unmet[0];
	return new ApiFail(
		422,
		'transition_requirements_unmet',
		`Transition "${target.name}" requires a fresh artifact "${first.artifact}"${requirementSpecLabel(first)}${
			unmet.length > 1
				? ` (and ${unmet.length - 1} more unmet requirement${unmet.length > 2 ? 's' : ''})`
				: ''
		}. Attach it (or a new version), then retry the same transition.`,
		{
			transition: { name: target.name, to_state: target.to_state.name },
			state_entered_at: issue.state_entered_at,
			unmet: unmet.map((r) => ({ ...r, fix: fixFor(r) }))
		}
	);
}

export async function transitionIssue(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	id: string,
	body: TransitionIssueRequest
): Promise<IssueDetail> {
	const current = await getIssueDetail(db, actor.userId, { id });

	const action = body.action?.trim();
	const transitionId = body.transition_id?.trim();
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
	const results = await runAtomic(env, [
		db
			.updateTable('issue')
			.set({
				state_id: target.to_state.id,
				// Entering a state (re-)starts the artifact-freshness clock.
				state_entered_at: now,
				updated_at: now,
				// A non-run-key transition is the spec's definition of "manual":
				// it un-parks the issue and resets the attempt count.
				...(actor.agentRunId ? {} : { needs_attention: 0, attempt_count: 0 })
			})
			.where('id', '=', id)
			.where('state_id', '=', current.state.id)
			.compile(),
		eventInsert(
			db,
			actor,
			{
				type: 'issue.transitioned',
				issueId: id,
				projectId: current.project_id,
				payload: {
					transition_id: target.transition_id,
					action: target.name,
					from_state_id: current.state.id,
					from_state_name: current.state.name,
					to_state_id: target.to_state.id,
					to_state_name: target.to_state.name
				}
			},
			{ issueId: id, stateId: target.to_state.id, updatedAt: now }
		)
	]);
	if ((results[0]?.meta.changes ?? 0) === 0) {
		const fresh = await getIssueDetail(db, actor.userId, { id });
		throw new ApiFail(
			409,
			'conflict',
			`The issue moved to state "${fresh.state.name}" while this transition was in flight; re-check the allowed transitions`,
			{ current_state: fresh.state, allowed_transitions: fresh.allowed_transitions }
		);
	}
	return getIssueDetail(db, actor.userId, { id });
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
	id: string
): Promise<IssueDetail> {
	const current = await getIssueDetail(db, actor.userId, { id });
	if (!current.needs_attention && current.attempt_count === 0) return current;
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
