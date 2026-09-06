/**
 * The (project, workflow state, label, issue) scope tuple — one definition of
 * what a scope means, for every subsystem that scopes something by it: context
 * items, routing rules, runner-removal impact, and the dispatch explainer.
 *
 * Two operations live here, and only here:
 *
 * - **resolve** — the referenced ids exist, belong to the user, and cohere
 *   with each other; names come back denormalized for labels and events.
 * - **label** — the canonical display string. It is agent-facing (it lands in
 *   the launch prompt every agent reads), so it has exactly one definition.
 */
import type { ContextScope } from '@tines/shared';
import type { Kysely } from 'kysely';
import type { Database } from '$lib/server/db';
import { ApiFail } from './core';

export interface ScopeIds {
	projectId: string | null;
	workflowStateId: string | null;
	/**
	 * Issue label. Unlike the other three, this dimension is *set-valued* on
	 * the target side — an issue carries many labels — so a label-scoped item
	 * matches whenever the issue carries the label, and two scopes that set
	 * different labels can both match the same issue.
	 */
	labelId: string | null;
	issueId: string | null;
}

/** Scope input from a caller that has no issue dimension (routing rules). */
export type ScopeIdsInput = Omit<ScopeIds, 'issueId'> & { issueId?: string | null };

/** Denormalized referents of a (validated) scope, for labels and events. */
export interface ResolvedScope extends ScopeIds {
	projectName: string | null;
	stateName: string | null;
	labelName: string | null;
	labelColor: string | null;
	workflowId: string | null;
	workflowName: string | null;
	issueNumber: number | null;
	issueProjectName: string | null;
	/** The issue's project — used for event references. */
	issueProjectId: string | null;
	/** Archive state of the scope's project and of the issue's project (null = live). */
	projectArchivedAt: number | null;
	issueProjectArchivedAt: number | null;
}

/**
 * Canonical display label: set dimensions in project · state · label · issue
 * order (a label is narrower than the ambient dimensions, broader than a
 * single issue — the same order `layerRank` ranks them in);
 * the empty scope is "global". A dimension whose id is set but whose name is
 * unknown (a dangling reference) renders the id rather than vanishing — a
 * label must never understate the scope it describes.
 */
export function scopeLabel(
	scope: {
		projectId?: string | null;
		projectName?: string | null;
		workflowStateId?: string | null;
		stateName?: string | null;
		workflowId?: string | null;
		workflowName?: string | null;
		labelId?: string | null;
		labelName?: string | null;
		issueId?: string | null;
		issueProjectName?: string | null;
		issueNumber?: number | null;
	},
	/**
	 * `qualifyState` renders the state part as `state <workflow> / <state>`.
	 * Only inherited layers set it: an issue's prompt can stitch a base state
	 * and its own state, and two same-named states must not collide under one
	 * `## Context: state X` heading. Everywhere else the label stays short.
	 */
	{ qualifyState = false }: { qualifyState?: boolean } = {}
): string {
	const parts: string[] = [];
	if (scope.projectName || scope.projectId) {
		parts.push(`project ${scope.projectName || scope.projectId}`);
	}
	if (scope.stateName || scope.workflowStateId) {
		const state = scope.stateName || scope.workflowStateId;
		const workflow = qualifyState ? scope.workflowName || scope.workflowId : null;
		parts.push(`state ${workflow ? `${workflow} / ${state}` : state}`);
	}
	if (scope.labelName || scope.labelId) {
		parts.push(`label ${scope.labelName || scope.labelId}`);
	}
	if (scope.issueProjectName && scope.issueNumber !== null && scope.issueNumber !== undefined) {
		parts.push(`issue ${scope.issueProjectName}/${scope.issueNumber}`);
	} else if (scope.issueId) {
		parts.push(`issue ${scope.issueId}`);
	}
	return parts.length > 0 ? parts.join(' · ') : 'global';
}

/** The wire shape of a resolved scope, as every scoped resource serializes it. */
export function toContextScope(
	scope: ResolvedScope,
	options?: { qualifyState?: boolean }
): ContextScope {
	return {
		project_id: scope.projectId,
		project_name: scope.projectName,
		workflow_state_id: scope.workflowStateId,
		workflow_state_name: scope.stateName,
		workflow_id: scope.workflowId,
		workflow_name: scope.workflowName,
		label_id: scope.labelId,
		label_name: scope.labelName,
		label_color: (scope.labelColor as ContextScope['label_color']) ?? null,
		issue_id: scope.issueId,
		issue_ref:
			scope.issueId && scope.issueProjectName && scope.issueNumber !== null
				? { project_name: scope.issueProjectName, number: scope.issueNumber }
				: null,
		label: scopeLabel(scope, options)
	};
}

export interface ResolveScopeOptions {
	/** Whether the issue dimension is available to this caller (default true). */
	issue?: boolean;
	/**
	 * Reject states the supervisor never dispatches from (default false).
	 * Routing rules set it: the engine only picks up issues whose state
	 * category is `active`, so a rule scoped elsewhere can never match.
	 */
	requireActiveState?: boolean;
}

