import { sql, type Kysely } from 'kysely';
import type { Database } from '$lib/server/db';
import { getArtifactStore } from '$lib/server/artifact-store';
import type { Artifact, ArtifactDetail, ArtifactVersion, ArtifactType } from '@tines/shared';
import { checkRequirements } from './artifacts';
import { ApiFail, notFound, type ActorContext } from './core';
import { resolveIssueAccess, resolveProjectAccess } from './project-access';
import { sharedEventPayload } from './shared-events';
import { projectReadPredicate } from './permissions';

const SAFE_EVENTS = [
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
	'context.created',
	'context.updated',
	'context.deleted',
	'issue.agent_hold_changed',
	'issue.personal_permission_changed',
	'agent_run.started',
	'agent_run.ended',
	'issue.parked',
	'issue.resumed'
];

export async function readSharedIssue(
	db: Kysely<Database>,
	actor: ActorContext,
	lookup: { id: string } | { projectId: string; number: number },
	beforeFinalCheck?: () => Promise<void>
) {
	let query = db
		.selectFrom('issue as i')
		.innerJoin('project as p', 'p.id', 'i.project_id')
		.innerJoin('user as owner', 'owner.id', 'p.user_id')
		.innerJoin('workflow as w', 'w.id', 'i.workflow_id')
		.innerJoin('workflow_state as s', 's.id', 'i.state_id')
		.leftJoin('issue_schedule_origin as origin', 'origin.issue_id', 'i.id')
		.select([
			'i.id',
			'i.project_id',
			'i.number',
			'i.title',
			'i.description',
			'i.created_at',
			'i.updated_at',
			'i.state_entered_at',
			'i.decision_revision',
			'w.decision_revision as workflow_revision',
			'i.consent_epoch',
			'i.agent_hold',
			'i.hold_revision',
			'i.needs_attention',
			'p.name as project_name',
			'p.archived_at as project_archived_at',
			'owner.id as owner_id',
			'owner.name as owner_name',
			'w.id as workflow_id',
			'w.name as workflow_name',
			's.id as state_id',
			's.name as state_name',
			's.category as state_category',
			'origin.schedule_id',
			'origin.schedule_name'
		]);
	if ('id' in lookup) query = query.where('i.id', '=', lookup.id);
	else
		query = query.where((eb) =>
			eb.exists(
				eb
					.selectFrom('issue_address as a')
					.select('a.issue_id')
					.whereRef('a.issue_id', '=', 'i.id')
					.where('a.project_id', '=', lookup.projectId)
					.where('a.number', '=', lookup.number)
			)
		);
	const row = await query.executeTakeFirst();
	if (!row) throw notFound();
	const access = await resolveProjectAccess(db, actor, row.project_id);
	// A foreign owner's issue is serialized from this allowlist only.
	const [
		comments,
		artifactRows,
		eventRows,
		states,
		transitions,
		choice,
		labels,
		links,
		memberRows,
		ownerChoice,
		run
	] = await Promise.all([
		db
			.selectFrom('comment as c')
			.leftJoin('user as u', 'u.id', 'c.actor_user_id')
			.leftJoin('user as editor', 'editor.id', 'c.editor_user_id')
			.select([
				'c.id',
				'c.body',
				'c.created_at',
				'c.updated_at',
				'c.actor_user_id',
				'u.name as author_name',
				'c.author_run_id',
				'c.author_run_name',
				'c.editor_user_id',
				'editor.name as editor_name'
			])
			.where('c.issue_id', '=', row.id)
			.orderBy('c.created_at')
			.execute(),
		listSharedArtifacts(db, row.id, row.state_entered_at ?? row.created_at),
		db
			.selectFrom('event as e')
			.leftJoin('user as event_actor', 'event_actor.id', 'e.actor_user_id')
			.select([
				'e.id',
				'e.type',
				'e.created_at',
				'e.actor_user_id',
				'event_actor.name as actor_name',
				'e.payload'
			])
			.where('e.issue_id', '=', row.id)
			.where('e.type', 'in', SAFE_EVENTS)
			.where(
				sql<boolean>`(e.type NOT IN ('context.created','context.updated','context.deleted') OR json_extract(e.payload, '$.kind') = 'artifact')`
			)
			.orderBy('e.created_at desc')
			.orderBy('e.id desc')
			.limit(100)
			.execute(),
		db
			.selectFrom('workflow_state')
			.select(['id', 'name', 'category', 'position'])
			.where('workflow_id', '=', row.workflow_id)
			.orderBy('position')
			.execute(),
		db
			.selectFrom('workflow_transition')
			.select(['id', 'name', 'from_state_id', 'to_state_id', 'requirements'])
			.where('workflow_id', '=', row.workflow_id)
			.execute(),
		db
			.selectFrom('issue_personal_choice')
			.select(['value', 'revision', 'issue_epoch', 'source_kind', 'membership_revision'])
			.where('issue_id', '=', row.id)
			.where('user_id', '=', actor.userId)
			.executeTakeFirst(),
		db
			.selectFrom('issue_label as il')
			.innerJoin('label as l', 'l.id', 'il.label_id')
			.select(['l.id', 'l.name', 'l.color'])
			.where('il.issue_id', '=', row.id)
			.execute(),
		db
			.selectFrom('issue_link as l')
			.select(['l.id', 'l.kind', 'l.source_issue_id', 'l.target_issue_id'])
			.where((eb) =>
				eb.or([eb('l.source_issue_id', '=', row.id), eb('l.target_issue_id', '=', row.id)])
			)
			.execute(),
		db
			.selectFrom('project_member as m')
			.innerJoin('user as u', 'u.id', 'm.user_id')
			.leftJoin('issue_personal_choice as c', (join) =>
				join.onRef('c.user_id', '=', 'm.user_id').on('c.issue_id', '=', row.id)
			)
			.select([
				'm.user_id',
				'm.revision as membership_revision',
				'u.name',
				'c.value',
				'c.issue_epoch',
				'c.membership_revision as choice_member_revision'
			])
			.where('m.project_id', '=', row.project_id)
			.where('m.revoked_at', 'is', null)
			.orderBy('m.joined_at')
			.orderBy('m.user_id')
			.execute(),
		db
			.selectFrom('issue_personal_choice')
			.select(['value', 'issue_epoch'])
			.where('issue_id', '=', row.id)
			.where('user_id', '=', row.owner_id)
			.executeTakeFirst(),
		db
			.selectFrom('agent_run')
			.select(['status', 'started_at', 'ended_at'])
			.where('issue_id', '=', row.id)
			.orderBy('created_at desc')
			.executeTakeFirst()
	]);
	// Resolve link targets through current access. Inaccessible blockers become a generic flag.
	const visibleLinks = [] as {
		id: string;
		kind: string;
		issue_id: string;
		project_id: string;
		relation: string;
		project_name: string;
		number: number;
		title: string;
		membership_revision: number | null;
		blocks_this: boolean;
	}[];
	let blockedByPrivateIssue = false;
	for (const link of links) {
		const otherId = link.source_issue_id === row.id ? link.target_issue_id : link.source_issue_id;
		try {
			const targetAccess = await resolveIssueAccess(db, actor, otherId);
			const target = await db
				.selectFrom('issue as i')
				.innerJoin('project as p', 'p.id', 'i.project_id')
				.select(['i.number', 'i.title', 'p.name as project_name'])
				.where('i.id', '=', otherId)
				.executeTakeFirstOrThrow();
			visibleLinks.push({
				id: link.id,
				kind: link.kind,
				issue_id: otherId,
				relation:
					link.kind === 'blocks'
						? link.source_issue_id === row.id
							? 'Blocks'
							: 'Blocked by'
						: link.source_issue_id === row.id
							? 'Duplicate of'
							: 'Duplicated by',
				project_id: targetAccess.projectId,
				project_name: target.project_name,
				number: target.number,
				title: target.title,
				membership_revision: targetAccess.membershipRevision,
				blocks_this: link.kind === 'blocks' && link.target_issue_id === row.id
			});
		} catch {
			if (link.kind === 'blocks' && link.target_issue_id === row.id) blockedByPrivateIssue = true;
		}
	}
	const allowed = transitions
		.filter((transition) => transition.from_state_id === row.state_id)
		.map((transition) => ({
			id: transition.id,
			name: transition.name,
			to_state_id: transition.to_state_id,
			// Live status, as the owner's read reports it, so the member page can
			// show which artifact a gated move still needs before it is tried.
			requires: transition.requirements
				? checkRequirements(
						JSON.parse(transition.requirements),
						artifactRows,
						`${row.project_name}/${row.number}`
					)
				: []
		}));
	await beforeFinalCheck?.();
	const currentLinks = [] as typeof visibleLinks;
	for (const link of visibleLinks) {
		try {
			const current = await resolveIssueAccess(db, actor, link.issue_id);
			if (current.membershipRevision === link.membership_revision) currentLinks.push(link);
			else if (link.blocks_this) blockedByPrivateIssue = true;
		} catch {
			if (link.blocks_this) blockedByPrivateIssue = true;
		}
	}
	if (
		access.role === 'member' &&
		(await resolveProjectAccess(db, actor, row.project_id)).membershipRevision !==
			access.membershipRevision
	)
		throw notFound();
	return {
		mode: 'member' as const,
		id: row.id,
		project: {
			id: row.project_id,
			name: row.project_name,
			owner: { id: row.owner_id, name: row.owner_name },
			archived_at: row.project_archived_at
		},
		viewer_role: access.role,
		viewer_id: actor.userId,
		number: row.number,
		title: row.title,
		description: row.description,
		created_at: row.created_at,
		updated_at: row.updated_at,
		state_entered_at: row.state_entered_at ?? row.created_at,
		state: { id: row.state_id, name: row.state_name, category: row.state_category },
		workflow: { id: row.workflow_id, name: row.workflow_name, states, transitions: allowed },
		labels,
		links: currentLinks.map(
			({ membership_revision: _revision, blocks_this: _blocks, ...link }) => link
		),
		blocked_by_private_issue: blockedByPrivateIssue,
		comments: comments.map((comment) => ({
			id: comment.id,
			body: comment.body,
			created_at: comment.created_at,
			updated_at: comment.updated_at,
			author: {
				id: comment.actor_user_id,
				name: comment.author_name ?? 'Former participant',
				run: comment.author_run_id
					? { id: comment.author_run_id, name: comment.author_run_name ?? 'Former runner' }
					: null
			},
			editor: comment.editor_user_id
				? { id: comment.editor_user_id, name: comment.editor_name ?? 'Former participant' }
				: null
		})),
		artifacts: artifactRows,
		history: eventRows.map((event) => ({
			id: event.id,
			type: event.type,
			created_at: event.created_at,
			actor_user_id: event.actor_user_id,
			actor_name: event.actor_name ?? 'Former participant',
			payload: sharedEventPayload(event.type, event.payload)
		})),
		roster: [
			{
				user: { id: row.owner_id, name: row.owner_name },
				role: 'owner',
				value: ownerChoice?.issue_epoch === row.consent_epoch ? ownerChoice.value : 'unset'
			},
			...memberRows.map((person) => ({
				user: { id: person.user_id, name: person.name },
				role: 'member',
				value:
					person.issue_epoch === row.consent_epoch &&
					person.choice_member_revision === person.membership_revision
						? person.value
						: 'unset'
			}))
		],
		latest_run: run
			? { status: run.status, started_at: run.started_at, ended_at: run.ended_at }
			: null,
		schedule_source: row.schedule_id ? { id: row.schedule_id, name: row.schedule_name } : null,
		my_choice: {
			value:
				choice?.issue_epoch === row.consent_epoch &&
				choice.membership_revision === (access.role === 'owner' ? 0 : access.membershipRevision)
					? choice.value
					: 'unset',
			revision: choice?.revision ?? 0,
			epoch: row.consent_epoch,
			source:
				choice?.issue_epoch === row.consent_epoch &&
				choice.membership_revision === (access.role === 'owner' ? 0 : access.membershipRevision)
					? choice.source_kind
					: null
		},
		agent_hold: Boolean(row.agent_hold),
		hold_revision: row.hold_revision,
		needs_attention: Boolean(row.needs_attention),
		decision_revision: row.decision_revision,
		workflow_revision: row.workflow_revision,
		capabilities: {
			read: true,
			comment: true,
			decide: row.project_archived_at === null,
			personal_permission: row.state_category !== 'done',
			execute: false
		}
	};
}

