import {
	addUsageClassification,
	classifyUsage,
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
	type UsagePeriodInput
} from '@tines/shared';
import { sql, type Kysely } from 'kysely';
import type { Database } from '$lib/server/db';
import { configuredTimezone } from './usage';

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

export async function getCohortUsage(
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
	}
): Promise<CohortUsageReport | null> {
	const period = frozen
		? { ...frozen, generated_at: generatedAt }
		: resolveUsagePeriod(request, await configuredTimezone(db, owner), generatedAt);
	const workflow = await db
		.selectFrom('workflow')
		.select(['id', 'name', 'user_id'])
		.where('id', '=', request.workflow)
		.where((eb) => eb.or([eb('user_id', '=', owner), eb('user_id', 'is', null)]))
		.executeTakeFirst();
	if (request.project) {
		const project = await db
			.selectFrom('project')
			.select('id')
			.where('id', '=', request.project)
			.where('user_id', '=', owner)
			.executeTakeFirst();
		if (!project) return null;
	}
	const rows = await db
		.selectFrom('event')
		.select(['id', 'type', 'issue_id', 'project_id', 'payload', 'created_at'])
		.where('user_id', '=', owner)
		.where('created_at', '>=', period.from)
		.where('created_at', '<', frozen?.observed_through ?? generatedAt)
		.where('type', 'in', ['issue.created', 'issue.transitioned', 'issue.updated'])
		.orderBy('created_at')
		.orderBy('id')
		.execute();
	const entries = rows
		.map(normalize)
		.filter((entry) => entry.potential || entry.unavailable_reason);
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
			const event = entries.find(
				(item) =>
					item.workflow_id === request.workflow && item.state_id === id && item.category === 'done'
			);
			return event
				? [
						{
							id,
							name: event.state_name ?? id,
							category: 'done' as const,
							basis: 'recorded_entry' as const,
							proof_event_id: event.event_id
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
		const retained = new Map<string, Normalized>();
		for (const entry of entries)
			if (entry.workflow_id === request.workflow && entry.state_id && entry.category === 'done')
				retained.set(entry.state_id, entry);
		selected = [...retained.values()].map((entry) => ({
			id: entry.state_id!,
			name: entry.state_name ?? entry.state_id!,
			category: 'done',
			basis: 'recorded_entry',
			proof_event_id: entry.event_id
		}));
		selectionBasis = selected.length ? 'retained_recorded_done' : 'unavailable';
	}
	if (!workflow && !entries.some((entry) => entry.workflow_id === request.workflow)) return null;
	const selectedIds = new Set(selected.map((state) => state.id));
	const chosen = new Map<string, Normalized>();
	for (const entry of entries) {
		entry.qualifies = !!(
			entry.issue_id &&
			entry.created_at < period.to &&
			entry.workflow_id === request.workflow &&
			entry.state_id &&
			selectedIds.has(entry.state_id) &&
			entry.category === 'done' &&
			(!request.project || entry.project_id === request.project)
		);
		if (entry.qualifies) chosen.set(entry.issue_id!, entry);
	}
	for (const entry of chosen.values()) entry.chosen = true;
	const issueRefs = new Map<string, CohortIssueUsage['issue_ref']>();
	const currentIssues = await db
		.selectFrom('issue')
		.innerJoin('project', 'project.id', 'issue.project_id')
		.select([
			'issue.id',
			'issue.number',
			'issue.title',
			'project.name as project_name',
			'project.user_id as project_owner'
		])
		.execute();
	for (const issue of currentIssues) {
		if (issue.project_owner !== owner) {
			// An owned retained event is not authority to disclose or claim a current
			// issue identity that now resolves to another account.
			chosen.delete(issue.id);
			continue;
		}
		issueRefs.set(issue.id, {
			project_name: issue.project_name,
			number: issue.number,
			title: issue.title
		});
	}
	const stateAcc = new Map(selected.map((state) => [state.id, createUsageAccumulator()]));
	const global = createUsageAccumulator();
	const issueAcc = new Map(
		[...chosen].map(([id, entry]) => [
			id,
			{ entry, acc: createUsageAccumulator(), attempts: 0, pending: 0 }
		])
	);
	let seek: { at: number; id: string } | null = null;
	for (;;) {
		let query = db
			.selectFrom('agent_run')
			.select([
				'id',
				'issue_id',
				'created_at',
				sql<number | null>`CASE WHEN ended_at < ${period.to} THEN ended_at END`.as('ended_at'),
				sql<string | null>`CASE WHEN ended_at < ${period.to} THEN usage END`.as('usage')
			])
			.where('user_id', '=', owner)
			.where('created_at', '<', period.to);
		if (seek) query = query.where(sql<boolean>`(created_at,id) > (${seek.at},${seek.id})`);
		const batch = await query.orderBy('created_at').orderBy('id').limit(5_001).execute();
		for (const run of batch.slice(0, 5_000)) {
			if (!run.issue_id) continue;
			const target = issueAcc.get(run.issue_id);
			if (!target) continue;
			target.attempts++;
			if (run.ended_at === null) target.pending++;
			else {
				const classification = classifyUsage(run.usage);
				addUsageClassification(target.acc, classification);
				addUsageClassification(global, classification);
				addUsageClassification(stateAcc.get(target.entry.state_id!)!, classification);
			}
		}
		if (batch.length <= 5_000) break;
		const last = batch[4_999];
		seek = { at: last.created_at, id: last.id };
	}
	const observedThrough = frozen?.observed_through ?? generatedAt;
	const issues: CohortIssueUsage[] = [];
	for (const [id, value] of issueAcc) {
		const later = entries.filter(
			(entry) =>
				entry.issue_id === id &&
				(entry.created_at > value.entry.created_at ||
					(entry.created_at === value.entry.created_at && entry.event_id > value.entry.event_id))
		);
		const witness = later.find((entry) => entry.category && entry.category !== 'done') ?? null;
		if (witness) witness.reopening_relevant = true;
		const unknown = later.filter((entry) => entry.potential && !!entry.unavailable_reason).length;
		const aggregate = finalizeUsage(value.acc);
		issues.push({
			issue_id: id,
			issue_ref: issueRefs.get(id) ?? null,
			aggregate,
			attempt_count: value.attempts,
			pending_count: value.pending,
			fully_priced:
				aggregate.finalized_run_count > 0 &&
				aggregate.priced_run_count === aggregate.finalized_run_count &&
				value.pending === 0,
			latest_at: value.entry.created_at,
			chosen_entry: value.entry,
			reopening: {
				value: witness ? true : unknown ? null : false,
				witness,
				unknown_later_entry_count: unknown,
				observed_through: observedThrough
			}
		});
	}
	const aggregate = finalizeUsage(global);
	const malformed = entries.filter(
		(entry) => entry.unavailable_reason === 'malformed_payload'
	).length;
	const missing = entries.filter(
		(entry) => entry.unavailable_reason === 'missing_target_state_id'
	).length;
	const unavailable = entries.filter(
		(entry) => entry.unavailable_reason === 'missing_workflow_or_category'
	).length;
	const definitionCount = entries.filter(
		(entry) => entry.identity_basis === 'current_definition'
	).length;
	const history: CohortUsageReport['history'] = {
		status:
			entries.length === 0
				? 'unavailable'
				: malformed || missing || unavailable
					? 'partial'
					: definitionCount
						? 'definition_based'
						: 'event_recorded',
		earliest_retained_at: entries[0]?.created_at ?? null,
		examined_entry_count: entries.length,
		qualifying_fact_count: entries.filter((entry) => entry.qualifies).length,
		definition_classified_count: definitionCount,
		missing_target_id_count: missing,
		unavailable_workflow_or_category_count: unavailable,
		null_issue_count: entries.filter((entry) => entry.issue_id === null).length,
		malformed_count: malformed,
		unknown_project_count: entries.filter((entry) => entry.project_id === null).length,
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
		counters: counters(issues, aggregate),
		terminal_states: selected.map((state) => {
			const matching = issues.filter((issue) => issue.chosen_entry.state_id === state.id);
			const stateAggregate = finalizeUsage(stateAcc.get(state.id)!);
			return { state, aggregate: stateAggregate, counters: counters(matching, stateAggregate) };
		}),
		history,
		accounting_basis: 'finalized_before_cutoff_v1',
		membership_basis: 'latest_qualifying_entry_v1',
		retention_basis: 'retained_direct_attempts',
		project_basis: 'event_project',
		accounting_version: 1
	};
}