/**
 * Validates a scope: every referenced element exists and belongs to the user
 * (states may come from the system standard workflow), and the set dimensions
 * cohere (issue in project; state in the issue's bound workflow). An empty
 * scope is valid — the item is global and matches every issue.
 */
export async function resolveScope(
	db: Kysely<Database>,
	userId: string,
	ids: ScopeIdsInput,
	options: ResolveScopeOptions = {}
): Promise<ResolvedScope> {
	const issueId = options.issue === false ? null : (ids.issueId ?? null);
	const scope: ResolvedScope = {
		projectId: ids.projectId,
		workflowStateId: ids.workflowStateId,
		labelId: ids.labelId,
		issueId,
		projectName: null,
		stateName: null,
		labelName: null,
		labelColor: null,
		workflowId: null,
		workflowName: null,
		issueNumber: null,
		issueProjectName: null,
		issueProjectId: null,
		projectArchivedAt: null,
		issueProjectArchivedAt: null
	};

	if (ids.projectId) {
		const project = await db
			.selectFrom('project')
			.select(['id', 'name', 'archived_at'])
			.where('id', '=', ids.projectId)
			.where('user_id', '=', userId)
			.executeTakeFirst();
		if (!project) {
			throw new ApiFail(422, 'unknown_project', `Project "${ids.projectId}" does not exist`, {
				field: 'project_id'
			});
		}
		scope.projectName = project.name;
		scope.projectArchivedAt = project.archived_at;
	}

	if (ids.workflowStateId) {
		const state = await db
			.selectFrom('workflow_state')
			.innerJoin('workflow', 'workflow.id', 'workflow_state.workflow_id')
			.select([
				'workflow_state.id',
				'workflow_state.name',
				'workflow_state.category',
				'workflow.id as workflow_id',
				'workflow.name as workflow_name'
			])
			.where('workflow_state.id', '=', ids.workflowStateId)
			.where((eb) =>
				eb.or([eb('workflow.user_id', '=', userId), eb('workflow.user_id', 'is', null)])
			)
			.executeTakeFirst();
		if (!state) {
			throw new ApiFail(
				422,
				'unknown_state',
				`Workflow state "${ids.workflowStateId}" does not exist`,
				{ field: 'workflow_state_id' }
			);
		}
		if (options.requireActiveState && state.category !== 'active') {
			throw new ApiFail(
				422,
				'state_not_dispatchable',
				`State "${state.name}" is categorized ${state.category.replaceAll('_', ' ')} — agents only pick up issues in active states, so a rule scoped to it would never match anything. Leave the state unset to cover every active state`,
				{ field: 'workflow_state_id', state_category: state.category }
			);
		}
		scope.stateName = state.name;
		scope.workflowId = state.workflow_id;
		scope.workflowName = state.workflow_name;
	}

	if (ids.labelId) {
		// No coherence rule against the other dimensions: labels are flat and
		// user-wide, and an issue that does not carry the label simply does
		// not match — the same as a state-scoped item while the issue is
		// somewhere else.
		const label = await db
			.selectFrom('label')
			.select(['id', 'name', 'color'])
			.where('id', '=', ids.labelId)
			.where('user_id', '=', userId)
			.executeTakeFirst();
		if (!label) {
			throw new ApiFail(422, 'unknown_label', `Label "${ids.labelId}" does not exist`, {
				field: 'label_id'
			});
		}
		scope.labelName = label.name;
		scope.labelColor = label.color;
	}

	if (issueId) {
		const issue = await db
			.selectFrom('issue')
			.innerJoin('project', 'project.id', 'issue.project_id')
			.select([
				'issue.id',
				'issue.number',
				'issue.project_id',
				'issue.workflow_id',
				'project.name as project_name',
				'project.archived_at as project_archived_at'
			])
			.where('issue.id', '=', issueId)
			.where('project.user_id', '=', userId)
			.executeTakeFirst();
		if (!issue) {
			throw new ApiFail(422, 'unknown_issue', `Issue "${issueId}" does not exist`, {
				field: 'issue_id'
			});
		}
		scope.issueNumber = issue.number;
		scope.issueProjectName = issue.project_name;
		scope.issueProjectId = issue.project_id;
		scope.issueProjectArchivedAt = issue.project_archived_at;

		if (ids.projectId && issue.project_id !== ids.projectId) {
			throw new ApiFail(
				422,
				'scope_incoherent',
				`Issue ${issue.project_name}/${issue.number} does not belong to project "${scope.projectName}"`,
				{ issue_project_id: issue.project_id, project_id: ids.projectId }
			);
		}
		if (ids.workflowStateId && scope.workflowId !== issue.workflow_id) {
			throw new ApiFail(
				422,
				'scope_incoherent',
				`State "${scope.stateName}" belongs to workflow "${scope.workflowName}", not the workflow bound to issue ${issue.project_name}/${issue.number}`,
				{ state_workflow_id: scope.workflowId, issue_workflow_id: issue.workflow_id }
			);
		}
	}

	return scope;
}
