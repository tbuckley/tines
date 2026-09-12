import type { Kysely } from 'kysely';
import type { Database } from '$lib/server/db';

export type UsageIdentityKind = 'project' | 'workflow' | 'state' | 'runner';

/**
 * Authorize a period filter from either live owned metadata or an owned retained run fact.
 * The user fence is on every retained lookup; callers deliberately turn false into the
 * same non-disclosing 404 used for nonexistent live metadata.
 */
export async function ownsUsageIdentity(
	db: Kysely<Database>,
	userId: string,
	kind: UsageIdentityKind,
	id: string | null | undefined,
	workflow?: string | null
): Promise<boolean> {
	if (!id || id === 'unknown') return true;
	if (kind === 'project') {
		const live = await db
			.selectFrom('project')
			.select('id')
			.where('id', '=', id)
			.where('user_id', '=', userId)
			.executeTakeFirst();
		if (live) return true;
		return Boolean(
			await db
				.selectFrom('agent_run')
				.innerJoin('issue', 'issue.id', 'agent_run.issue_id')
				.select('agent_run.id')
				.where('agent_run.user_id', '=', userId)
				.where('issue.project_id', '=', id)
				.limit(1)
				.executeTakeFirst()
		);
	}
	if (kind === 'runner') {
		const live = await db
			.selectFrom('runner')
			.select('id')
			.where('id', '=', id)
			.where('user_id', '=', userId)
			.executeTakeFirst();
		if (live) return true;
		return Boolean(
			await db
				.selectFrom('agent_run')
				.select('id')
				.where('user_id', '=', userId)
				.where('runner_id', '=', id)
				.limit(1)
				.executeTakeFirst()
		);
	}
	if (kind === 'workflow') {
		const live = await db
			.selectFrom('workflow')
			.select('id')
			.where('id', '=', id)
			.where((eb) => eb.or([eb('user_id', '=', userId), eb('user_id', 'is', null)]))
			.executeTakeFirst();
		if (live) return true;
		return Boolean(
			await db
				.selectFrom('agent_run')
				.leftJoin('issue', 'issue.id', 'agent_run.issue_id')
				.leftJoin('workflow_state as start_state', 'start_state.id', 'agent_run.state_id_at_start')
				.select('agent_run.id')
				.where('agent_run.user_id', '=', userId)
				.where((eb) =>
					eb.or([
						eb('start_state.workflow_id', '=', id),
						eb.and([eb('start_state.id', 'is', null), eb('issue.workflow_id', '=', id)])
					])
				)
				.limit(1)
				.executeTakeFirst()
		);
	}
	const live = await db
		.selectFrom('workflow_state')
		.innerJoin('workflow', 'workflow.id', 'workflow_state.workflow_id')
		.select('workflow_state.id')
		.where('workflow_state.id', '=', id)
		.where('workflow_state.workflow_id', '=', workflow!)
		.where((eb) => eb.or([eb('workflow.user_id', '=', userId), eb('workflow.user_id', 'is', null)]))
		.executeTakeFirst();
	if (live) return true;
	return Boolean(
		await db
			.selectFrom('agent_run')
			.leftJoin('issue', 'issue.id', 'agent_run.issue_id')
			.leftJoin('workflow_state as start_state', 'start_state.id', 'agent_run.state_id_at_start')
			.select('agent_run.id')
			.where('agent_run.user_id', '=', userId)
			.where('agent_run.state_id_at_start', '=', id)
			.where((eb) =>
				workflow === 'unknown'
					? eb.or([eb('start_state.id', 'is', null), eb('start_state.workflow_id', 'is', null)])
					: eb.or([
							eb('start_state.workflow_id', '=', workflow!),
							eb.and([eb('start_state.id', 'is', null), eb('issue.workflow_id', '=', workflow!)])
						])
			)
			.limit(1)
			.executeTakeFirst()
	);
}
