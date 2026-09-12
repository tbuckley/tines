import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { Database } from '$lib/server/db';

export interface UsageIdentityFilters {
	project?: string | null;
	workflow?: string | null;
	state?: string | null;
	runner?: string | null;
	issue?: string | null;
}

type RetainedKind = keyof UsageIdentityFilters;

/**
 * Authorize a period filter from either live owned metadata or an owned retained run fact.
 * The user fence is on every retained lookup; callers deliberately turn false into the
 * same non-disclosing 404 used for nonexistent live metadata.
 */
export async function authorizeUsageFilters(
	db: Kysely<Database>,
	userId: string,
	filters: UsageIdentityFilters
): Promise<boolean> {
	const requested = Object.entries(filters).filter((entry): entry is [RetainedKind, string] =>
		Boolean(entry[1] && entry[1] !== 'unknown')
	);
	if (!requested.length) return true;
	const live = new Map<RetainedKind, boolean>();
	for (const [kind, id] of requested) {
		let found: unknown;
		if (kind === 'project')
			found = await db
				.selectFrom('project')
				.select('id')
				.where('id', '=', id)
				.where('user_id', '=', userId)
				.executeTakeFirst();
		else if (kind === 'runner')
			found = await db
				.selectFrom('runner')
				.select('id')
				.where('id', '=', id)
				.where('user_id', '=', userId)
				.executeTakeFirst();
		else if (kind === 'issue')
			found = await db
				.selectFrom('issue')
				.innerJoin('project', 'project.id', 'issue.project_id')
				.select('issue.id')
				.where('issue.id', '=', id)
				.where('project.user_id', '=', userId)
				.executeTakeFirst();
		else if (kind === 'workflow')
			found = await db
				.selectFrom('workflow')
				.select('id')
				.where('id', '=', id)
				.where((eb) => eb.or([eb('user_id', '=', userId), eb('user_id', 'is', null)]))
				.executeTakeFirst();
		else
			found = await db
				.selectFrom('workflow_state')
				.innerJoin('workflow', 'workflow.id', 'workflow_state.workflow_id')
				.select('workflow_state.id')
				.where('workflow_state.id', '=', id)
				.where('workflow_state.workflow_id', '=', filters.workflow!)
				.where((eb) =>
					eb.or([eb('workflow.user_id', '=', userId), eb('workflow.user_id', 'is', null)])
				)
				.executeTakeFirst();
		live.set(kind, Boolean(found));
	}
	const unresolved = requested.filter(([kind]) => !live.get(kind));
	if (!unresolved.length) return true;
	const flags = unresolved.map(([kind, id]) => {
		let predicate: RawBuilder<boolean>;
		if (kind === 'project') predicate = sql<boolean>`issue.project_id = ${id}`;
		else if (kind === 'runner') predicate = sql<boolean>`agent_run.runner_id = ${id}`;
		else if (kind === 'issue') predicate = sql<boolean>`agent_run.issue_id = ${id}`;
		else if (kind === 'workflow')
			predicate = sql<boolean>`COALESCE(start_state.workflow_id, issue.workflow_id) = ${id}`;
		else
			predicate = sql<boolean>`agent_run.state_id_at_start = ${id} AND ${
				filters.workflow === 'unknown'
					? sql<boolean>`start_state.workflow_id IS NULL AND issue.workflow_id IS NULL`
					: sql<boolean>`COALESCE(start_state.workflow_id, issue.workflow_id) = ${filters.workflow}`
			}`;
		return sql<number>`MAX(CASE WHEN ${predicate} THEN 1 ELSE 0 END)`.as(kind);
	});
	const retained = await db
		.selectFrom('agent_run')
		.leftJoin('issue', 'issue.id', 'agent_run.issue_id')
		.leftJoin('workflow_state as start_state', 'start_state.id', 'agent_run.state_id_at_start')
		.select(flags)
		.where('agent_run.user_id', '=', userId)
		.executeTakeFirstOrThrow();
	return unresolved.every(([kind]) => Number(retained[kind]) === 1);
}