export async function listSharedIssues(
	db: Kysely<Database>,
	actor: ActorContext,
	projectId: string | null,
	opts: {
		limit?: number;
		cursor?: { created_at: number; id: string };
		direction?: 'after' | 'before';
		q?: string;
		brief?: boolean;
		state?: string;
		workflow?: string;
		schedule?: string;
		archived?: 'false' | 'true' | 'all';
		category?: string;
		hideDone?: boolean;
		hideDuplicates?: boolean;
		ready?: boolean;
		labels?: string[];
	} = {}
) {
	if (actor.agentRunId) throw notFound();
	const access = projectId ? await resolveProjectAccess(db, actor, projectId) : null;
	const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
	const backwards = opts.direction === 'before';
	let query = db
		.selectFrom('issue as i')
		.innerJoin('project as p', 'p.id', 'i.project_id')
		.innerJoin('user as owner', 'owner.id', 'p.user_id')
		.innerJoin('project_member as m', (join) =>
			join.onRef('m.project_id', '=', 'p.id').on('m.user_id', '=', actor.userId)
		)
		.innerJoin('workflow as w', 'w.id', 'i.workflow_id')
		.innerJoin('workflow_state as s', 's.id', 'i.state_id')
		.select([
			'i.id',
			'i.project_id',
			'i.number',
			'i.title',
			'i.description',
			'i.created_at',
			'i.updated_at',
			'i.state_entered_at',
			'p.name as project_name',
			'p.archived_at as project_archived_at',
			'owner.id as owner_id',
			'owner.name as owner_name',
			'm.revision as membership_revision',
			'i.workflow_id',
			's.id as state_id',
			's.name as state_name',
			's.category as state_category'
		])
		.where('m.revoked_at', 'is', null)
		.where('p.shared_at', 'is not', null)
		.where(projectReadPredicate(actor, 'i.project_id'))
		.orderBy('i.created_at', backwards ? 'asc' : 'desc')
		.orderBy('i.id', backwards ? 'asc' : 'desc')
		.limit(limit + 1);
	if (projectId) query = query.where('i.project_id', '=', projectId);
	else if (opts.archived === 'false' || opts.archived === undefined)
		query = query.where('p.archived_at', 'is', null);
	else if (opts.archived === 'true') query = query.where('p.archived_at', 'is not', null);
	if (opts.q)
		query = query.where((eb) =>
			eb.or([
				eb('i.title', 'like', `%${opts.q!.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`),
				eb('i.description', 'like', `%${opts.q!.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`)
			])
		);
	if (opts.state)
		query = query.where((eb) =>
			eb.or([eb('i.state_id', '=', opts.state!), eb('s.name', '=', opts.state!)])
		);
	if (opts.workflow)
		query = query.where((eb) =>
			eb.or([eb('i.workflow_id', '=', opts.workflow!), eb('w.name', '=', opts.workflow!)])
		);
	if (opts.schedule) query = query.where('i.scheduled_task_id', '=', opts.schedule);
	if (opts.category)
		query = query.where(
			's.category',
			'=',
			opts.category as 'backlog' | 'active' | 'awaiting_human' | 'done'
		);
	if (opts.hideDone) query = query.where('s.category', '!=', 'done');
	if (opts.hideDuplicates)
		query = query.where((eb) =>
			eb.not(
				eb.exists(
					eb
						.selectFrom('issue_link as l')
						.select('l.id')
						.whereRef('l.source_issue_id', '=', 'i.id')
						.where('l.kind', '=', 'duplicate_of')
				)
			)
		);
	if (opts.ready)
		query = query.where((eb) =>
			eb.not(
				eb.exists(
					eb
						.selectFrom('issue_link as l')
						.innerJoin('issue as blocker', 'blocker.id', 'l.source_issue_id')
						.innerJoin('workflow_state as blocker_state', 'blocker_state.id', 'blocker.state_id')
						.select('l.id')
						.whereRef('l.target_issue_id', '=', 'i.id')
						.where('l.kind', '=', 'blocks')
						.where('blocker_state.category', '!=', 'done')
				)
			)
		);
	for (const label of opts.labels ?? [])
		query = query.where((eb) =>
			eb.exists(
				eb
					.selectFrom('issue_label as il')
					.innerJoin('label as l', 'l.id', 'il.label_id')
					.select('il.issue_id')
					.whereRef('il.issue_id', '=', 'i.id')
					.where((b) => b.or([b('l.id', '=', label), b('l.name', '=', label)]))
			)
		);
	if (opts.cursor)
		query = query.where((eb) =>
			eb.or([
				eb('i.created_at', backwards ? '>' : '<', opts.cursor!.created_at),
				eb.and([
					eb('i.created_at', '=', opts.cursor!.created_at),
					eb('i.id', backwards ? '>' : '<', opts.cursor!.id)
				])
			])
		);
	const rows = await query.execute();
	const pageRows = rows.slice(0, limit);
	if (backwards) pageRows.reverse();
	if (
		access &&
		(await resolveProjectAccess(db, actor, projectId!)).membershipRevision !==
			access.membershipRevision
	)
		throw notFound();
	// A membership removed while the page was loading must not survive serialization.
	const current = await db
		.selectFrom('project_member')
		.select(['project_id', 'revision'])
		.where('user_id', '=', actor.userId)
		.where('revoked_at', 'is', null)
		.execute();
	const active = new Map(current.map((m) => [m.project_id, m.revision]));
	if (rows.some((row) => active.get(row.project_id) !== row.membership_revision)) throw notFound();
	return {
		items: pageRows.map((row) => ({
			id: row.id,
			project_id: row.project_id,
			number: row.number,
			title: row.title,
			...(opts.brief ? {} : { description: row.description }),
			project_name: row.project_name,
			project_archived_at: row.project_archived_at,
			owner: { id: row.owner_id, name: row.owner_name },
			workflow_id: row.workflow_id,
			created_at: row.created_at,
			updated_at: row.updated_at,
			state_entered_at: row.state_entered_at ?? row.created_at,
			last_activity_at: row.updated_at,
			state: { id: row.state_id, name: row.state_name, category: row.state_category },
			effective_state: { id: row.state_id, name: row.state_name, category: row.state_category }
		})),
		hasMore: rows.length > limit
	};
}

