import type {
	ArchiveProjectResponse,
	CreateProjectRequest,
	CreateProjectResponse,
	DeletedContextItem,
	DrainingRun,
	Project,
	ProjectListFilters,
	UnarchiveProjectResponse,
	UpdateProjectRequest
} from '@tines/shared';
import { ACTIVE_RUN_STATUSES, PROJECT_NAME_MAX, PROJECT_PROMPT_NAME } from '@tines/shared';
import type { Kysely } from 'kysely';
import { newId, type Database } from '$lib/server/db';
import { findAttachedContext, seedPromptQueries, sweepAttachedContext } from './context';
import {
	ApiFail,
	notFound,
	optionalString,
	requireString,
	runAtomic,
	type ActorContext
} from './core';
import { assertWritable } from './archive';
import { eventInsert } from './events';
import { projectScheduleDeletions, rearmScheduleQueries } from './schedules';
import type { DispatchEffects } from '$lib/server/dispatch-effects';
import { resolveStarter, starterQueries, type StarterRegistry } from './starters';

function projectQuery(db: Kysely<Database>, userId: string) {
	return db
		.selectFrom('project')
		.selectAll('project')
		.select((eb) =>
			eb
				.selectFrom('issue')
				.whereRef('issue.project_id', '=', 'project.id')
				.select((eb2) => eb2.fn.countAll<number>().as('n'))
				.as('issue_count')
		)
		.where('project.user_id', '=', userId);
}

type ProjectRow = Awaited<ReturnType<ReturnType<typeof projectQuery>['execute']>>[number];

function serializeProject(row: ProjectRow): Project {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		default_workflow_id: row.default_workflow_id,
		created_at: row.created_at,
		updated_at: row.updated_at,
		issue_count: Number(row.issue_count ?? 0),
		archived_at: row.archived_at
	};
}

/**
 * Archived projects are hidden by default: every picker and grid loader calls
 * this with no filter and should stop offering them. `'all'` is the escape.
 */
export async function listProjects(
	db: Kysely<Database>,
	userId: string,
	{ archived = 'false' }: ProjectListFilters = {}
): Promise<Project[]> {
	let q = projectQuery(db, userId).orderBy('project.created_at asc');
	if (archived === 'false') q = q.where('project.archived_at', 'is', null);
	if (archived === 'true') q = q.where('project.archived_at', 'is not', null);
	const rows = await q.execute();
	return rows.map(serializeProject);
}

export async function getProject(
	db: Kysely<Database>,
	userId: string,
	id: string
): Promise<Project> {
	const row = await projectQuery(db, userId).where('project.id', '=', id).executeTakeFirst();
	if (!row) throw notFound();
	return serializeProject(row);
}

/** Pure field validation shared by ordinary create and library preview. */
export function validateProjectFields(body: Pick<CreateProjectRequest, 'name' | 'description'>) {
	return {
		name: requireString(body.name, 'name', { max: PROJECT_NAME_MAX }).trim(),
		description: optionalString(body.description, 'description', { max: 10_000 }) ?? ''
	};
}

/** The referenced workflow must be the user's own or the system workflow. */
async function assertWorkflowAccessible(db: Kysely<Database>, userId: string, workflowId: unknown) {
	const id = requireString(workflowId, 'default_workflow_id', { max: 100 });
	const wf = await db
		.selectFrom('workflow')
		.select('id')
		.where('id', '=', id)
		.where((eb) => eb.or([eb('user_id', '=', userId), eb('user_id', 'is', null)]))
		.executeTakeFirst();
	if (!wf) {
		throw new ApiFail(422, 'unknown_workflow', `Workflow "${id}" does not exist`, {
			field: 'default_workflow_id'
		});
	}
}

/**
 * Project names address projects in URLs and the CLI, so they are unique per
 * user (a unique index backs this against races).
 */
async function assertNameAvailable(
	db: Kysely<Database>,
	userId: string,
	name: string,
	excludeId?: string
) {
	let q = db
		.selectFrom('project')
		.select('id')
		.where('user_id', '=', userId)
		.where('name', '=', name);
	if (excludeId) q = q.where('id', '!=', excludeId);
	const existing = await q.executeTakeFirst();
	if (existing) {
		throw new ApiFail(
			422,
			'duplicate_project_name',
			`A project named "${name}" already exists; project names must be unique`,
			{ field: 'name', existing_project_id: existing.id }
		);
	}
}

