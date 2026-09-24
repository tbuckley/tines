import {
	FULL_API_KEY_PERMISSIONS,
	accessIncludes,
	permissionsIncludeProject,
	type AccessLevel,
	type ApiKeyPermissions,
	type ProjectAccessLevel
} from '@tines/shared';
import { sql, type RawBuilder, type SqlBool } from 'kysely';
import { ApiFail, notFound, runKeyForbidden, type ActorContext } from './core';
import type { Kysely } from 'kysely';
import type { Database } from '$lib/server/db';

export type Requirement =
	| { domain: 'project'; access: ProjectAccessLevel; projectId: string }
	| { domain: 'project'; access: ProjectAccessLevel; scope: 'all' }
	| { domain: 'workspace' | 'control_plane'; access: Exclude<AccessLevel, 'none'> };

export interface ResolvedPermissionTarget {
	projectId?: string;
	issueId?: string;
	/** True only when every mutated context scope is anchored to this issue. */
	issueScoped?: boolean;
	/** Set only after the context service resolves the exact journal scope. */
	boundJournal?: boolean;
}

function actorPolicy(actor: ActorContext): ApiKeyPermissions {
	if (actor.permissions) return actor.permissions;
	// Browser sessions are owner authority. Missing policy on any key actor is
	// a programming error, never an implicit grant.
	if (actor.viaSession && actor.apiKeyId === null) return FULL_API_KEY_PERMISSIONS;
	throw new ApiFail(500, 'missing_actor_permissions', 'API key authority was not loaded');
}

const RUN_OPERATIONS = new Set([
	'project.read',
	'issue.read',
	'issue.create',
	'issue.update',
	'issue.transition',
	'comment.create',
	'comment.update',
	'comment.delete',
	'artifact.read',
	'artifact.create',
	'artifact.update',
	'artifact.delete',
	'artifact.site_link',
	'context.read',
	'context.create',
	'context.update',
	'context.append',
	'context.delete',
	'journal.read',
	'journal.create',
	'journal.append',
	'journal.rewrite',
	'label.read',
	'starter.read',
	'label.assign',
	'label.remove',
	'issue_link.create',
	'issue_link.remove',
	'issue_link.read',
	'schedule.read',
	'workflow.read',
	'runner.read',
	'supervisor.read',
	'run.read',
	'usage.read',
	'event.read',
	'library.validate',
	'library.prepare',
	'library.export'
]);

const CONTEXT_MUTATIONS = new Set([
	'context.create',
	'context.update',
	'context.append',
	'context.delete'
]);

function requireRunOperation(
	actor: ActorContext,
	operation: string,
	target: ResolvedPermissionTarget
): void {
	const run = actor.runRestriction;
	if (!run) return;
	if (!RUN_OPERATIONS.has(operation))
		throw runKeyForbidden({ operation, reason: 'operation_forbidden' });
	if (target.projectId !== undefined && target.projectId !== run.projectId) {
		throw runKeyForbidden({ operation, reason: 'outside_run_project' });
	}
	const boundIssueWrite = new Set([
		'issue.update',
		'issue.transition',
		'comment.create',
		'comment.update',
		'comment.delete',
		'artifact.create',
		'artifact.update',
		'artifact.delete',
		'artifact.site_link',
		'context.create',
		'context.update',
		'context.append',
		'context.delete',
		'label.assign',
		'label.remove',
		'issue_link.create',
		'issue_link.remove'
	]);
	if (boundIssueWrite.has(operation) && target.issueId !== run.issueId) {
		throw runKeyForbidden({ operation, reason: 'outside_run_issue' });
	}
	if (CONTEXT_MUTATIONS.has(operation) && target.issueScoped !== true) {
		throw runKeyForbidden({ operation, reason: 'context_not_issue_scoped' });
	}
	if (operation.startsWith('journal.') && !target.boundJournal) {
		throw runKeyForbidden({ operation, reason: 'journal_anchor_unavailable' });
	}
}

/** Enforce every independently required domain before the caller mutates. */
export function requireAccess(
	actor: ActorContext,
	requirements: readonly Requirement[],
	operation: string,
	target: ResolvedPermissionTarget = {}
): void {
	requireRunOperation(actor, operation, target);
	const policy = actorPolicy(actor);
	for (const requirement of requirements) {
		const allowed =
			requirement.domain === 'project'
				? 'projectId' in requirement
					? permissionsIncludeProject(policy, requirement.projectId, requirement.access)
					: !actor.runRestriction &&
						policy.projects.scope === 'all' &&
						accessIncludes(policy.projects.access, requirement.access)
				: accessIncludes(policy[requirement.domain], requirement.access);
		if (!allowed) {
			throw new ApiFail(403, 'insufficient_permissions', 'The API key lacks required authority', {
				operation,
				domain: requirement.domain,
				access: requirement.access
			});
		}
	}
}

/** Authority needed before issuing or replacing an execution credential. */
export function requireExecutionDelegation(actor: ActorContext, operation: string): void {
	requireAccess(
		actor,
		[
			{ domain: 'project', access: 'write', scope: 'all' },
			{ domain: 'workspace', access: 'write' },
			{ domain: 'control_plane', access: 'write' }
		],
		operation
	);
}

