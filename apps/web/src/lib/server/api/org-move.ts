/**
 * Moving a project between organizations, and Share this project
 * (docs/organizations.md). One reviewed operation: the preview lists who
 * gains and loses access, what happens to each workflow and label in use, and
 * the organization-level context the project stops reading; the commit is one
 * batch, bound to the preview's digest.
 *
 * MVP: an organization-level workflow in use is always brought along as a
 * copy (the spec's default); mapping onto a destination workflow is not
 * offered yet.
 */
import type { ProjectMovePreview, ShareProjectRequest } from '@tines/shared';
import { sql, type CompiledQuery, type Kysely } from 'kysely';
import { newId, type Database } from '$lib/server/db';
import { sha256Hex } from '../crypto';
import { ApiFail, notFound, runAtomic, type ActorContext } from './core';
import { personalOrgId } from './org-core';
import {
	firstShareQueries,
	grantProjectMemberQueries,
	orgMemberIds,
	revokeProjectMemberQueries
} from './org-membership';
import { createOrganization, personOf, requireOrg, type OrgAccess } from './organizations';

interface MovePlan {
	preview: ProjectMovePreview;
	from: OrgAccess['org'];
	to: OrgAccess['org'];
	project: { id: string; name: string; user_id: string; shared_at: number | null };
	/** Source-organization workflows to copy, with their states. */
	copies: {
		id: string;
		name: string;
		description: string;
		initial_state_id: string;
		states: {
			id: string;
			name: string;
			category: string;
			position: number;
			run_scope: string;
			key: string | null;
		}[];
		transitions: {
			name: string;
			from_state_id: string;
			to_state_id: string;
			requirements: string | null;
		}[];
	}[];
	labels: {
		id: string;
		name: string;
		color: string;
		description: string;
		existing: string | null;
	}[];
	gain: string[];
	lose: string[];
}

function browserOnly(actor: ActorContext) {
	if (!actor.viaSession || actor.bearerPresent || actor.apiKeyId || actor.agentRunId)
		throw new ApiFail(403, 'session_required', 'Moving a project needs your browser session');
}