export async function createProject(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	body: CreateProjectRequest,
	/** Test seam: swap the built-in starter registry (Tines/248). */
	opts: { starters?: StarterRegistry } = {}
): Promise<CreateProjectResponse> {
	// Starter validation is pure and comes first, so an unknown id or a
	// missing input 422s before any read, let alone any write.
	const resolvedStarter = resolveStarter(body.starter, opts.starters);
	const { name, description } = validateProjectFields(body);
	await assertNameAvailable(db, actor.userId, name);
	if (resolvedStarter?.starter.default_workflow && body.default_workflow_id != null) {
		throw new ApiFail(
			422,
			'starter_sets_default_workflow',
			`Starter "${resolvedStarter.starter.id}" sets the project's default workflow; omit default_workflow_id`,
			{ field: 'default_workflow_id' }
		);
	}
	if (body.default_workflow_id != null) {
		await assertWorkflowAccessible(db, actor.userId, body.default_workflow_id);
	}
	const now = Date.now();
	const id = newId('prj');
	const plan = resolvedStarter
		? await starterQueries(db, actor, {
				starter: resolvedStarter.starter,
				inputs: resolvedStarter.inputs,
				projectId: id,
				projectName: name,
				now
			})
		: null;
	// Optional initial prompt: the project and its "conventions" item land
	// in one transaction. The project is brand new, so the name can't collide.
	// An explicit `initial_prompt` (even `''`) beats a starter's template;
	// absent falls back to it.
	const initialPrompt = optionalString(body.initial_prompt, 'initial_prompt', {
		max: 100_000
	})?.trim();
	const conventions =
		body.initial_prompt !== undefined ? (initialPrompt ?? null) : (plan?.conventions ?? null);
	const seed = conventions
		? seedPromptQueries(db, actor, {
				name: PROJECT_PROMPT_NAME,
				body: conventions,
				projectId: id,
				label: `project ${name}`,
				now
			})
		: null;
	// Foreign keys force the order: workflows exist before the project can
	// point at one, and the project exists before its context and issues.
	await runAtomic(env, [
		...(plan?.before ?? []),
		db
			.insertInto('project')
			.values({
				id,
				user_id: actor.userId,
				name,
				description,
				default_workflow_id: plan?.defaultWorkflowId ?? body.default_workflow_id ?? null,
				created_at: now,
				updated_at: now
			})
			.compile(),
		eventInsert(db, actor, {
			type: 'project.created',
			projectId: id,
			payload: { name, ...(plan ? { starter: plan.applied.id } : {}) }
		}),
		...(seed?.queries ?? []),
		...(plan?.after ?? [])
	]);
	const project = await getProject(db, actor.userId, id);
	return plan ? { ...project, starter: plan.applied } : project;
}

export async function updateProject(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	id: string,
	body: UpdateProjectRequest
): Promise<Project> {
	const current = await getProject(db, actor.userId, id);
	await assertWritable(db, actor, current);
	const name =
		body.name !== undefined
			? requireString(body.name, 'name', { max: PROJECT_NAME_MAX }).trim()
			: current.name;
	const description =
		body.description !== undefined
			? (optionalString(body.description, 'description', { max: 10_000 }) ?? '')
			: current.description;
	const defaultWorkflowId =
		body.default_workflow_id !== undefined ? body.default_workflow_id : current.default_workflow_id;
	if (name !== current.name) {
		await assertNameAvailable(db, actor.userId, name, id);
	}
	if (defaultWorkflowId != null && defaultWorkflowId !== current.default_workflow_id) {
		await assertWorkflowAccessible(db, actor.userId, defaultWorkflowId);
	}

	const changed: string[] = [];
	if (name !== current.name) changed.push('name');
	if (description !== current.description) changed.push('description');
	if (defaultWorkflowId !== current.default_workflow_id) changed.push('default_workflow');

	await runAtomic(env, [
		db
			.updateTable('project')
			.set({ name, description, default_workflow_id: defaultWorkflowId, updated_at: Date.now() })
			.where('id', '=', id)
			.compile(),
		eventInsert(db, actor, {
			type: 'project.updated',
			projectId: id,
			payload: {
				name,
				changed,
				...(name !== current.name ? { renamed: { from: current.name, to: name } } : {})
			}
		})
	]);
	return getProject(db, actor.userId, id);
}

export async function deleteProject(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	id: string,
	{ forceDeleteContext = false } = {}
): Promise<DeletedContextItem[]> {
	const project = await getProject(db, actor.userId, id);
	await assertWritable(db, actor, project);
	if (project.issue_count > 0) {
		throw new ApiFail(
			422,
			'project_not_empty',
			`Cannot delete project "${project.name}": it still contains ${project.issue_count} issue${project.issue_count === 1 ? '' : 's'}`,
			{ issue_count: project.issue_count }
		);
	}
	const aliasCount = Number(
		(
			await db
				.selectFrom('issue_address')
				.select((eb) => eb.fn.countAll().as('count'))
				.where('project_id', '=', id)
				.executeTakeFirstOrThrow()
		).count
	);
	const aliasError = (count: number) =>
		new ApiFail(
			422,
			'project_has_issue_aliases',
			`Cannot delete project "${project.name}": it retains ${count} historical issue address${count === 1 ? '' : 'es'}. Archive it instead.`,
			{ alias_count: count, remedy: `tines projects archive "${project.name}"` }
		);
	if (aliasCount > 0) throw aliasError(aliasCount);
	// Context scoped to the project rejects deletion unless forced. The
	// project is issue-less by now, so no issue-scoped items can reference it.
	const attached = await findAttachedContext(db, actor.userId, { projectId: id });
	const sweep = sweepAttachedContext(
		db,
		actor,
		attached,
		forceDeleteContext,
		`delete project "${project.name}"`
	);
	try {
		await runAtomic(env, [
			// Context events insert while the project row still exists; its
			// deletion then nulls their project reference (ON DELETE SET NULL).
			...sweep.queries,
			// The project is issue-less by now, but its schedules go with it.
			...(await projectScheduleDeletions(db, actor, id)),
			db.deleteFrom('project').where('id', '=', id).compile(),
			// project_id stays null-able on the event so the feed keeps history
			// for deleted projects; record the name in the payload.
			eventInsert(db, actor, {
				type: 'project.deleted',
				payload: { project_id: id, name: project.name }
			})
		]);
	} catch (e) {
		// The precheck can race a transfer that creates a durable address.
		// Map only that concrete FK failure; unrelated deletion errors retain
		// their original diagnostics.
		if (e instanceof Error && e.message.includes('FOREIGN KEY constraint failed')) {
			const racedAliasCount = Number(
				(
					await db
						.selectFrom('issue_address')
						.select((eb) => eb.fn.countAll().as('count'))
						.where('project_id', '=', id)
						.executeTakeFirstOrThrow()
				).count
			);
			if (racedAliasCount > 0) throw aliasError(racedAliasCount);
		}
		throw e;
	}
	return sweep.deleted;
}