/** Non-throwing form for filtering collection rows before they are returned. */
export function accessAllowed(
	actor: ActorContext,
	requirements: readonly Requirement[],
	operation: string,
	target: ResolvedPermissionTarget = {}
): boolean {
	try {
		requireAccess(actor, requirements, operation, target);
		return true;
	} catch (error) {
		if (
			error instanceof ApiFail &&
			(error.code === 'insufficient_permissions' || error.code === 'run_key_forbidden')
		) {
			return false;
		}
		throw error;
	}
}

/** Resolve an owned issue without leaking it, then enforce project plus extras. */
export async function requireIssueAccess(
	db: Kysely<Database>,
	actor: ActorContext,
	issueId: string,
	access: ProjectAccessLevel,
	operation: string,
	extras: readonly Requirement[] = []
): Promise<{ id: string; projectId: string }> {
	const issue = await db
		.selectFrom('issue')
		.innerJoin('project', 'project.id', 'issue.project_id')
		.select(['issue.id', 'issue.project_id'])
		.where('issue.id', '=', issueId)
		.where('project.user_id', '=', actor.userId)
		.executeTakeFirst();
	if (!issue) throw notFound();
	requireAccess(
		actor,
		[{ domain: 'project', access, projectId: issue.project_id }, ...extras],
		operation,
		{ projectId: issue.project_id, issueId: issue.id }
	);
	return { id: issue.id, projectId: issue.project_id };
}

/** SQL predicate for project-bearing reads; scope is bound as one JSON value. */
export function projectReadPredicate(
	actor: ActorContext,
	qualifiedProjectIdColumn: string
): RawBuilder<SqlBool> {
	return projectExpressionReadPredicate(
		actor,
		sql<string | null>`${sql.ref(qualifiedProjectIdColumn)}`
	);
}

/** Project-scope predicate for a derived project-id expression. */
export function projectExpressionReadPredicate(
	actor: ActorContext,
	projectId: RawBuilder<string | null>
): RawBuilder<SqlBool> {
	const policy = actorPolicy(actor);
	const runProjectId = actor.runRestriction?.projectId;
	if (runProjectId) {
		if (policy.projects.scope !== 'all' && !policy.projects.scope.includes(runProjectId)) {
			return sql<SqlBool>`1 = 0`;
		}
		return sql<SqlBool>`${projectId} = ${runProjectId}`;
	}
	if (policy.projects.scope === 'all') return sql<SqlBool>`1 = 1`;
	if (policy.projects.scope.length === 0) return sql<SqlBool>`1 = 0`;
	return sql<SqlBool>`${projectId} IN (
		SELECT value FROM json_each(${JSON.stringify(policy.projects.scope)})
	)`;
}

/** Requirements contributed by every populated context scope anchor. */
export function contextRequirements(
	scope: {
		projectId: string | null;
		issueProjectId: string | null;
		workflowStateId: string | null;
		labelId: string | null;
	},
	access: 'read' | 'write' | 'delete',
	options: { env?: boolean } = {}
): Requirement[] {
	const requirements: Requirement[] = [];
	const projectIds = new Set(
		[scope.projectId, scope.issueProjectId].filter((id): id is string => id !== null)
	);
	for (const projectId of projectIds) {
		requirements.push({ domain: 'project', access, projectId });
	}
	if (
		scope.workflowStateId !== null ||
		scope.labelId !== null ||
		(scope.projectId === null && scope.issueProjectId === null)
	) {
		requirements.push({ domain: 'workspace', access });
	}
	if (options.env) {
		requirements.push({
			domain: 'control_plane',
			access: access === 'delete' ? 'delete' : 'write'
		});
	}
	return requirements;
}

/**
 * Filter context rows before pagination. Project/issue anchors require project
 * read, while state/label/global anchors independently require workspace read.
 */
export function contextReadPredicate(
	actor: ActorContext,
	columns: {
		project: string;
		issueProject: string;
		state: string;
		label: string;
	}
): RawBuilder<SqlBool> {
	const policy = actorPolicy(actor);
	const workspaceReadable = accessIncludes(policy.workspace, 'read');
	const projectColumn = sql<
		string | null
	>`coalesce(${sql.ref(columns.project)}, ${sql.ref(columns.issueProject)})`;
	const runProjectId = actor.runRestriction?.projectId;
	const projectAllowed = runProjectId
		? sql<SqlBool>`${projectColumn} = ${runProjectId}`
		: policy.projects.scope === 'all'
			? sql<SqlBool>`1 = 1`
			: policy.projects.scope.length === 0
				? sql<SqlBool>`0 = 1`
				: sql<SqlBool>`${projectColumn} IN (SELECT value FROM json_each(${JSON.stringify(policy.projects.scope)}))`;
	const hasProject = sql<SqlBool>`${projectColumn} IS NOT NULL`;
	const needsWorkspace = sql<SqlBool>`(${sql.ref(columns.state)} IS NOT NULL OR ${sql.ref(columns.label)} IS NOT NULL OR ${projectColumn} IS NULL)`;
	return sql<SqlBool>`(
		((${hasProject} AND ${projectAllowed}) AND (${workspaceReadable ? sql`1 = 1` : sql`NOT ${needsWorkspace}`}))
		OR (${projectColumn} IS NULL AND ${workspaceReadable ? sql`1 = 1` : sql`0 = 1`})
	)`;
}