async function planMove(
	db: Kysely<Database>,
	actor: ActorContext,
	projectId: string,
	toOrgId: string
): Promise<MovePlan> {
	const project = await db
		.selectFrom('project')
		.select([
			'id',
			'name',
			'user_id',
			'shared_at',
			sql<string>`COALESCE(organization_id, 'org_' || user_id)`.as('org_id')
		])
		.where('id', '=', projectId)
		.executeTakeFirst();
	if (!project) throw notFound();
	const fromAccess = await requireOrg(db, actor, project.org_id, ['owner', 'manager']);
	const toAccess = await requireOrg(db, actor, toOrgId, ['owner', 'manager']);
	const from = fromAccess.org;
	const to = toAccess.org;
	const blockers: ProjectMovePreview['blockers'] = [];
	if (from.id === to.id)
		blockers.push({ code: 'same_organization', message: 'The project is already there' });
	const running = await db
		.selectFrom('agent_run')
		.innerJoin('issue', 'issue.id', 'agent_run.issue_id')
		.select(['agent_run.id', 'agent_run.status'])
		.where('issue.project_id', '=', projectId)
		.where('agent_run.status', 'in', ['launching', 'running'])
		.execute();
	for (const r of running)
		blockers.push({
			code: 'run_active',
			message: `Run ${r.id} is ${r.status}; hold the issue or wait for it to finish`
		});
	const clash = await db
		.selectFrom('project')
		.select('id')
		.where('user_id', '=', to.owner_user_id)
		.where(sql<boolean>`COALESCE(organization_id, 'org_' || user_id) = ${to.id}`)
		.where('name', '=', project.name)
		.executeTakeFirst();
	if (clash)
		blockers.push({
			code: 'name_taken',
			message: `${to.name} already has a project named “${project.name}”`
		});

	// Workflows in use: by an issue, a schedule, the default, or a pack input.
	const used = await sql<{ workflow_id: string }>`
		SELECT workflow_id FROM issue WHERE project_id = ${projectId}
		UNION SELECT workflow_id FROM scheduled_task WHERE project_id = ${projectId}
		UNION SELECT default_workflow_id FROM project WHERE id = ${projectId} AND default_workflow_id IS NOT NULL
		UNION SELECT v.workflow_id FROM pack_input_value v JOIN pack k ON k.id = v.pack_id
			WHERE k.project_id = ${projectId} AND v.workflow_id IS NOT NULL`.execute(db);
	const workflowIds = [...new Set(used.rows.map((r) => r.workflow_id))].concat(['']);
	const workflows = await db
		.selectFrom('workflow')
		.select([
			'id',
			'name',
			'description',
			'initial_state_id',
			'user_id',
			'pack_id',
			sql<string>`COALESCE(organization_id, 'org_' || user_id)`.as('org_id'),
			(eb) =>
				eb
					.selectFrom('issue')
					.whereRef('issue.workflow_id', '=', 'workflow.id')
					.where('issue.project_id', '=', projectId)
					.select((eb2) => eb2.fn.countAll<number>().as('n'))
					.as('issues'),
			(eb) =>
				eb
					.selectFrom('scheduled_task')
					.whereRef('scheduled_task.workflow_id', '=', 'workflow.id')
					.where('scheduled_task.project_id', '=', projectId)
					.select((eb2) => eb2.fn.countAll<number>().as('n'))
					.as('schedules')
		])
		.where('id', 'in', workflowIds)
		.execute();
	const copyRows = workflows.filter(
		(w) => w.user_id !== null && !w.pack_id && w.org_id === from.id
	);
	const states = await db
		.selectFrom('workflow_state')
		.select(['id', 'workflow_id', 'name', 'category', 'position', 'run_scope', 'key'])
		.where('workflow_id', 'in', copyRows.map((w) => w.id).concat(['']))
		.orderBy('position')
		.execute();
	const transitions = await db
		.selectFrom('workflow_transition')
		.select(['workflow_id', 'name', 'from_state_id', 'to_state_id', 'requirements'])
		.where('workflow_id', 'in', copyRows.map((w) => w.id).concat(['']))
		.execute();

	// Labels in use: on the project's issues, and on context scoped to it.
	const labelRows = await sql<{
		id: string;
		name: string;
		color: string;
		description: string;
		org_id: string;
	}>`
		SELECT l.id, l.name, l.color, l.description, COALESCE(l.organization_id, 'org_' || l.user_id) AS org_id FROM label l
		WHERE l.id IN (SELECT il.label_id FROM issue_label il JOIN issue i ON i.id = il.issue_id WHERE i.project_id = ${projectId}
			UNION SELECT label_id FROM context_item WHERE project_id = ${projectId} AND label_id IS NOT NULL)`.execute(
		db
	);
	const destLabels = await db
		.selectFrom('label')
		.select(['id', 'name'])
		.where('user_id', '=', to.owner_user_id)
		.where(sql<boolean>`COALESCE(organization_id, 'org_' || user_id) = ${to.id}`)
		.execute();
	const labels = labelRows.rows
		.filter((l) => l.org_id !== to.id)
		.map((l) => ({
			...l,
			existing: destLabels.find((d) => d.name.toLowerCase() === l.name.toLowerCase())?.id ?? null
		}));

	// People: the source's lose access unless they are in the destination too.
	const fromPeople = new Set(await orgMemberIds(db, from.id));
	const toPeople = new Set(await orgMemberIds(db, to.id));
	const gain = [...toPeople].filter((id) => !fromPeople.has(id));
	const lose = [...fromPeople].filter((id) => !toPeople.has(id));
	const names = await db
		.selectFrom('user')
		.select(['id', 'name'])
		.where('id', 'in', [...gain, ...lose].concat(['']))
		.execute();
	const named = (ids: string[]) =>
		ids.map((id) => ({ id, name: names.find((n) => n.id === id)?.name ?? id }));

	// Organization-level items (global, state-only, label-only) that reach the project now.
	const lost = await db
		.selectFrom('context_item')
		.select(['id', 'kind', 'name'])
		.where('user_id', '=', project.user_id)
		.where('project_id', 'is', null)
		.where('issue_id', 'is', null)
		.where('kind', '!=', 'artifact')
		.where(sql<boolean>`COALESCE(organization_id, 'org_' || user_id) = ${from.id}`)
		.where((eb) =>
			eb.or([
				eb('workflow_state_id', 'is', null),
				eb('workflow_state_id', 'not in', states.map((s) => s.id).concat(['']))
			])
		)
		.limit(200)
		.execute();

	const preview: ProjectMovePreview = {
		project: { id: project.id, name: project.name },
		from: { id: from.id, name: from.name, kind: from.kind },
		to: { id: to.id, name: to.name, kind: to.kind },
		people: { gain: named(gain), lose: named(lose) },
		workflows: workflows.map((w) => ({
			id: w.id,
			name: w.name,
			handling:
				w.user_id === null ? 'system' : w.pack_id || w.org_id !== from.id ? 'moves' : 'copy',
			issues: Number(w.issues ?? 0),
			schedules: Number(w.schedules ?? 0)
		})),
		labels: labels.map((l) => ({
			id: l.id,
			name: l.name,
			handling: l.existing ? 'use_existing' : 'copy'
		})),
		context_lost: lost,
		blockers,
		digest: ''
	};
	preview.digest = await sha256Hex(
		JSON.stringify({ ...preview, digest: undefined, rev: [from.revision, to.revision] })
	);
	return {
		preview,
		from,
		to,
		project: {
			id: project.id,
			name: project.name,
			user_id: project.user_id,
			shared_at: project.shared_at
		},
		copies: copyRows.map((w) => ({
			...w,
			states: states.filter((s) => s.workflow_id === w.id),
			transitions: transitions.filter((t) => t.workflow_id === w.id)
		})),
		labels,
		gain,
		lose
	};
}

