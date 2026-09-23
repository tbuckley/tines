import type { TinesEvent } from '@tines/shared';
import { sql, type Kysely } from 'kysely';
import type { Database } from '$lib/server/db';
import { notFound, type ActorContext } from './core';

/** Member history has an explicit type and field allowlist. Payloads are private by default. */
const EVENT_TYPES = [
	'issue.created',
	'issue.updated',
	'issue.transitioned',
	'issue.commented',
	'issue.comment_edited',
	'issue.comment_deleted',
	'issue.link_added',
	'issue.link_removed',
	'issue.labeled',
	'issue.unlabeled',
	'issue.agent_hold_changed',
	'issue.parked',
	'issue.resumed',
	'issue.personal_permission_changed',
	'context.created',
	'context.updated',
	'context.deleted',
	'agent_run.started',
	'agent_run.ended',
	'project.sharing_started',
	'project.member_joined',
	'project.member_removed',
	'scheduled_task.created',
	'scheduled_task.updated',
	'scheduled_task.deleted',
	'scheduled_task.personal_permission_changed'
];

export async function listSharedEvents(
	db: Kysely<Database>,
	actor: ActorContext,
	opts: {
		projectId?: string;
		issueId?: string;
		type?: string[];
		since?: number;
		until?: number;
		state?: string;
		cursor?: { createdAt: number; id: string };
		limit: number;
	}
): Promise<{ items: TinesEvent[]; hasMore: boolean }> {
	if (actor.agentRunId) return { items: [], hasMore: false };
	let query = db
		.selectFrom('event as e')
		.leftJoin('issue as i', 'i.id', 'e.issue_id')
		.innerJoin('project as p', (join) =>
			join.on((eb) => eb('p.id', '=', eb.fn.coalesce('i.project_id', 'e.project_id')))
		)
		.innerJoin('project_member as m', (join) =>
			join.onRef('m.project_id', '=', 'p.id').on('m.user_id', '=', actor.userId)
		)
		.leftJoin('user as author', 'author.id', 'e.actor_user_id')
		.select([
			'e.id',
			'e.type',
			'e.issue_id',
			'e.project_id',
			'e.payload',
			'e.created_at',
			'e.actor_user_id',
			'p.id as current_project_id',
			'p.name as project_name',
			'i.number as issue_number',
			'i.title as issue_title',
			'author.name as actor_name',
			'm.revision as membership_revision'
		])
		.where('m.revoked_at', 'is', null)
		.where('p.shared_at', 'is not', null)
		.where('p.user_id', '!=', actor.userId)
		.where('e.type', 'in', EVENT_TYPES)
		.where(
			sql<boolean>`(e.type NOT IN ('context.created','context.updated','context.deleted')
			OR json_extract(e.payload, '$.kind') = 'artifact')`
		)
		.where((eb) => eb.or([eb('e.issue_id', 'is', null), eb('i.id', 'is not', null)]))
		.orderBy('e.created_at desc')
		.orderBy('e.id desc')
		.limit(opts.limit + 1);
	if (opts.projectId) query = query.where('p.id', '=', opts.projectId);
	if (opts.issueId) query = query.where('e.issue_id', '=', opts.issueId);
	if (opts.type?.length) query = query.where('e.type', 'in', opts.type);
	if (opts.since !== undefined) query = query.where('e.created_at', '>=', opts.since);
	if (opts.until !== undefined) query = query.where('e.created_at', '<', opts.until);
	if (opts.state)
		query = query.where(sql<boolean>`(json_extract(e.payload, '$.from_state_id') = ${opts.state}
		OR json_extract(e.payload, '$.to_state_id') = ${opts.state}
		OR json_extract(e.payload, '$.state_id') = ${opts.state})`);
	if (opts.cursor)
		query = query.where((eb) =>
			eb.or([
				eb('e.created_at', '<', opts.cursor!.createdAt),
				eb.and([eb('e.created_at', '=', opts.cursor!.createdAt), eb('e.id', '<', opts.cursor!.id)])
			])
		);
	const rows = await query.execute();
	const revisions = await db
		.selectFrom('project_member')
		.select(['project_id', 'revision'])
		.where('user_id', '=', actor.userId)
		.where('revoked_at', 'is', null)
		.execute();
	const current = new Map(revisions.map((row) => [row.project_id, row.revision]));
	if (rows.some((row) => current.get(row.current_project_id) !== row.membership_revision))
		throw notFound();
	return {
		items: rows.slice(0, opts.limit).map((row) => ({
			id: row.id,
			type: row.type,
			created_at: row.created_at,
			actor: {
				user_id: row.actor_user_id,
				user_name: row.actor_name ?? 'Former participant',
				api_key_id: null,
				api_key_name: null
			},
			issue_id: row.issue_id,
			project_id: row.current_project_id,
			issue_ref:
				row.issue_id && row.issue_number != null
					? {
							project_name: row.project_name,
							number: row.issue_number,
							title: row.issue_title ?? ''
						}
					: null,
			project_name: row.project_name,
			payload: {}
		})),
		hasMore: rows.length > opts.limit
	};
}
