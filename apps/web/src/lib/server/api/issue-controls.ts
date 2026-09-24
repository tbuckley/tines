import type { AgentHoldReceipt, AgentHoldRequest } from '@tines/shared';
import { sql, type Kysely } from 'kysely';
import { newId, type Database } from '$lib/server/db';
import { ApiFail, notFound, runAtomic, type ActorContext } from './core';
import { eventInsert } from './events';
import { releaseAssignedIssueQueries } from '../supervisor/consent-admission';
import { requireAccess } from './permissions';

export async function writeIssueHold(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	issueId: string,
	body: AgentHoldRequest
): Promise<AgentHoldReceipt> {
	if (
		typeof body.held !== 'boolean' ||
		!Number.isInteger(body.expected_revision) ||
		body.expected_revision < 0
	) {
		throw new ApiFail(422, 'invalid_field', 'Pass held and a non-negative expected_revision');
	}
	const current = await db
		.selectFrom('issue as i')
		.innerJoin('project as p', 'p.id', 'i.project_id')
		.innerJoin('workflow_state as s', 's.id', 'i.state_id')
		.select([
			'i.project_id',
			'i.agent_hold',
			'i.hold_revision',
			's.category',
			'p.shared_at',
			'p.archived_at'
		])
		.where('i.id', '=', issueId)
		.where('p.user_id', '=', actor.userId)
		.executeTakeFirst();
	if (!current || current.shared_at === null) throw notFound();
	requireAccess(
		actor,
		[
			{ domain: 'project', access: 'write', projectId: current.project_id },
			{ domain: 'control_plane', access: 'write' }
		],
		'issue.hold',
		{ projectId: current.project_id, issueId }
	);
	if (current.category === 'done')
		throw new ApiFail(422, 'issue_terminal', 'A done issue cannot be held');
	if (current.hold_revision !== body.expected_revision) {
		throw new ApiFail(409, 'conflict', 'The owner hold changed; refresh before updating it', {
			committed: false,
			current_revision: current.hold_revision
		});
	}
	if (Boolean(current.agent_hold) === body.held) {
		return {
			issue_id: issueId,
			held: body.held,
			revision: current.hold_revision,
			released_assigned: 0,
			message: body.held
				? 'Held; approved work will not be admitted.'
				: 'Released; approved work may be admitted.'
		};
	}
	const now = Date.now();
	const revision = current.hold_revision + 1;
	const token = newId('hld');
	const holdGuard = sql<boolean>`EXISTS (SELECT 1 FROM issue i JOIN project p ON p.id = i.project_id
		WHERE i.id = ${issueId} AND p.user_id = ${actor.userId} AND p.shared_at IS NOT NULL
			AND i.hold_revision = ${revision} AND i.agent_hold = ${body.held ? 1 : 0})`;
	const queries = [
		db
			.updateTable('issue')
			.set({ agent_hold: body.held ? 1 : 0, hold_revision: revision })
			.where('id', '=', issueId)
			.where('hold_revision', '=', body.expected_revision)
			.where('agent_hold', '=', body.held ? 0 : 1)
			.where(
				sql<boolean>`EXISTS (SELECT 1 FROM project p WHERE p.id = issue.project_id
				AND p.user_id = ${actor.userId} AND p.shared_at IS NOT NULL)`
			)
			.compile(),
		...(body.held
			? releaseAssignedIssueQueries(db, {
					issueId,
					userId: actor.userId,
					token,
					eventId: newId('evt'),
					now,
					reason: 'Issue is held by its owner',
					guard: holdGuard
				})
			: []),
		eventInsert(
			db,
			actor,
			{
				type: 'issue.agent_hold_changed',
				issueId,
				projectId: current.project_id,
				payload: { held: body.held, revision }
			},
			{ predicate: holdGuard }
		)
	];
	const results = await runAtomic(env, queries);
	if ((results[0]?.meta.changes ?? 0) !== 1) {
		throw new ApiFail(409, 'conflict', 'The owner hold changed; refresh before updating it', {
			committed: false
		});
	}
	const releaseIndex = body.held ? 1 : -1;
	return {
		issue_id: issueId,
		held: body.held,
		revision,
		released_assigned: releaseIndex >= 0 ? (results[releaseIndex]?.meta.changes ?? 0) : 0,
		message: body.held
			? 'Held; approved work will not be admitted.'
			: 'Released; approved work may be admitted.'
	};
}