export async function previewProjectMove(
	db: Kysely<Database>,
	actor: ActorContext,
	projectId: string,
	toOrgId: string
): Promise<ProjectMovePreview> {
	return (await planMove(db, actor, projectId, toOrgId)).preview;
}

export async function moveProject(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	projectId: string,
	body: { to_organization_id?: unknown; expected_digest?: unknown },
	extra: { bringContext?: boolean } = {}
): Promise<{ project_id: string; organization_id: string }> {
	browserOnly(actor);
	if (typeof body.to_organization_id !== 'string')
		throw new ApiFail(422, 'invalid_field', 'Name the destination organization', {
			field: 'to_organization_id'
		});
	const plan = await planMove(db, actor, projectId, body.to_organization_id);
	if (body.expected_digest !== plan.preview.digest)
		throw new ApiFail(
			409,
			'move_preview_stale',
			'Something changed since the preview; review the move again'
		);
	if (plan.preview.blockers.length)
		throw new ApiFail(409, plan.preview.blockers[0].code, plan.preview.blockers[0].message, {
			blockers: plan.preview.blockers
		});
	const { from, to, project } = plan;
	const now = Date.now();
	const newOwner = to.owner_user_id;
	const oldOwner = project.user_id;
	const actorRef = { userId: personOf(actor), apiKeyId: actor.apiKeyId };
	const queries: CompiledQuery[] = [];

	// 1. Copies of the source organization's workflows, with their state context.
	const stateMap = new Map<string, string>();
	const workflowMap = new Map<string, string>();
	for (const wf of plan.copies) {
		const id = newId('wf');
		workflowMap.set(wf.id, id);
		for (const s of wf.states) stateMap.set(s.id, newId('wfs'));
		queries.push(
			db
				.insertInto('workflow')
				.values({
					id,
					user_id: newOwner,
					name: wf.name,
					description: wf.description,
					initial_state_id: stateMap.get(wf.initial_state_id) ?? wf.initial_state_id,
					organization_id: to.id,
					created_at: now,
					updated_at: now
				})
				.compile(),
			...wf.states.map((s) =>
				db
					.insertInto('workflow_state')
					.values({
						id: stateMap.get(s.id)!,
						workflow_id: id,
						name: s.name,
						category: s.category as never,
						position: s.position,
						run_scope: s.run_scope as never,
						key: s.key,
						created_at: now
					})
					.compile()
			),
			...wf.transitions.map((t) =>
				db
					.insertInto('workflow_transition')
					.values({
						id: newId('wft'),
						workflow_id: id,
						name: t.name,
						from_state_id: stateMap.get(t.from_state_id)!,
						to_state_id: stateMap.get(t.to_state_id)!,
						requirements: t.requirements
					})
					.compile()
			)
		);
	}
	// The source organization's state-scoped items on those states come along (not journals:
	// those are project-scoped and move with the project).
	if (stateMap.size) {
		const items = await db
			.selectFrom('context_item')
			.selectAll()
			.where('user_id', '=', oldOwner)
			.where('workflow_state_id', 'in', [...stateMap.keys()])
			.where('project_id', 'is', null)
			.where('issue_id', 'is', null)
			.where('label_id', 'is', null)
			.execute();
		const files = await db
			.selectFrom('context_item_file')
			.selectAll()
			.where('context_item_id', 'in', items.map((i) => i.id).concat(['']))
			.execute();
		for (const item of items) {
			const id = newId('ctx');
			queries.push(
				db
					.insertInto('context_item')
					.values({
						...item,
						id,
						user_id: newOwner,
						organization_id: to.id,
						workflow_state_id: stateMap.get(item.workflow_state_id!)!,
						version: 1,
						created_at: now,
						updated_at: now
					})
					.compile(),
				...files
					.filter((f) => f.context_item_id === item.id)
					.map((f) =>
						db
							.insertInto('context_item_file')
							.values({
								...f,
								id: newId('ctf'),
								context_item_id: id,
								created_at: now,
								updated_at: now
							})
							.compile()
					)
			);
		}
	}
	// Re-point everything in the project at the copies.
	for (const [oldWf, newWf] of workflowMap) {
		queries.push(
			db
				.updateTable('project')
				.set({ default_workflow_id: newWf })
				.where('id', '=', projectId)
				.where('default_workflow_id', '=', oldWf)
				.compile(),
			sql`UPDATE pack_input_value SET workflow_id = ${newWf} WHERE workflow_id = ${oldWf}
				AND pack_id IN (SELECT id FROM pack WHERE project_id = ${projectId})`.compile(db)
		);
	}
	for (const [oldState, newState] of stateMap) {
		const newWf = workflowMap.get(
			plan.copies.find((c) => c.states.some((s) => s.id === oldState))!.id
		)!;
		queries.push(
			db
				.updateTable('issue')
				.set({ state_id: newState, workflow_id: newWf })
				.where('project_id', '=', projectId)
				.where('state_id', '=', oldState)
				.compile(),
			db
				.updateTable('scheduled_task')
				.set({ state_id: newState, workflow_id: newWf })
				.where('project_id', '=', projectId)
				.where('state_id', '=', oldState)
				.compile(),
			db
				.updateTable('context_item')
				.set({ workflow_state_id: newState })
				.where('project_id', '=', projectId)
				.where('workflow_state_id', '=', oldState)
				.compile(),
			sql`UPDATE context_item SET workflow_state_id = ${newState} WHERE workflow_state_id = ${oldState}
				AND issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId})`.compile(db),
			db
				.updateTable('routing_rule')
				.set({ workflow_state_id: newState })
				.where('project_id', '=', projectId)
				.where('workflow_state_id', '=', oldState)
				.compile(),
			sql`UPDATE pack_input_value SET state_id = ${newState} WHERE state_id = ${oldState}
				AND pack_id IN (SELECT id FROM pack WHERE project_id = ${projectId})`.compile(db)
		);
	}
	for (const [oldWf, newWf] of workflowMap)
		queries.push(
			db
				.updateTable('scheduled_task')
				.set({ workflow_id: newWf })
				.where('project_id', '=', projectId)
				.where('workflow_id', '=', oldWf)
				.compile()
		);

	// 2. Labels: the destination's same-named label, or a copy.
	for (const l of plan.labels) {
		const target = l.existing ?? newId('lbl');
		if (!l.existing)
			queries.push(
				db
					.insertInto('label')
					.values({
						id: target,
						user_id: newOwner,
						name: l.name,
						color: l.color,
						description: l.description,
						organization_id: to.id,
						created_at: now,
						updated_at: now
					})
					.compile()
			);
		queries.push(
			sql`UPDATE OR IGNORE issue_label SET label_id = ${target} WHERE label_id = ${l.id}
				AND issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId})`.compile(db),
			sql`DELETE FROM issue_label WHERE label_id = ${l.id} AND issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId})`.compile(
				db
			),
			db
				.updateTable('context_item')
				.set({ label_id: target })
				.where('project_id', '=', projectId)
				.where('label_id', '=', l.id)
				.compile(),
			db
				.updateTable('routing_rule')
				.set({ label_id: target })
				.where('project_id', '=', projectId)
				.where('label_id', '=', l.id)
				.compile()
		);
	}

	// 3. Share this project: the personal organization's items that reach it.
	if (extra.bringContext) {
		const globals = await db
			.selectFrom('context_item')
			.selectAll()
			.where('user_id', '=', oldOwner)
			.where('project_id', 'is', null)
			.where('issue_id', 'is', null)
			.where('label_id', 'is', null)
			.where('workflow_state_id', 'is', null)
			.where('kind', 'in', ['prompt', 'skill', 'repo', 'env'])
			.where(sql<boolean>`COALESCE(organization_id, 'org_' || user_id) = ${from.id}`)
			.execute();
		const files = await db
			.selectFrom('context_item_file')
			.selectAll()
			.where('context_item_id', 'in', globals.map((g) => g.id).concat(['']))
			.execute();
		for (const g of globals) {
			const id = newId('ctx');
			queries.push(
				db
					.insertInto('context_item')
					.values({
						...g,
						id,
						user_id: newOwner,
						organization_id: to.id,
						version: 1,
						created_at: now,
						updated_at: now
					})
					.compile(),
				...files
					.filter((f) => f.context_item_id === g.id)
					.map((f) =>
						db
							.insertInto('context_item_file')
							.values({
								...f,
								id: newId('ctf'),
								context_item_id: id,
								created_at: now,
								updated_at: now
							})
							.compile()
					)
			);
		}
	}

	// 4. The project itself, its own context and its packs' workflows change owner and organization.
	queries.push(
		sql`UPDATE context_item SET user_id = ${newOwner} WHERE user_id = ${oldOwner} AND (project_id = ${projectId}
			OR issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId}))`.compile(db),
		sql`UPDATE workflow SET user_id = ${newOwner}, organization_id = ${to.id}
			WHERE pack_id IN (SELECT id FROM pack WHERE project_id = ${projectId})`.compile(db),
		// Assigned work is released; run keys bound to the project stop working.
		sql`UPDATE agent_run SET status = 'canceled', ended_at = ${now}, error = 'The project moved organizations'
			WHERE status = 'assigned' AND issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId})`.compile(
			db
		),
		sql`UPDATE api_key SET revoked_at = ${now} WHERE revoked_at IS NULL AND agent_run_id IN (SELECT r.id FROM agent_run r
			JOIN issue i ON i.id = r.issue_id WHERE i.project_id = ${projectId})`.compile(db),
		sql`INSERT INTO event (id,user_id,type,actor_user_id,actor_api_key_id,project_id,payload,created_at)
			VALUES (${newId('evt')}, ${oldOwner}, 'project.moved', ${actorRef.userId}, NULL, ${projectId},
			${JSON.stringify({ from_organization_id: from.id, to_organization_id: to.id, to_organization_name: to.name, name: project.name })}, ${now})`.compile(
			db
		),
		db
			.updateTable('project')
			.set({
				user_id: newOwner,
				organization_id: to.id === personalOrgId(newOwner) ? null : to.id,
				updated_at: now
			})
			.where('id', '=', projectId)
			.compile()
	);

	// 5. People.
	for (const id of plan.lose)
		queries.push(
			...revokeProjectMemberQueries(
				db,
				projectId,
				id,
				actorRef,
				now,
				'The project moved organizations'
			)
		);
	if (oldOwner !== newOwner && !(await orgMemberIds(db, to.id)).includes(oldOwner)) {
		// The previous owner is not in the destination: their own choices end with their access.
		queries.push(
			sql`UPDATE issue_personal_choice SET value = 'unset', revision = revision + 1, updated_at = ${now}
				WHERE user_id = ${oldOwner} AND issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId})`.compile(
				db
			)
		);
	}
	if (to.kind === 'shared') {
		queries.push(...firstShareQueries(db, projectId, actorRef, now));
		for (const id of await orgMemberIds(db, to.id, newOwner))
			queries.push(...grantProjectMemberQueries(db, projectId, id, actorRef, now));
		// The new owner is not a member of their own project.
		queries.push(
			sql`UPDATE project_member SET revision = revision + 1, revoked_at = ${now}, updated_at = ${now}
				WHERE project_id = ${projectId} AND user_id = ${newOwner} AND revoked_at IS NULL`.compile(db)
		);
	}
	await runAtomic(env, queries);
	return { project_id: projectId, organization_id: to.id };
}

