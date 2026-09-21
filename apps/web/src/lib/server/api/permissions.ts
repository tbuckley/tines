import {
	FULL_API_KEY_PERMISSIONS,
	accessIncludes,
	permissionsIncludeProject,
	type AccessLevel,
	type ApiKeyPermissions,
	type ProjectAccessLevel
} from '@tines/shared';
import { sql, type RawBuilder, type SqlBool } from 'kysely';
import { ApiFail, runKeyForbidden, type ActorContext } from './core';

export type Requirement =
	| { domain: 'project'; access: ProjectAccessLevel; projectId: string }
	| { domain: 'project'; access: ProjectAccessLevel; scope: 'all' }
	| { domain: 'workspace' | 'control_plane'; access: Exclude<AccessLevel, 'none'> };

export interface ResolvedPermissionTarget {
	projectId?: string;
	issueId?: string;
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
	'issue_link.read',
	'issue_link.create',
	'issue_link.remove',
	'workflow.read',
	'runner.read',
	'supervisor.read',
	'run.read',
	'event.read',
	'library.validate',
	'library.prepare'
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
		'label.assign',
		'label.remove'
	]);
	if (boundIssueWrite.has(operation) && target.issueId !== run.issueId) {
		throw runKeyForbidden({ operation, reason: 'outside_run_issue' });
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
					: policy.projects.scope === 'all' &&
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

/** SQL predicate for project-bearing reads; scope is bound as one JSON value. */
export function projectReadPredicate(
	actor: ActorContext,
	qualifiedProjectIdColumn: string
): RawBuilder<SqlBool> {
	const policy = actorPolicy(actor);
	const runProjectId = actor.runRestriction?.projectId;
	if (runProjectId) {
		if (policy.projects.scope !== 'all' && !policy.projects.scope.includes(runProjectId)) {
			return sql<SqlBool>`1 = 0`;
		}
		return sql<SqlBool>`${sql.ref(qualifiedProjectIdColumn)} = ${runProjectId}`;
	}
	if (policy.projects.scope === 'all') return sql<SqlBool>`1 = 1`;
	if (policy.projects.scope.length === 0) return sql<SqlBool>`1 = 0`;
	return sql<SqlBool>`${sql.ref(qualifiedProjectIdColumn)} IN (
		SELECT value FROM json_each(${JSON.stringify(policy.projects.scope)})
	)`;
}