// ---------------------------------------------------------------------------
// Archive / unarchive
//
// Archiving drains rather than refuses: it always succeeds and takes effect at
// once, but runs already active on the project's issues are allowed to finish
// (see `api/archive.ts` for the exemption). Both calls are idempotent — a
// second archive reports the same counts and writes nothing.

/** Runs still active on the project's issues at the moment of the call. */
async function drainingRuns(db: Kysely<Database>, projectId: string): Promise<DrainingRun[]> {
	const rows = await db
		.selectFrom('agent_run')
		.innerJoin('issue', 'issue.id', 'agent_run.issue_id')
		.innerJoin('runner', 'runner.id', 'agent_run.runner_id')
		.select([
			'agent_run.id as run_id',
			'runner.name as runner_name',
			'issue.id as issue_id',
			'issue.number as issue_number'
		])
		.where('issue.project_id', '=', projectId)
		.where('agent_run.status', 'in', [...ACTIVE_RUN_STATUSES])
		.orderBy('agent_run.created_at asc')
		.execute();
	return rows.map((r) => ({ ...r, issue_number: Number(r.issue_number) }));
}

async function enabledScheduleCount(db: Kysely<Database>, projectId: string): Promise<number> {
	const row = await db
		.selectFrom('scheduled_task')
		.select((eb) => eb.fn.countAll<number>().as('n'))
		.where('project_id', '=', projectId)
		.where('enabled', '=', 1)
		.executeTakeFirst();
	return Number(row?.n ?? 0);
}

export async function archiveProject(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	id: string,
	now = Date.now()
): Promise<ArchiveProjectResponse> {
	const project = await getProject(db, actor.userId, id);
	const schedulesPaused = await enabledScheduleCount(db, id);
	const draining = await drainingRuns(db, id);
	const report = (p: Project): ArchiveProjectResponse => ({
		project: p,
		schedules_paused: schedulesPaused,
		draining_runs: draining,
		issues_read_only: p.issue_count
	});
	// Already archived: report, write nothing, emit nothing.
	if (project.archived_at !== null) return report(project);
	await runAtomic(env, [
		db
			.updateTable('project')
			// Guarded so a racing second archive cannot move the instant.
			.set({ archived_at: now, updated_at: now })
			.where('id', '=', id)
			.where('archived_at', 'is', null)
			.compile(),
		eventInsert(db, actor, {
			type: 'project.archived',
			projectId: id,
			payload: {
				name: project.name,
				schedules_paused: schedulesPaused,
				draining_runs: draining.length,
				issues_read_only: project.issue_count
			}
		})
	]);
	return report(await getProject(db, actor.userId, id));
}

export async function unarchiveProject(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	effects: DispatchEffects,
	id: string,
	now = Date.now()
): Promise<UnarchiveProjectResponse> {
	const project = await getProject(db, actor.userId, id);
	if (project.archived_at === null) {
		effects.signalDispatch();
		return { project, schedules_resumed: 0 };
	}
	// Enabled schedules resume from their next future occurrence: a project
	// archived for a month must not fire a month of catch-up issues.
	const schedules = await db
		.selectFrom('scheduled_task')
		.select(['id', 'cron', 'timezone'])
		.where('project_id', '=', id)
		.where('enabled', '=', 1)
		.execute();
	const rearm = rearmScheduleQueries(db, schedules, now);
	await runAtomic(env, [
		db
			.updateTable('project')
			.set({ archived_at: null, updated_at: now })
			.where('id', '=', id)
			.compile(),
		...rearm.queries,
		eventInsert(db, actor, {
			type: 'project.unarchived',
			projectId: id,
			payload: { name: project.name, schedules_resumed: rearm.queries.length }
		})
	]);
	effects.signalDispatch();
	return {
		project: await getProject(db, actor.userId, id),
		schedules_resumed: rearm.queries.length
	};
}
