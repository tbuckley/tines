import type { Kysely } from 'kysely';
import type { Database } from '$lib/server/db';
import { getArtifactStore } from '$lib/server/artifact-store';
import { ApiFail, notFound, type ActorContext } from './core';
import { resolveIssueAccess, resolveProjectAccess } from './project-access';

const SAFE_EVENTS = new Set([
	'issue.created',
	'issue.updated',
	'issue.transitioned',
	'comment.created',
	'comment.updated',
	'comment.deleted',
	'artifact.attached',
	'artifact.updated',
	'artifact.deleted',
	'issue.agent_hold_changed',
	'agent_run.started',
	'agent_run.completed',
	'agent_run.failed',
	'agent_run.canceled',
	'project.member_joined',
	'project.member_removed'
]);

export async function readSharedIssue(
	db: Kysely<Database>,
	actor: ActorContext,
	lookup: { id: string } | { projectId: string; number: number }
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
			'i.decision_revision',
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
			.select([
				'c.id',
				'c.body',
				'c.created_at',
				'c.updated_at',
				'c.actor_user_id',
				'u.name as author_name'
			])
			.where('c.issue_id', '=', row.id)
			.orderBy('c.created_at')
			.execute(),
		db
			.selectFrom('context_item as a')
			.select(['a.id', 'a.name', 'a.description', 'a.created_at', 'a.updated_at'])
			.where('a.issue_id', '=', row.id)
			.where('a.kind', '=', 'artifact')
			.execute(),
		db
			.selectFrom('event as e')
			.select(['e.id', 'e.type', 'e.created_at', 'e.actor_user_id'])
			.where('e.issue_id', '=', row.id)
			.orderBy('e.created_at desc')
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
			.select(['value', 'revision', 'issue_epoch', 'source_kind'])
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
	const visibleLinks = [] as { id: string; kind: string; issue_id: string }[];
	let blockedByPrivateIssue = false;
	for (const link of links) {
		const otherId = link.source_issue_id === row.id ? link.target_issue_id : link.source_issue_id;
		try {
			await resolveIssueAccess(db, actor, otherId);
			visibleLinks.push({ id: link.id, kind: link.kind, issue_id: otherId });
		} catch {
			if (link.kind === 'blocks' && link.target_issue_id === row.id) blockedByPrivateIssue = true;
		}
	}
	const artifacts = await Promise.all(
		artifactRows.map(async (artifact) => {
			const version = await db
				.selectFrom('artifact_version')
				.select(['version', 'filename', 'content_type', 'size_bytes', 'created_at'])
				.where('context_item_id', '=', artifact.id)
				.orderBy('version desc')
				.executeTakeFirst();
			return { ...artifact, current_version: version ?? null };
		})
	);
	const allowed = transitions
		.filter((transition) => transition.from_state_id === row.state_id)
		.map((transition) => ({
			id: transition.id,
			name: transition.name,
			to_state_id: transition.to_state_id,
			requires: transition.requirements ? JSON.parse(transition.requirements) : []
		}));
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
		number: row.number,
		title: row.title,
		description: row.description,
		created_at: row.created_at,
		updated_at: row.updated_at,
		state: { id: row.state_id, name: row.state_name, category: row.state_category },
		workflow: { id: row.workflow_id, name: row.workflow_name, states, transitions: allowed },
		labels,
		links: visibleLinks,
		blocked_by_private_issue: blockedByPrivateIssue,
		comments: comments.map((comment) => ({
			id: comment.id,
			body: comment.body,
			created_at: comment.created_at,
			updated_at: comment.updated_at,
			author: { id: comment.actor_user_id, name: comment.author_name ?? 'Former participant' }
		})),
		artifacts,
		history: eventRows
			.filter((event) => SAFE_EVENTS.has(event.type))
			.map((event) => ({
				id: event.id,
				type: event.type,
				created_at: event.created_at,
				actor_user_id: event.actor_user_id
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
			value: choice?.issue_epoch === row.consent_epoch ? choice.value : 'unset',
			revision: choice?.revision ?? 0,
			epoch: row.consent_epoch
		},
		agent_hold: Boolean(row.agent_hold),
		hold_revision: row.hold_revision,
		needs_attention: Boolean(row.needs_attention),
		decision_revision: row.decision_revision,
		capabilities: {
			read: true,
			comment: false,
			decide: false,
			personal_permission: false,
			execute: false
		}
	};
}

export async function listSharedIssues(
	db: Kysely<Database>,
	actor: ActorContext,
	projectId: string,
	opts: {
		limit?: number;
		cursor?: { created_at: number; id: string };
		q?: string;
		state?: string;
		workflow?: string;
		category?: string;
		hideDone?: boolean;
		hideDuplicates?: boolean;
		ready?: boolean;
		labels?: string[];
	} = {}
) {
	const access = await resolveProjectAccess(db, actor, projectId);
	const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
	let query = db
		.selectFrom('issue as i')
		.innerJoin('workflow_state as s', 's.id', 'i.state_id')
		.select([
			'i.id',
			'i.project_id',
			'i.number',
			'i.title',
			'i.created_at',
			'i.updated_at',
			's.name as state_name',
			's.category as state_category'
		])
		.where('i.project_id', '=', projectId)
		.orderBy('i.created_at desc')
		.orderBy('i.id desc')
		.limit(limit + 1);
	if (opts.q)
		query = query.where(
			'i.title',
			'like',
			`%${opts.q.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
		);
	if (opts.state) query = query.where('i.state_id', '=', opts.state);
	if (opts.workflow) query = query.where('i.workflow_id', '=', opts.workflow);
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
				eb('i.created_at', '<', opts.cursor!.created_at),
				eb.and([eb('i.created_at', '=', opts.cursor!.created_at), eb('i.id', '<', opts.cursor!.id)])
			])
		);
	const rows = await query.execute();
	if (
		access.role === 'member' &&
		(await resolveProjectAccess(db, actor, projectId)).membershipRevision !==
			access.membershipRevision
	)
		throw notFound();
	return {
		items: rows.slice(0, limit).map((row) => ({
			id: row.id,
			project_id: row.project_id,
			number: row.number,
			title: row.title,
			created_at: row.created_at,
			updated_at: row.updated_at,
			state: { name: row.state_name, category: row.state_category }
		})),
		hasMore: rows.length > limit
	};
}

export async function readSharedArtifact(
	db: Kysely<Database>,
	actor: ActorContext,
	issueId: string,
	name: string,
	version?: number
) {
	const access = await resolveIssueAccess(db, actor, issueId);
	const artifact = await db
		.selectFrom('context_item')
		.select(['id', 'name', 'description'])
		.where('issue_id', '=', issueId)
		.where('kind', '=', 'artifact')
		.where('name', '=', name)
		.executeTakeFirst();
	if (!artifact) throw notFound();
	let query = db
		.selectFrom('artifact_version')
		.select([
			'id',
			'version',
			'filename',
			'content_type',
			'size_bytes',
			'content',
			'url',
			'title',
			'pr_repo_url',
			'pr_number',
			'created_at'
		])
		.where('context_item_id', '=', artifact.id);
	if (version != null) query = query.where('version', '=', version);
	else query = query.orderBy('version desc').limit(1);
	const versions = await query.execute();
	if (!versions.length) throw notFound();
	if (
		access.role === 'member' &&
		(await resolveProjectAccess(db, actor, access.projectId)).membershipRevision !==
			access.membershipRevision
	)
		throw notFound();
	return { artifact, versions };
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
		if (!opts.path)
			throw new ApiFail(422, 'folder_path_required', 'Choose a file path', {
				paths: files.map((file) => file.path)
			});
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