/**
 * Share this project: a new shared organization, named after the project,
 * and the project moved into it — optionally with the personal organization's
 * items that reach it. The mover's API keys that reach the project gain the
 * new organization, so nothing they use stops working.
 */
export async function shareProject(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	projectId: string,
	body: ShareProjectRequest
): Promise<{ project_id: string; organization_id: string }> {
	browserOnly(actor);
	const project = await db
		.selectFrom('project')
		.select([
			'name',
			'user_id',
			sql<string>`COALESCE(organization_id, 'org_' || user_id)`.as('org_id')
		])
		.where('id', '=', projectId)
		.executeTakeFirst();
	if (!project) throw notFound();
	if (project.user_id !== personOf(actor) || project.org_id !== personalOrgId(project.user_id))
		throw new ApiFail(
			403,
			'not_personal_project',
			'Only the owner can share a project from their personal organization'
		);
	const org = await createOrganization(db, env, actor, { name: body.name?.trim() || project.name });
	const preview = await previewProjectMove(db, actor, projectId, org.id);
	const moved = await moveProject(
		db,
		env,
		actor,
		projectId,
		{ to_organization_id: org.id, expected_digest: preview.digest },
		{ bringContext: body.bring_context === true }
	);
	await addOrganizationToKeys(db, personOf(actor), projectId, org.id);
	return moved;
}

/** Adds `orgId` to the person's API keys that reach `projectId` through their personal organization. */
async function addOrganizationToKeys(
	db: Kysely<Database>,
	userId: string,
	projectId: string,
	orgId: string
) {
	const keys = await db
		.selectFrom('api_key')
		.select(['id', 'permissions'])
		.where('user_id', '=', userId)
		.where('revoked_at', 'is', null)
		.where('agent_run_id', 'is', null)
		.execute();
	for (const key of keys) {
		let policy: Record<string, unknown>;
		try {
			policy = JSON.parse(key.permissions);
		} catch {
			continue;
		}
		const projects = policy.projects as { scope?: unknown } | undefined;
		const reaches =
			projects?.scope === 'all' ||
			(Array.isArray(projects?.scope) && projects.scope.includes(projectId));
		const orgs = policy.organizations;
		if (!reaches || orgs === 'all') continue;
		const list = Array.isArray(orgs) ? (orgs as string[]) : [personalOrgId(userId)];
		if (list.includes(orgId)) continue;
		await db
			.updateTable('api_key')
			.set({
				permissions: JSON.stringify({
					...policy,
					version: 2,
					organizations: [...list, orgId].sort()
				})
			})
			.where('id', '=', key.id)
			.execute();
	}
}
