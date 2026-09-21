import {
	addUsageClassification,
	classifyUsage,
	compareUsageDecimals,
	cohortKnownCostMean,
	cohortRatio,
	createUsageAccumulator,
	finalizeUsage,
	resolveUsagePeriod,
	type CohortCounters,
	type CohortEntry,
	type CohortIssueUsage,
	type CohortStateProof,
	type CohortUsageReport,
	type UsageEvidencePage,
	type UsagePeriodInput
} from '@tines/shared';
import { sql, type Kysely } from 'kysely';
import type { Database } from '$lib/server/db';
import { configuredTimezone } from './usage';
import { hydrateUsageEvidenceRuns } from './runs';
import {
	mintUsageCursor,
	verifyUsageCursor,
	type UsageScopePayload
} from '$lib/server/usage-scope';
import type { EvidenceRequest } from './usage-evidence';
import type { ActorContext } from './core';
import { projectReadPredicate, requireAccess } from './permissions';

export interface CohortUsageRequest extends UsagePeriodInput {
	workflow: string;
	project?: string;
	done_states?: string[];
}

type Normalized = CohortEntry & { potential: boolean };

function object(raw: string): Record<string, unknown> | null {
	try {
		const value = JSON.parse(raw) as unknown;
		return value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}
const text = (value: unknown) => (typeof value === 'string' && value ? value : null);

function normalize(row: {
	id: string;
	type: string;
	issue_id: string | null;
	project_id: string | null;
	payload: string;
	created_at: number;
}): Normalized {
	const payload = object(row.payload);
	const created = row.type === 'issue.created';
	const transitioned = row.type === 'issue.transitioned';
	const updated = row.type === 'issue.updated';
	const changed = Array.isArray(payload?.changed) ? payload.changed : [];
	const workflowChange = updated && changed.includes('workflow');
	const potential = created || transitioned || workflowChange;
	const workflowId = text(
		created || transitioned ? payload?.workflow_id : workflowChange ? payload?.workflow_to_id : null
	);
	const workflowName = text(
		created || transitioned
			? payload?.workflow_name
			: workflowChange
				? payload?.workflow_to_name
				: null
	);
	const stateId = text(created ? payload?.state_id : potential ? payload?.to_state_id : null);
	const stateName = text(created ? payload?.state_name : potential ? payload?.to_state_name : null);
	const category = text(
		created ? payload?.state_category : potential ? payload?.to_state_category : null
	);
	const unavailable = !payload
		? 'malformed_payload'
		: potential && !stateId
			? 'missing_target_state_id'
			: potential && (!workflowId || !category)
				? 'missing_workflow_or_category'
				: null;
	return {
		event_id: row.id,
		event_type: row.type as CohortEntry['event_type'],
		issue_id: row.issue_id,
		project_id: row.project_id,
		workflow_id: workflowId,
		workflow_name: workflowName,
		state_id: stateId,
		state_name: stateName,
		category,
		identity_basis: potential && !unavailable ? 'recorded_entry' : null,
		created_at: row.created_at,
		qualifies: false,
		chosen: false,
		reopening_relevant: false,
		unavailable_reason: unavailable,
		potential
	};
}

function counters(
	issues: CohortIssueUsage[],
	aggregate: ReturnType<typeof finalizeUsage>
): CohortCounters {
	const count = issues.length;
	const attempts = issues.reduce((sum, issue) => sum + issue.attempt_count, 0);
	const pending = issues.reduce((sum, issue) => sum + issue.pending_count, 0);
	const fully = issues.filter((issue) => issue.fully_priced).length;
	return {
		distinct_issue_count: count,
		attempt_count: attempts,
		pending_count: pending,
		zero_run_issue_count: issues.filter((issue) => issue.attempt_count === 0).length,
		pending_only_issue_count: issues.filter(
			(issue) => issue.attempt_count > 0 && issue.aggregate.finalized_run_count === 0
		).length,
		fully_priced_issue_count: fully,
		reopened_issue_count: issues.filter((issue) => issue.reopening.value === true).length,
		reopening_history_unavailable_issue_count: issues.filter(
			(issue) => issue.reopening.value === null
		).length,
		mean_attempts_per_issue: cohortRatio(attempts, count),
		known_cost_per_issue: cohortKnownCostMean(aggregate.cost_usd_exact, count, fully),
		priced_run_coverage: cohortRatio(aggregate.priced_run_count, aggregate.finalized_run_count),
		fully_priced_issue_coverage: cohortRatio(fully, count)
	};
}

type CohortStreamRow = {
	issue_id: string;
	event_id: string;
	event_type: CohortEntry['event_type'];
	event_project_id: string | null;
	workflow_id: string | null;
	workflow_name: string | null;
	state_id: string;
	state_name: string | null;
	category: string;
	entry_at: number;
	issue_number: number | null;
	issue_title: string | null;
	project_name: string | null;
	reopened: number;
	unknown_later_entry_count: number;
	witness_id: string | null;
	witness_type: CohortEntry['event_type'] | null;
	witness_project_id: string | null;
	witness_workflow_id: string | null;
	witness_workflow_name: string | null;
	witness_state_id: string | null;
	witness_state_name: string | null;
	witness_category: string | null;
	witness_at: number | null;
	run_id: string | null;
	run_created_at: number | null;
	ended_at: number | null;
	usage: string | null;
};

type CounterState = {
	distinct: number;
	attempts: number;
	pending: number;
	zero: number;
	pendingOnly: number;
	fully: number;
	reopened: number;
	unknownReopening: number;
};

type EvidenceCandidate = {
	id: string;
	cost: string | null;
	at: number;
	item?: CohortIssueUsage | CohortEntry;
};

type CohortEvidenceBuild = {
	request: EvidenceRequest;
	boundary: EvidenceCandidate | null;
	traversal: 'after' | 'before';
	winners: EvidenceCandidate[];
	totalCount: number;
	memberFound: boolean;
	memberAttempts: number;
	memberPending: number;
	memberAggregate: ReturnType<typeof finalizeUsage> | null;
	memberCounters: CohortCounters | null;
	acc: ReturnType<typeof createUsageAccumulator>;
};

function compareEvidence(a: EvidenceCandidate, b: EvidenceCandidate, request: EvidenceRequest) {
	if (request.sort === 'cost') {
		if (a.cost === null || b.cost === null) {
			if (a.cost !== b.cost) return a.cost === null ? 1 : -1;
		} else {
			const cost = compareUsageDecimals(a.cost, b.cost);
			if (cost) return request.direction === 'asc' ? cost : -cost;
		}
	}
	const time = a.at - b.at;
	if (time) return request.sort === 'time' && request.direction === 'asc' ? time : -time;
	return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
}

function offerEvidence(build: CohortEvidenceBuild, candidate: EvidenceCandidate) {
	if (build.boundary) {
		const side = compareEvidence(candidate, build.boundary, build.request);
		if (build.traversal === 'before' ? side >= 0 : side <= 0) return;
	}
	build.winners.push(candidate);
	build.winners.sort((a, b) => compareEvidence(a, b, build.request));
	if (build.winners.length > build.request.limit + 1)
		build.traversal === 'before' ? build.winners.shift() : build.winners.pop();
}

const newCounterState = (): CounterState => ({
	distinct: 0,
	attempts: 0,
	pending: 0,
	zero: 0,
	pendingOnly: 0,
	fully: 0,
	reopened: 0,
	unknownReopening: 0
});

function finishCounters(
	value: CounterState,
	aggregate: ReturnType<typeof finalizeUsage>
): CohortCounters {
	return {
		distinct_issue_count: value.distinct,
		attempt_count: value.attempts,
		pending_count: value.pending,
		zero_run_issue_count: value.zero,
		pending_only_issue_count: value.pendingOnly,
		fully_priced_issue_count: value.fully,
		reopened_issue_count: value.reopened,
		reopening_history_unavailable_issue_count: value.unknownReopening,
		mean_attempts_per_issue: cohortRatio(value.attempts, value.distinct),
		known_cost_per_issue: cohortKnownCostMean(
			aggregate.cost_usd_exact,
			value.distinct,
			value.fully
		),
		priced_run_coverage: cohortRatio(aggregate.priced_run_count, aggregate.finalized_run_count),
		fully_priced_issue_coverage: cohortRatio(value.fully, value.distinct)
	};
}

function entryFromStream(row: CohortStreamRow): CohortEntry {
	return {
		event_id: row.event_id,
		event_type: row.event_type,
		issue_id: row.issue_id,
		project_id: row.event_project_id,
		workflow_id: row.workflow_id,
		workflow_name: row.workflow_name,
		state_id: row.state_id,
		state_name: row.state_name,
		category: row.category,
		identity_basis: 'recorded_entry',
		created_at: row.entry_at,
		qualifies: true,
		chosen: true,
		reopening_relevant: false,
		unavailable_reason: null
	};
}

function witnessFromStream(row: CohortStreamRow): CohortEntry | null {
	if (!row.witness_id || !row.witness_type || row.witness_at === null) return null;
	return {
		event_id: row.witness_id,
		event_type: row.witness_type,
		issue_id: row.issue_id,
		project_id: row.witness_project_id,
		workflow_id: row.witness_workflow_id,
		workflow_name: row.witness_workflow_name,
		state_id: row.witness_state_id,
		state_name: row.witness_state_name,
		category: row.witness_category,
		identity_basis: 'recorded_entry',
		created_at: row.witness_at,
		qualifies: false,
		chosen: false,
		reopening_relevant: true,
		unavailable_reason: null
	};
}

async function buildCohortUsage(
	db: Kysely<Database>,
	owner: string,
	request: CohortUsageRequest,
	generatedAt = Date.now(),
	frozen?: {
		from: number;
		to: number;
		timezone: string;
		timezone_source: CohortUsageReport['timezone_source'];
		observed_through: number;
		selected_states: CohortStateProof[];
		selection_basis: CohortUsageReport['selection_basis'];
	},
	evidence?: CohortEvidenceBuild,
	actor?: ActorContext
): Promise<CohortUsageReport | null> {
	const period = frozen
		? { ...frozen, generated_at: generatedAt }
		: resolveUsagePeriod(request, await configuredTimezone(db, owner), generatedAt);
	const workflow = await db
		.selectFrom('workflow')
		.select(['id', 'name', 'user_id'])
		.where('id', '=', request.workflow)
		.executeTakeFirst();
	if (workflow && workflow.user_id !== null && workflow.user_id !== owner) return null;
	let projectId: string | null = null;
	if (request.project) {
		const project = await db
			.selectFrom('project')
			.select('id')
			.where((eb) => eb.or([eb('id', '=', request.project!), eb('name', '=', request.project!)]))
			.where('user_id', '=', owner)
			.executeTakeFirst();
		if (!project) return null;
		projectId = project.id;
		if (actor)
			requireAccess(actor, [{ domain: 'project', access: 'read', projectId }], 'usage.read', {
				projectId
			});
	}
	const visibleEventProject = actor
		? projectReadPredicate(actor, 'event.project_id')
		: sql<boolean>`1 = 1`;
	const visibleWitnessProject = actor
		? projectReadPredicate(actor, 'w.project_id')
		: sql<boolean>`1 = 1`;
	const visibleIssueProject = actor
		? projectReadPredicate(actor, 'i.project_id')
		: sql<boolean>`1 = 1`;
	const observedThrough = frozen?.observed_through ?? generatedAt;
	const retainedRows = async () => {
		const result = await sql<{
			id: string;
			state_id: string;
			state_name: string | null;
		}>`WITH normalized AS (
			SELECT id, created_at,
				CASE WHEN type='issue.created' THEN json_extract(payload,'$.state_id')
					ELSE json_extract(payload,'$.to_state_id') END AS state_id,
				CASE WHEN type='issue.created' THEN json_extract(payload,'$.state_name')
					ELSE json_extract(payload,'$.to_state_name') END AS state_name,
				CASE WHEN type IN ('issue.created','issue.transitioned') THEN json_extract(payload,'$.workflow_id')
					ELSE json_extract(payload,'$.workflow_to_id') END AS workflow_id,
				CASE WHEN type='issue.created' THEN json_extract(payload,'$.state_category')
					ELSE json_extract(payload,'$.to_state_category') END AS category
			FROM event
			WHERE user_id=${owner} AND created_at<${observedThrough}
				AND ${visibleEventProject}
				AND type IN ('issue.created','issue.transitioned','issue.updated') AND json_valid(payload)
		), ranked AS (
			SELECT *, ROW_NUMBER() OVER (PARTITION BY state_id ORDER BY created_at DESC,id DESC) AS rn
			FROM normalized WHERE workflow_id=${request.workflow} AND category='done'
				AND typeof(state_id)='text' AND state_id<>''
		)
		SELECT id,state_id,state_name FROM ranked WHERE rn=1 ORDER BY state_id`.execute(db);
		return result.rows;
	};
	let selected: CohortStateProof[];
	let selectionBasis: CohortUsageReport['selection_basis'];
	if (frozen) {
		selected = frozen.selected_states;
		selectionBasis = frozen.selection_basis;
	} else if (request.done_states) {
		const wanted = [...new Set(request.done_states)].sort();
		const current = workflow
			? await db
					.selectFrom('workflow_state')
					.select(['id', 'name', 'category'])
					.where('workflow_id', '=', workflow.id)
					.where('id', 'in', wanted)
					.execute()
			: [];
		const retained = current.length === wanted.length ? [] : await retainedRows();
		selected = wanted.flatMap<CohortStateProof>((id) => {
			const state = current.find((item) => item.id === id && item.category === 'done');
			if (state)
				return [
					{
						id,
						name: state.name,
						category: 'done' as const,
						basis: 'current_definition' as const,
						proof_event_id: null
					}
				];
			const event = retained.find((item) => item.state_id === id);
			return event
				? [
						{
							id,
							name: event.state_name ?? id,
							category: 'done' as const,
							basis: 'recorded_entry' as const,
							proof_event_id: event.id
						}
					]
				: [];
		});
		if (selected.length !== wanted.length) return null;
		selectionBasis = 'explicit';
	} else if (workflow) {
		const states = await db
			.selectFrom('workflow_state')
			.select(['id', 'name'])
			.where('workflow_id', '=', workflow.id)
			.where('category', '=', 'done')
			.orderBy('position')
			.execute();
		selected = states.map((state) => ({
			...state,
			category: 'done',
			basis: 'current_definition',
			proof_event_id: null
		}));
		selectionBasis = states.length ? 'all_current_done' : 'unavailable';
	} else {
		const retained = await retainedRows();
		selected = retained.map((entry) => ({
			id: entry.state_id,
			name: entry.state_name ?? entry.state_id,
			category: 'done',
			basis: 'recorded_entry',
			proof_event_id: entry.id
		}));
		selectionBasis = selected.length ? 'retained_recorded_done' : 'unavailable';
	}
	if (!workflow && selected.length === 0) return null;
	const stateAcc = new Map(selected.map((state) => [state.id, createUsageAccumulator()]));
	const stateCounters = new Map(selected.map((state) => [state.id, newCounterState()]));
	const global = createUsageAccumulator();
	const totals = newCounterState();
	let current: {
		row: CohortStreamRow;
		acc: ReturnType<typeof createUsageAccumulator>;
		attempts: number;
		pending: number;
	} | null = null;
	const finishIssue = () => {
		if (!current) return;
		const aggregate = finalizeUsage(current.acc);
		const fully =
			aggregate.finalized_run_count > 0 &&
			aggregate.priced_run_count === aggregate.finalized_run_count &&
			current.pending === 0;
		for (const target of [totals, stateCounters.get(current.row.state_id)!]) {
			target.distinct++;
			target.attempts += current.attempts;
			target.pending += current.pending;
			if (current.attempts === 0) target.zero++;
			if (current.attempts > 0 && aggregate.finalized_run_count === 0) target.pendingOnly++;
			if (fully) target.fully++;
			if (current.row.reopened) target.reopened++;
			else if (current.row.unknown_later_entry_count) target.unknownReopening++;
		}
		if (evidence) {
			const memberMatches =
				!evidence.request.member || evidence.request.member === current.row.issue_id;
			if (memberMatches) {
				evidence.memberFound = true;
				if (evidence.request.member) {
					evidence.memberAttempts = current.attempts;
					evidence.memberPending = current.pending;
					evidence.memberAggregate = aggregate;
					const memberState = newCounterState();
					memberState.distinct = 1;
					memberState.attempts = current.attempts;
					memberState.pending = current.pending;
					memberState.zero = current.attempts === 0 ? 1 : 0;
					memberState.pendingOnly =
						current.attempts > 0 && aggregate.finalized_run_count === 0 ? 1 : 0;
					memberState.fully = fully ? 1 : 0;
					memberState.reopened = current.row.reopened ? 1 : 0;
					memberState.unknownReopening =
						!current.row.reopened && current.row.unknown_later_entry_count ? 1 : 0;
					evidence.memberCounters = finishCounters(memberState, aggregate);
				}
			}
			if (evidence.request.kind === 'issues' && memberMatches) {
				const item: CohortIssueUsage = {
					issue_id: current.row.issue_id,
					issue_ref:
						current.row.project_name !== null &&
						current.row.issue_number !== null &&
						current.row.issue_title !== null
							? {
									project_name: current.row.project_name,
									number: current.row.issue_number,
									title: current.row.issue_title
								}
							: null,
					aggregate,
					attempt_count: current.attempts,
					pending_count: current.pending,
					fully_priced: fully,
					latest_at: current.row.entry_at,
					chosen_entry: entryFromStream(current.row),
					reopening: {
						value: current.row.reopened
							? true
							: current.row.unknown_later_entry_count
								? null
								: false,
						witness: witnessFromStream(current.row),
						unknown_later_entry_count: current.row.unknown_later_entry_count,
						observed_through: observedThrough
					}
				};
				evidence.totalCount++;
				offerEvidence(evidence, {
					id: item.issue_id,
					cost: aggregate.cost_usd_exact,
					at: item.latest_at,
					item
				});
			}
		}
	};
	let seek = { issue: '', at: -1, run: '' };
	for (;;) {
		const result = await sql<CohortStreamRow>`WITH normalized AS (
			SELECT id,type,issue_id,project_id,created_at,
				CASE WHEN json_valid(payload) AND type='issue.created' THEN json_extract(payload,'$.state_id')
					WHEN json_valid(payload) THEN json_extract(payload,'$.to_state_id') END AS state_id,
				CASE WHEN json_valid(payload) AND type='issue.created' THEN json_extract(payload,'$.state_name')
					WHEN json_valid(payload) THEN json_extract(payload,'$.to_state_name') END AS state_name,
				CASE WHEN json_valid(payload) AND type IN ('issue.created','issue.transitioned') THEN json_extract(payload,'$.workflow_id')
					WHEN json_valid(payload) THEN json_extract(payload,'$.workflow_to_id') END AS workflow_id,
				CASE WHEN json_valid(payload) AND type IN ('issue.created','issue.transitioned') THEN json_extract(payload,'$.workflow_name')
					WHEN json_valid(payload) THEN json_extract(payload,'$.workflow_to_name') END AS workflow_name,
				CASE WHEN json_valid(payload) AND type='issue.created' THEN json_extract(payload,'$.state_category')
					WHEN json_valid(payload) THEN json_extract(payload,'$.to_state_category') END AS category,
				CASE WHEN NOT json_valid(payload) THEN 1
					WHEN (CASE WHEN type='issue.created' THEN json_extract(payload,'$.state_id') ELSE json_extract(payload,'$.to_state_id') END) IS NULL THEN 1
					WHEN (CASE WHEN type IN ('issue.created','issue.transitioned') THEN json_extract(payload,'$.workflow_id') ELSE json_extract(payload,'$.workflow_to_id') END) IS NULL THEN 1
					WHEN (CASE WHEN type='issue.created' THEN json_extract(payload,'$.state_category') ELSE json_extract(payload,'$.to_state_category') END) IS NULL THEN 1 ELSE 0 END AS unavailable
			FROM event WHERE user_id=${owner} AND created_at>=${period.from}
				AND ${visibleEventProject}
				AND created_at<${observedThrough} AND issue_id>=${seek.issue}
				AND type IN ('issue.created','issue.transitioned','issue.updated')
				AND (type<>'issue.updated' OR NOT json_valid(payload)
					OR json_extract(payload,'$.workflow_to_id') IS NOT NULL
					OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.changed') WHERE value='workflow'))
		), flagged AS (
			SELECT *, CASE WHEN issue_id IS NOT NULL AND created_at<${period.to}
				AND workflow_id=${request.workflow} AND category='done'
				AND state_id IN (SELECT value FROM json_each(${JSON.stringify(selected.map((state) => state.id))}))
				AND (${projectId} IS NULL OR project_id=${projectId}) THEN 1 ELSE 0 END AS qualifies
			FROM normalized
		), ranked AS (
			SELECT *,
				SUM(qualifies) OVER (PARTITION BY issue_id ORDER BY created_at DESC,id DESC ROWS UNBOUNDED PRECEDING) AS qualifying_rank,
				MAX(CASE WHEN category IS NOT NULL AND category<>'done' THEN printf('%020d',created_at)||id END)
					OVER (PARTITION BY issue_id ORDER BY created_at DESC,id DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS witness_key,
				SUM(CASE WHEN unavailable=1 THEN 1 ELSE 0 END)
					OVER (PARTITION BY issue_id ORDER BY created_at DESC,id DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS unknown_later_entry_count
			FROM flagged
		), members AS (
			SELECT * FROM ranked WHERE qualifies=1 AND qualifying_rank=1
		)
		SELECT m.issue_id,m.id AS event_id,m.type AS event_type,m.project_id AS event_project_id,
			m.workflow_id,m.workflow_name,m.state_id,m.state_name,m.category,m.created_at AS entry_at,
			i.number AS issue_number,i.title AS issue_title,p.name AS project_name,
			CASE WHEN w.id IS NULL THEN 0 ELSE 1 END AS reopened,
			COALESCE(m.unknown_later_entry_count,0) AS unknown_later_entry_count,
			w.id AS witness_id,w.type AS witness_type,w.project_id AS witness_project_id,
			CASE WHEN json_valid(w.payload) AND w.type IN ('issue.created','issue.transitioned') THEN json_extract(w.payload,'$.workflow_id')
				WHEN json_valid(w.payload) THEN json_extract(w.payload,'$.workflow_to_id') END AS witness_workflow_id,
			CASE WHEN json_valid(w.payload) AND w.type IN ('issue.created','issue.transitioned') THEN json_extract(w.payload,'$.workflow_name')
				WHEN json_valid(w.payload) THEN json_extract(w.payload,'$.workflow_to_name') END AS witness_workflow_name,
			CASE WHEN json_valid(w.payload) AND w.type='issue.created' THEN json_extract(w.payload,'$.state_id')
				WHEN json_valid(w.payload) THEN json_extract(w.payload,'$.to_state_id') END AS witness_state_id,
			CASE WHEN json_valid(w.payload) AND w.type='issue.created' THEN json_extract(w.payload,'$.state_name')
				WHEN json_valid(w.payload) THEN json_extract(w.payload,'$.to_state_name') END AS witness_state_name,
			CASE WHEN json_valid(w.payload) AND w.type='issue.created' THEN json_extract(w.payload,'$.state_category')
				WHEN json_valid(w.payload) THEN json_extract(w.payload,'$.to_state_category') END AS witness_category,
			w.created_at AS witness_at,r.id AS run_id,r.created_at AS run_created_at,
			CASE WHEN r.ended_at<${period.to} THEN r.ended_at END AS ended_at,
			CASE WHEN r.ended_at<${period.to} THEN r.usage END AS usage
		FROM members m
		LEFT JOIN event w ON w.id=substr(m.witness_key,21) AND w.user_id=${owner} AND w.issue_id=m.issue_id
			AND ${visibleWitnessProject}
		LEFT JOIN issue i ON i.id=m.issue_id
		LEFT JOIN project p ON p.id=i.project_id
		LEFT JOIN agent_run r INDEXED BY agent_run_user_issue_created_idx
			ON r.user_id=${owner} AND r.issue_id=m.issue_id AND r.created_at<${period.to}
			AND ${visibleIssueProject}
			AND (r.created_at,r.id)>(CASE WHEN m.issue_id=${seek.issue} THEN ${seek.at} ELSE -1 END,CASE WHEN m.issue_id=${seek.issue} THEN ${seek.run} ELSE '' END)
		WHERE (i.id IS NULL OR p.user_id=${owner})
			AND (i.id IS NULL OR ${visibleIssueProject})
			AND (m.issue_id,COALESCE(r.created_at,-1),COALESCE(r.id,''))>(${seek.issue},${seek.at},${seek.run})
		ORDER BY m.issue_id,r.created_at,r.id LIMIT 5001`.execute(db);
		const batch = result.rows;
		for (const row of batch.slice(0, 5_000)) {
			if (current && current.row.issue_id !== row.issue_id) finishIssue();
			if (!current || current.row.issue_id !== row.issue_id)
				current = { row, acc: createUsageAccumulator(), attempts: 0, pending: 0 };
			const target = current;
			if (row.run_id === null) continue;
			target.attempts++;
			if (row.ended_at === null) target.pending++;
			else {
				const classification = classifyUsage(row.usage);
				addUsageClassification(target.acc, classification);
				addUsageClassification(global, classification);
				addUsageClassification(stateAcc.get(row.state_id)!, classification);
			}
			if (
				evidence?.request.kind === 'runs' &&
				(!evidence.request.member || evidence.request.member === row.issue_id) &&
				(evidence.request.population === 'pending') === (row.ended_at === null)
			) {
				const classification = row.ended_at === null ? null : classifyUsage(row.usage);
				evidence.totalCount++;
				if (classification) addUsageClassification(evidence.acc, classification);
				offerEvidence(evidence, {
					id: row.run_id,
					cost: classification?.cost_exact ?? null,
					at: row.ended_at ?? row.run_created_at!
				});
			}
		}
		if (batch.length <= 5_000) break;
		const last = batch[4_999];
		seek = { issue: last.issue_id, at: last.run_created_at ?? -1, run: last.run_id ?? '' };
	}
	finishIssue();
	const aggregate = finalizeUsage(global);
	const historyQuery = await sql<{
		examined: number;
		earliest: number | null;
		qualifying: number;
		malformed: number;
		missing: number;
		unavailable: number;
		null_issue: number;
		unknown_project: number;
	}>`WITH normalized AS (
		SELECT issue_id,project_id,created_at,json_valid(payload) AS valid,
			CASE WHEN json_valid(payload) AND type='issue.created' THEN json_extract(payload,'$.state_id')
				WHEN json_valid(payload) THEN json_extract(payload,'$.to_state_id') END AS state_id,
			CASE WHEN json_valid(payload) AND type IN ('issue.created','issue.transitioned') THEN json_extract(payload,'$.workflow_id')
				WHEN json_valid(payload) THEN json_extract(payload,'$.workflow_to_id') END AS workflow_id,
			CASE WHEN json_valid(payload) AND type='issue.created' THEN json_extract(payload,'$.state_category')
				WHEN json_valid(payload) THEN json_extract(payload,'$.to_state_category') END AS category
		FROM event WHERE user_id=${owner} AND created_at>=${period.from} AND created_at<${observedThrough}
			AND ${visibleEventProject}
			AND type IN ('issue.created','issue.transitioned','issue.updated')
			AND (type<>'issue.updated' OR NOT json_valid(payload)
				OR json_extract(payload,'$.workflow_to_id') IS NOT NULL
				OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.changed') WHERE value='workflow'))
	)
	SELECT COUNT(*) AS examined,MIN(created_at) AS earliest,
		COALESCE(SUM(CASE WHEN issue_id IS NOT NULL AND created_at<${period.to}
			AND workflow_id=${request.workflow} AND category='done'
			AND state_id IN (SELECT value FROM json_each(${JSON.stringify(selected.map((state) => state.id))}))
			AND (${projectId} IS NULL OR project_id=${projectId}) THEN 1 ELSE 0 END),0) AS qualifying,
		COALESCE(SUM(CASE WHEN valid=0 THEN 1 ELSE 0 END),0) AS malformed,
		COALESCE(SUM(CASE WHEN valid=1 AND state_id IS NULL THEN 1 ELSE 0 END),0) AS missing,
		COALESCE(SUM(CASE WHEN valid=1 AND state_id IS NOT NULL AND (workflow_id IS NULL OR category IS NULL) THEN 1 ELSE 0 END),0) AS unavailable,
		COALESCE(SUM(CASE WHEN issue_id IS NULL THEN 1 ELSE 0 END),0) AS null_issue,
		COALESCE(SUM(CASE WHEN project_id IS NULL THEN 1 ELSE 0 END),0) AS unknown_project
	FROM normalized`.execute(db);
	const historyResult = historyQuery.rows[0];
	const malformed = Number(historyResult.malformed);
	const missing = Number(historyResult.missing);
	const unavailable = Number(historyResult.unavailable);
	const examined = Number(historyResult.examined);
	const history: CohortUsageReport['history'] = {
		status:
			examined === 0
				? 'unavailable'
				: malformed || missing || unavailable
					? 'partial'
					: 'event_recorded',
		earliest_retained_at: historyResult.earliest,
		examined_entry_count: examined,
		qualifying_fact_count: Number(historyResult.qualifying),
		definition_classified_count: 0,
		missing_target_id_count: missing,
		unavailable_workflow_or_category_count: unavailable,
		null_issue_count: Number(historyResult.null_issue),
		malformed_count: malformed,
		unknown_project_count: Number(historyResult.unknown_project),
		from: period.from,
		to: observedThrough
	};
	return {
		mode: 'cohort',
		from: period.from,
		to: period.to,
		generated_at: generatedAt,
		observed_through: observedThrough,
		timezone: period.timezone,
		timezone_source: period.timezone_source,
		workflow: {
			id: request.workflow,
			name: workflow?.name ?? `Unavailable workflow (${request.workflow})`
		},
		selected_states: selected,
		selection_basis: selectionBasis,
		aggregate,
		counters: finishCounters(totals, aggregate),
		terminal_states: selected.map((state) => {
			const stateAggregate = finalizeUsage(stateAcc.get(state.id)!);
			return {
				state,
				aggregate: stateAggregate,
				counters: finishCounters(stateCounters.get(state.id)!, stateAggregate)
			};
		}),
		history,
		accounting_basis: 'finalized_before_cutoff_v1',
		membership_basis: 'latest_qualifying_entry_v1',
		retention_basis: 'retained_direct_attempts',
		project_basis: 'event_project',
		accounting_version: 1
	};
}

export function getCohortUsage(
	db: Kysely<Database>,
	owner: string,
	request: CohortUsageRequest,
	generatedAt = Date.now(),
	frozen?: {
		from: number;
		to: number;
		timezone: string;
		timezone_source: CohortUsageReport['timezone_source'];
		observed_through: number;
		selected_states: CohortStateProof[];
		selection_basis: CohortUsageReport['selection_basis'];
	},
	actor?: ActorContext
) {
	return buildCohortUsage(db, owner, request, generatedAt, frozen, undefined, actor);
}

export async function getCohortUsageEvidence(
	db: Kysely<Database>,
	owner: string,
	scopeToken: string,
	scope: Extract<UsageScopePayload, { mode: 'cohort' }>,
	request: EvidenceRequest,
	material: string,
	actor?: ActorContext
): Promise<UsageEvidencePage> {
	if (request.kind === 'issues' && request.population !== 'all')
		throw new Error('completed issue evidence uses the all-member population');
	if (request.kind === 'entries' && (request.population !== 'all' || request.sort !== 'time'))
		throw new Error('completion entry evidence uses the all-entry population sorted by time');
	if (request.kind === 'runs' && request.population === 'all')
		throw new Error('run evidence must select finalized or pending');
	if (request.population === 'pending' && request.sort === 'cost')
		throw new Error('pending evidence can only be sorted by time');
	let scopeProjectId: string | null = null;
	if (scope.project) {
		const project = await db
			.selectFrom('project')
			.select('id')
			.where((eb) => eb.or([eb('id', '=', scope.project!), eb('name', '=', scope.project!)]))
			.where('user_id', '=', owner)
			.executeTakeFirst();
		if (!project) throw new Error('Completed-issue project is no longer available');
		scopeProjectId = project.id;
		if (actor)
			requireAccess(
				actor,
				[{ domain: 'project', access: 'read', projectId: scopeProjectId }],
				'usage.read',
				{ projectId: scopeProjectId }
			);
	}
	let decoded = null;
	if (request.cursor) {
		decoded = await verifyUsageCursor(request.cursor, material);
		if (
			decoded.scope !== scopeToken ||
			decoded.kind !== request.kind ||
			decoded.population !== request.population ||
			decoded.member !== request.member ||
			decoded.sort !== request.sort ||
			decoded.direction !== request.direction
		)
			throw new Error('Cursor does not match evidence selection');
	}
	const traversal = decoded?.traversal ?? 'after';
	const evidence: CohortEvidenceBuild = {
		request,
		boundary: decoded?.boundary ?? null,
		traversal,
		winners: [],
		totalCount: 0,
		memberFound: false,
		memberAttempts: 0,
		memberPending: 0,
		memberAggregate: null,
		memberCounters: null,
		acc: createUsageAccumulator()
	};
	const report = await buildCohortUsage(
		db,
		owner,
		{ workflow: scope.workflow, project: scope.project ?? undefined },
		Date.now(),
		{
			from: scope.from,
			to: scope.to,
			timezone: scope.timezone,
			timezone_source: scope.timezone_source,
			observed_through: scope.observed_through,
			selected_states: scope.selected_states,
			selection_basis: scope.selection_basis
		},
		evidence,
		actor
	);
	if (!report) throw new Error('Completed-issue selection is no longer available');
	if (request.member && !evidence.memberFound)
		throw new Error('member is not in this completed-issue selection');
	if (request.kind === 'entries') {
		const cursorAt = evidence.boundary?.at ?? 0;
		const cursorId = evidence.boundary?.id ?? '';
		const after = evidence.traversal === 'after';
		const ascending = request.direction === 'asc';
		const timeOperator = after === ascending ? '>' : '<';
		const idOperator = after ? '>' : '<';
		const order = `${ascending === after ? 'ASC' : 'DESC'}, id ${after ? 'ASC' : 'DESC'}`;
		const entryResult = await sql<CohortEntry & { total_count: number }>`WITH normalized AS (
			SELECT id,type,issue_id,project_id,created_at,json_valid(payload) AS valid,
				CASE WHEN json_valid(payload) AND type='issue.created' THEN json_extract(payload,'$.state_id')
					WHEN json_valid(payload) THEN json_extract(payload,'$.to_state_id') END AS state_id,
				CASE WHEN json_valid(payload) AND type='issue.created' THEN json_extract(payload,'$.state_name')
					WHEN json_valid(payload) THEN json_extract(payload,'$.to_state_name') END AS state_name,
				CASE WHEN json_valid(payload) AND type IN ('issue.created','issue.transitioned') THEN json_extract(payload,'$.workflow_id')
					WHEN json_valid(payload) THEN json_extract(payload,'$.workflow_to_id') END AS workflow_id,
				CASE WHEN json_valid(payload) AND type IN ('issue.created','issue.transitioned') THEN json_extract(payload,'$.workflow_name')
					WHEN json_valid(payload) THEN json_extract(payload,'$.workflow_to_name') END AS workflow_name,
				CASE WHEN json_valid(payload) AND type='issue.created' THEN json_extract(payload,'$.state_category')
					WHEN json_valid(payload) THEN json_extract(payload,'$.to_state_category') END AS category
			FROM event WHERE user_id=${owner} AND created_at>=${scope.from} AND created_at<${scope.observed_through}
				AND ${actor ? projectReadPredicate(actor, 'event.project_id') : sql<boolean>`1 = 1`}
				AND type IN ('issue.created','issue.transitioned','issue.updated')
				AND (type<>'issue.updated' OR NOT json_valid(payload)
					OR json_extract(payload,'$.workflow_to_id') IS NOT NULL
					OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.changed') WHERE value='workflow'))
		), flagged AS (
			SELECT *,CASE WHEN issue_id IS NOT NULL AND created_at<${scope.to}
				AND workflow_id=${scope.workflow} AND category='done'
				AND state_id IN (SELECT value FROM json_each(${JSON.stringify(scope.selected_states.map((state) => state.id))}))
				AND (${scopeProjectId} IS NULL OR project_id=${scopeProjectId}) THEN 1 ELSE 0 END AS qualifies
			FROM normalized
		), ranked AS (
			SELECT *,SUM(qualifies) OVER (PARTITION BY issue_id ORDER BY created_at DESC,id DESC ROWS UNBOUNDED PRECEDING) AS qualifying_rank,
				SUM(qualifies) OVER (PARTITION BY issue_id ORDER BY created_at DESC,id DESC ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING) AS earlier_qualifying
			FROM flagged
		), members AS (
			SELECT DISTINCT r.issue_id FROM ranked r
			LEFT JOIN issue i ON i.id=r.issue_id
			LEFT JOIN project p ON p.id=i.project_id
			WHERE r.qualifies=1 AND (i.id IS NULL OR p.user_id=${owner})
				AND (i.id IS NULL OR ${actor ? projectReadPredicate(actor, 'p.id') : sql<boolean>`1 = 1`})
		), audited AS (
			SELECT *,COUNT(*) OVER () AS total_count FROM ranked
			WHERE issue_id IN (SELECT issue_id FROM members)
				AND (${request.member} IS NULL OR issue_id=${request.member})
		)
		SELECT id AS event_id,type AS event_type,issue_id,project_id,workflow_id,workflow_name,
			state_id,state_name,category,
			CASE WHEN valid=1 AND state_id IS NOT NULL AND workflow_id IS NOT NULL AND category IS NOT NULL THEN 'recorded_entry' END AS identity_basis,
			created_at,qualifies,(qualifies=1 AND qualifying_rank=1) AS chosen,
			(category IS NOT NULL AND category<>'done' AND COALESCE(earlier_qualifying,0)>0) AS reopening_relevant,
			CASE WHEN valid=0 THEN 'malformed_payload' WHEN state_id IS NULL THEN 'missing_target_state_id'
				WHEN workflow_id IS NULL OR category IS NULL THEN 'missing_workflow_or_category' END AS unavailable_reason,
			total_count FROM audited
		WHERE (${evidence.boundary === null ? 1 : 0} OR created_at ${sql.raw(timeOperator)} ${cursorAt}
			OR (created_at=${cursorAt} AND id ${sql.raw(idOperator)} ${cursorId}))
		ORDER BY created_at ${sql.raw(order)} LIMIT ${request.limit + 1}`.execute(db);
		const hasExtraEntries = entryResult.rows.length > request.limit;
		const pageRows = entryResult.rows.slice(0, request.limit);
		if (!after) pageRows.reverse();
		evidence.winners = pageRows.map((entry) => ({
			id: entry.event_id,
			cost: null,
			at: entry.created_at,
			item: entry
		}));
		evidence.totalCount = Number(entryResult.rows[0]?.total_count ?? 0);
		// Preserve whether the SQL page has another row on the requested side.
		if (hasExtraEntries) evidence.winners.push({ id: '', cost: null, at: 0 });
	}
	const hasExtra = evidence.winners.length > request.limit;
	const selected =
		traversal === 'before'
			? evidence.winners.slice(-request.limit)
			: evidence.winners.slice(0, request.limit);
	const items =
		request.kind === 'issues' || request.kind === 'entries'
			? selected.map((candidate) => candidate.item!)
			: await hydrateUsageEvidenceRuns(
					db,
					owner,
					selected.map((candidate) => candidate.id),
					request.population as 'finalized' | 'pending',
					scope.to,
					actor
				);
	if (items.length !== selected.length)
		throw new Error('Retained records changed while evidence was being assembled');
	const cursor = (candidate: EvidenceCandidate, nextTraversal: 'after' | 'before') =>
		mintUsageCursor(
			{
				v: 1,
				scope: scopeToken,
				kind: request.kind,
				population: request.population,
				member: request.member,
				sort: request.sort,
				direction: request.direction,
				traversal: nextTraversal,
				boundary: { id: candidate.id, cost: candidate.cost, at: candidate.at }
			},
			material
		);
	return {
		items: items as UsageEvidencePage['items'],
		next_cursor:
			selected.length && (hasExtra || traversal === 'before')
				? await cursor(selected.at(-1)!, 'after')
				: null,
		previous_cursor:
			selected.length &&
			((traversal === 'after' && decoded) || (traversal === 'before' && hasExtra))
				? await cursor(selected[0], 'before')
				: null,
		total_count: evidence.totalCount,
		scope: scopeToken,
		kind: request.kind,
		population: request.population,
		sort: request.sort,
		direction: request.direction,
		matching_total: request.member ? evidence.memberAggregate! : report.aggregate,
		parent_matching_total: request.member ? report.aggregate : undefined,
		counters: request.member ? evidence.memberCounters! : report.counters,
		parent_counters: request.member ? report.counters : undefined,
		history: report.history,
		from: report.from,
		to: report.to,
		observed_through: report.observed_through,
		attempt_count: request.member ? evidence.memberAttempts : report.counters.attempt_count,
		pending_count: request.member ? evidence.memberPending : report.counters.pending_count
	};
}