/** Category counts use the same readable project and scope filters as the member issue list. */
export async function countSharedIssuesByCategory(
	db: Kysely<Database>,
	actor: ActorContext,
	projectId: string,
	opts: {
		q?: string;
		state?: string;
		workflow?: string;
		ready?: boolean;
		hideDuplicates?: boolean;
		labels?: string[];
	} = {}
) {
	const access = await resolveProjectAccess(db, actor, projectId);
	let query = db
		.selectFrom('issue as i')
		.innerJoin('workflow_state as s', 's.id', 'i.state_id')
		.innerJoin('workflow as w', 'w.id', 'i.workflow_id')
		.select(['s.category', (eb) => eb.fn.countAll<number>().as('n')])
		.where('i.project_id', '=', projectId)
		.groupBy('s.category');
	if (opts.q) {
		const term = `%${opts.q.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
		query = query.where((eb) =>
			eb.or([eb('i.title', 'like', term), eb('i.description', 'like', term)])
		);
	}
	if (opts.state)
		query = query.where((eb) =>
			eb.or([eb('i.state_id', '=', opts.state!), eb('s.name', '=', opts.state!)])
		);
	if (opts.workflow)
		query = query.where((eb) =>
			eb.or([eb('i.workflow_id', '=', opts.workflow!), eb('w.name', '=', opts.workflow!)])
		);
	if (opts.hideDuplicates || opts.ready)
		query = query.where((eb) =>
			eb.not(
				eb.exists(
					eb
						.selectFrom('issue_link as l')
						.select('l.id')
						.whereRef('l.source_issue_id', '=', 'i.id')
						.where('l.kind', '=', 'duplicate_of')
				)
			)
		);
	if (opts.ready)
		query = query.where((eb) =>
			eb.and([
				eb('s.category', '!=', 'done'),
				eb.not(
					eb.exists(
						eb
							.selectFrom('issue_link as l')
							.innerJoin('issue as blocker', 'blocker.id', 'l.source_issue_id')
							.innerJoin('workflow_state as bs', 'bs.id', 'blocker.state_id')
							.select('l.id')
							.whereRef('l.target_issue_id', '=', 'i.id')
							.where('l.kind', '=', 'blocks')
							.where('bs.category', '!=', 'done')
					)
				)
			])
		);
	for (const label of opts.labels ?? [])
		query = query.where((eb) =>
			eb.exists(
				eb
					.selectFrom('issue_label as il')
					.innerJoin('label as l', 'l.id', 'il.label_id')
					.select('il.issue_id')
					.whereRef('il.issue_id', '=', 'i.id')
					.where((b) => b.or([b('l.id', '=', label), b('l.name', '=', label)]))
			)
		);
	const rows = await query.execute();
	if (
		(await resolveProjectAccess(db, actor, projectId)).membershipRevision !==
		access.membershipRevision
	)
		throw notFound();
	const counts = { backlog: 0, active: 0, awaiting_human: 0, done: 0 };
	for (const row of rows) counts[row.category] = Number(row.n);
	return counts;
}

export async function readSharedArtifact(
	db: Kysely<Database>,
	actor: ActorContext,
	issueId: string,
	name: string,
	version?: number
) {
	const access = await resolveIssueAccess(db, actor, issueId);
	const issue = await db
		.selectFrom('issue')
		.select(['state_entered_at', 'created_at'])
		.where('id', '=', issueId)
		.executeTakeFirstOrThrow();
	const artifact = (
		await listSharedArtifacts(db, issueId, issue.state_entered_at ?? issue.created_at)
	).find((item) => item.name === name);
	if (!artifact) throw notFound();
	const versions = await sharedArtifactVersions(db, artifact.id);
	if (version != null && !versions.some((entry) => entry.version === version)) throw notFound();
	if (
		access.role === 'member' &&
		(await resolveProjectAccess(db, actor, access.projectId)).membershipRevision !==
			access.membershipRevision
	)
		throw notFound();
	return { ...artifact, versions } satisfies ArtifactDetail;
}

async function sharedArtifactVersions(
	db: Kysely<Database>,
	contextItemId: string
): Promise<ArtifactVersion[]> {
	const rows = await db
		.selectFrom('artifact_version as v')
		.leftJoin('user as u', 'u.id', 'v.actor_user_id')
		.select([
			'v.id',
			'v.version',
			'v.filename',
			'v.content_type',
			'v.size_bytes',
			'v.url',
			'v.title',
			'v.pr_repo_url',
			'v.pr_number',
			'v.reaffirmed_from',
			'v.actor_user_id',
			'v.created_at',
			'u.name as actor_name'
		])
		.where('v.context_item_id', '=', contextItemId)
		.orderBy('v.version')
		.execute();
	return Promise.all(
		rows.map(async (row): Promise<ArtifactVersion> => {
			const files = await db
				.selectFrom('artifact_version_file')
				.select(['path', 'content_type', 'size_bytes'])
				.where('artifact_version_id', '=', row.id)
				.orderBy('path')
				.execute();
			return {
				version: row.version,
				filename: row.filename,
				content_type: row.content_type,
				size_bytes: row.size_bytes,
				file_count: files.length || null,
				...(files.length
					? { files: files.map((file) => ({ ...file, size_bytes: Number(file.size_bytes) })) }
					: {}),
				url: row.url,
				title: row.title,
				pr_repo_url: row.pr_repo_url,
				pr_number: row.pr_number,
				reaffirmed_from: row.reaffirmed_from,
				actor: {
					user_id: row.actor_user_id ?? '',
					user_name: row.actor_name ?? 'Former participant',
					api_key_id: null,
					api_key_name: null
				},
				created_at: row.created_at
			};
		})
	);
}

async function listSharedArtifacts(
	db: Kysely<Database>,
	issueId: string,
	stateEnteredAt: number
): Promise<Artifact[]> {
	const rows = await db
		.selectFrom('context_item')
		.select(['id', 'name', 'description', 'config', 'created_at', 'updated_at'])
		.where('issue_id', '=', issueId)
		.where('kind', '=', 'artifact')
		.orderBy('name')
		.execute();
	return Promise.all(
		rows.map(async (row): Promise<Artifact> => {
			const versions = await sharedArtifactVersions(db, row.id);
			const current = versions.at(-1);
			if (!current) throw notFound();
			let artifactType: ArtifactType = 'file';
			try {
				artifactType = JSON.parse(row.config ?? '{}').artifact_type ?? 'file';
			} catch {
				/* bad config */
			}
			return {
				id: row.id,
				name: row.name,
				artifact_type: artifactType,
				description: row.description,
				issue_id: issueId,
				version_count: versions.length,
				current_version: current,
				fresh: current.created_at >= stateEnteredAt,
				created_at: row.created_at,
				updated_at: row.updated_at
			};
		})
	);
}

export async function sharedArtifactContent(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	issueId: string,
	name: string,
	opts: { version?: number; inline?: boolean; path?: string }
) {
	const access = await resolveIssueAccess(db, actor, issueId);
	const row = await db
		.selectFrom('context_item as a')
		.innerJoin('artifact_version as v', 'v.context_item_id', 'a.id')
		.select([
			'v.id',
			'v.version',
			'v.filename',
			'v.content_type',
			'v.content',
			'v.r2_key',
			'v.url',
			'v.pr_repo_url',
			'v.pr_number',
			'a.config'
		])
		.where('a.issue_id', '=', issueId)
		.where('a.kind', '=', 'artifact')
		.where('a.name', '=', name)
		.$if(opts.version != null, (q) => q.where('v.version', '=', opts.version!))
		.orderBy('v.version desc')
		.executeTakeFirst();
	if (!row) throw notFound();
	if (
		access.role === 'member' &&
		(await resolveProjectAccess(db, actor, access.projectId)).membershipRevision !==
			access.membershipRevision
	)
		throw notFound();
	const type = JSON.parse(row.config ?? '{}').artifact_type as string;
	if (type === 'link' || type === 'pr')
		return new Response(
			JSON.stringify({
				error: {
					code: 'no_content',
					message: 'This artifact is a reference',
					url: type === 'link' ? row.url : `${row.pr_repo_url}/pull/${row.pr_number}`
				}
			}),
			{ status: 422, headers: { 'content-type': 'application/json' } }
		);
	let bytes: Uint8Array | null = null,
		contentType = row.content_type ?? 'application/octet-stream',
		filename = row.filename ?? name;
	if (type === 'folder') {
		const files = await db
			.selectFrom('artifact_version_file')
			.select(['path', 'content_type', 'r2_key'])
			.where('artifact_version_id', '=', row.id)
			.orderBy('path')
			.execute();
		if (!opts.path) {
			if (
				access.role === 'member' &&
				(await resolveProjectAccess(db, actor, access.projectId)).membershipRevision !==
					access.membershipRevision
			)
				throw notFound();
			throw new ApiFail(422, 'folder_path_required', 'Choose a file path', {
				paths: files.map((file) => file.path)
			});
		}
		const file = files.find((entry) => entry.path === opts.path);
		if (!file) throw notFound();
		bytes = await getArtifactStore(env).get(file.r2_key);
		contentType = file.content_type;
		filename = file.path.split('/').pop() ?? name;
	} else if (type === 'text') bytes = new TextEncoder().encode(row.content ?? '');
	else if (row.r2_key) bytes = await getArtifactStore(env).get(row.r2_key);
	if (!bytes) throw notFound();
	if (
		access.role === 'member' &&
		(await resolveProjectAccess(db, actor, access.projectId)).membershipRevision !==
			access.membershipRevision
	)
		throw notFound();
	const inline =
		opts.inline === true &&
		['image/', 'application/pdf', 'text/plain', 'text/markdown'].some((prefix) =>
			contentType.startsWith(prefix)
		);
	const safeFilename = filename.replace(/[\x00-\x1f\x7f"\\;]/g, '_');
	return new Response(bytes as unknown as BodyInit, {
		headers: {
			'content-type': contentType,
			'content-length': String(bytes.byteLength),
			'x-content-type-options': 'nosniff',
			'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${safeFilename}"`,
			...(inline ? { 'content-security-policy': 'sandbox' } : {})
		}
	});
}
