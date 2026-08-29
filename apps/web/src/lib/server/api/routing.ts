import type {
	ContextScope,
	CreateRoutingRuleRequest,
	RoutingRule,
	RoutingRuleWithWarnings,
	RoutingTarget,
	ShadowWarning,
	UpdateRoutingRuleRequest
} from '@tines/shared';
import type { Kysely } from 'kysely';
import { newId, type Database } from '$lib/server/db';
import { ApiFail, notFound, runAtomic, type ActorContext } from './core';
import { eventInsert } from './events';
import { requireTier } from './runners';
import { resolveScope, scopeLabel, toContextScope } from './scope';

// ---------------------------------------------------------------------------
// Scope: two nullable dimensions (no issue — pins cover that), AND semantics

export interface RuleScopeIds {
	projectId: string | null;
	workflowStateId: string | null;
}

/**
 * Routing is winner-take-all, so specificity is a total order — and unlike
 * the context system's merge ordering it puts project above state:
 * `project ∧ state` (3) > `project` (2) > `state` (1) > global (0).
 * Ownership ("acme work never leaves my laptop") is project-shaped.
 */
export function ruleSpecificity(scope: {
	projectId?: string | null;
	workflowStateId?: string | null;
}): number {
	return (scope.projectId ? 2 : 0) + (scope.workflowStateId ? 1 : 0);
}

/** Two rule scopes can match the same issue iff no set dimension conflicts. */
export function ruleScopesOverlap(a: RuleScopeIds, b: RuleScopeIds): boolean {
	const projectsCompatible = !a.projectId || !b.projectId || a.projectId === b.projectId;
	const statesCompatible =
		!a.workflowStateId || !b.workflowStateId || a.workflowStateId === b.workflowStateId;
	return projectsCompatible && statesCompatible;
}

export function sameExactScope(a: RuleScopeIds, b: RuleScopeIds): boolean {
	return a.projectId === b.projectId && a.workflowStateId === b.workflowStateId;
}

export interface RuleForShadowing extends RuleScopeIds {
	id: string;
	label: string;
}

/**
 * Authoring-time shadow hints: because the most specific rule silently wins,
 * saving a rule notes which existing rules will take precedence over it for
 * some issues, and which it now takes precedence over — the interaction
 * surfaces when the rule is written, not as explainer archaeology later.
 */
export function shadowWarnings(
	saved: RuleScopeIds & { id?: string },
	others: RuleForShadowing[]
): ShadowWarning[] {
	const savedSpec = ruleSpecificity(saved);
	const warnings: ShadowWarning[] = [];
	for (const other of others) {
		if (other.id === saved.id) continue;
		if (sameExactScope(saved, other) || !ruleScopesOverlap(saved, other)) continue;
		const otherSpec = ruleSpecificity(other);
		if (otherSpec > savedSpec) {
			warnings.push({
				rule_id: other.id,
				scope_label: other.label,
				message: `The ${other.label} rule is more specific, so issues it matches will use it instead of this rule`
			});
		} else if (otherSpec < savedSpec) {
			warnings.push({
				rule_id: other.id,
				scope_label: other.label,
				message: `This rule takes precedence over the ${other.label} rule for issues both match`
			});
		}
		// Equal specificity with different scopes can only be project-vs-project
		// or state-vs-state, which never overlap — unreachable here.
	}
	return warnings;
}

/** The existing rule at the same exact scope, if any (one rule per scope). */
export function findScopeCollision<T extends RuleScopeIds & { id: string }>(
	scope: RuleScopeIds,
	rules: T[],
	excludeId?: string
): T | undefined {
	return rules.find((r) => r.id !== excludeId && sameExactScope(scope, r));
}

// ---------------------------------------------------------------------------
// Targets

/**
 * Validates an ordered target list against the user's runners and the closed
 * tier set. `runnersById` carries every runner the user owns.
 */
export function validateTargets(
	value: unknown,
	runnersById: Map<string, { id: string; name: string }>
): RoutingTarget[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new ApiFail(
			422,
			'invalid_field',
			'"targets" must be a non-empty ordered array of { runner_id, tier? }',
			{ field: 'targets' }
		);
	}
	const targets: RoutingTarget[] = [];
	const seen = new Set<string>();
	for (const [i, entry] of value.entries()) {
		if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
			throw new ApiFail(422, 'invalid_field', `"targets[${i}]" must be an object { runner_id, tier? }`, {
				field: 'targets'
			});
		}
		const input = entry as { runner_id?: unknown; tier?: unknown };
		if (typeof input.runner_id !== 'string' || !runnersById.has(input.runner_id)) {
			throw new ApiFail(
				422,
				'unknown_runner',
				`"targets[${i}].runner_id" (${JSON.stringify(input.runner_id)}) is not one of your runners`,
				{ field: 'targets', runner_id: input.runner_id ?? null }
			);
		}
		const tier =
			input.tier === undefined || input.tier === null ? null : requireTier(input.tier, `targets[${i}].tier`);
		const key = `${input.runner_id}:${tier ?? ''}`;
		if (seen.has(key)) {
			const name = runnersById.get(input.runner_id)?.name;
			throw new ApiFail(
				422,
				'duplicate_target',
				`Target "${name}"${tier ? ` (tier ${tier})` : ''} is listed more than once`,
				{ field: 'targets' }
			);
		}
		seen.add(key);
		targets.push(tier === null ? { runner_id: input.runner_id } : { runner_id: input.runner_id, tier });
	}
	return targets;
}

// ---------------------------------------------------------------------------
// Loading

function ruleQuery(db: Kysely<Database>, userId: string) {
	return db
		.selectFrom('routing_rule')
		.leftJoin('project as scope_project', 'scope_project.id', 'routing_rule.project_id')
		.leftJoin('workflow_state as scope_state', 'scope_state.id', 'routing_rule.workflow_state_id')
		.leftJoin('workflow as scope_workflow', 'scope_workflow.id', 'scope_state.workflow_id')
		.selectAll('routing_rule')
		.select([
			'scope_project.name as scope_project_name',
			'scope_state.name as scope_state_name',
			'scope_workflow.id as scope_workflow_id',
			'scope_workflow.name as scope_workflow_name'
		])
		.where('routing_rule.user_id', '=', userId);
}

type RuleRow = Awaited<ReturnType<ReturnType<typeof ruleQuery>['execute']>>[number];

/** A rule row on the wire — a rule scope never has the issue dimension. */
function rowScope(row: RuleRow): ContextScope {
	return toContextScope({
		projectId: row.project_id,
		workflowStateId: row.workflow_state_id,
		issueId: null,
		projectName: row.scope_project_name,
		stateName: row.scope_state_name,
		workflowId: row.scope_workflow_id,
		workflowName: row.scope_workflow_name,
		issueNumber: null,
		issueProjectName: null,
		issueProjectId: null
	});
}

async function loadRunnersById(
	db: Kysely<Database>,
	userId: string
): Promise<Map<string, { id: string; name: string; status: string }>> {
	const rows = await db
		.selectFrom('runner')
		.select(['id', 'name', 'status'])
		.where('user_id', '=', userId)
		.execute();
	return new Map(rows.map((r) => [r.id, r]));
}

function serializeRule(
	row: RuleRow,
	runnersById: Map<string, { id: string; name: string; status: string }>
): RoutingRule {
	const targets = (JSON.parse(row.targets) as RoutingTarget[]).map((t) => {
		const runner = runnersById.get(t.runner_id);
		return {
			runner_id: t.runner_id,
			runner_name: runner?.name ?? 'removed runner',
			runner_status: (runner?.status ?? 'paused') as 'active' | 'paused',
			tier: t.tier ?? null
		};
	});
	return {
		id: row.id,
		scope: rowScope(row),
		targets,
		created_at: row.created_at,
		updated_at: row.updated_at
	};
}

export async function listRoutingRules(db: Kysely<Database>, userId: string): Promise<RoutingRule[]> {
	const [rows, runnersById] = await Promise.all([
		ruleQuery(db, userId).execute(),
		loadRunnersById(db, userId)
	]);
	// Most specific first, then by scope label for a stable, readable list.
	return rows
		.map((row) => ({ row, rule: serializeRule(row, runnersById) }))
		.sort(
			(a, b) =>
				ruleSpecificity({ projectId: b.row.project_id, workflowStateId: b.row.workflow_state_id }) -
					ruleSpecificity({ projectId: a.row.project_id, workflowStateId: a.row.workflow_state_id }) ||
				a.rule.scope.label.localeCompare(b.rule.scope.label)
		)
		.map((e) => e.rule);
}

export async function getRoutingRule(
	db: Kysely<Database>,
	userId: string,
	id: string
): Promise<RoutingRule> {
	const row = await ruleQuery(db, userId).where('routing_rule.id', '=', id).executeTakeFirst();
	if (!row) throw notFound();
	return serializeRule(row, await loadRunnersById(db, userId));
}

// ---------------------------------------------------------------------------
// Mutations

async function loadRulesForShadowing(
	db: Kysely<Database>,
	userId: string
): Promise<RuleForShadowing[]> {
	const rows = await ruleQuery(db, userId).execute();
	return rows.map((row) => ({
		id: row.id,
		projectId: row.project_id,
		workflowStateId: row.workflow_state_id,
		label: rowScope(row).label
	}));
}

function assertNoScopeCollision(
	scope: RuleScopeIds,
	label: string,
	rules: RuleForShadowing[],
	excludeId?: string
) {
	const existing = findScopeCollision(scope, rules, excludeId);
	if (existing) {
		throw new ApiFail(
			422,
			'scope_collision',
			`A routing rule already exists at this exact scope (${label}); edit it instead — one rule per scope`,
			{ existing_rule_id: existing.id, scope_label: label }
		);
	}
}

export async function createRoutingRule(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	body: CreateRoutingRuleRequest
): Promise<RoutingRuleWithWarnings> {
	const scope: RuleScopeIds = {
		projectId: body.project_id ?? null,
		workflowStateId: body.workflow_state_id ?? null
	};
	const label = scopeLabel(
		await resolveScope(db, actor.userId, scope, { issue: false, requireActiveState: true })
	);
	const rules = await loadRulesForShadowing(db, actor.userId);
	assertNoScopeCollision(scope, label, rules);
	const runnersById = await loadRunnersById(db, actor.userId);
	const targets = validateTargets(body.targets, runnersById);

	const now = Date.now();
	const id = newId('rul');
	await runAtomic(env, [
		db
			.insertInto('routing_rule')
			.values({
				id,
				user_id: actor.userId,
				project_id: scope.projectId,
				workflow_state_id: scope.workflowStateId,
				targets: JSON.stringify(targets),
				created_at: now,
				updated_at: now
			})
			.compile(),
		eventInsert(db, actor, {
			type: 'routing_rule.created',
			projectId: scope.projectId,
			payload: {
				rule_id: id,
				scope_label: label,
				targets: targets.map((t) => ({
					runner_name: runnersById.get(t.runner_id)?.name,
					tier: t.tier ?? null
				}))
			}
		})
	]);
	return {
		...(await getRoutingRule(db, actor.userId, id)),
		warnings: shadowWarnings({ ...scope, id }, rules)
	};
}

export async function updateRoutingRule(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	id: string,
	body: UpdateRoutingRuleRequest
): Promise<RoutingRuleWithWarnings> {
	const row = await ruleQuery(db, actor.userId).where('routing_rule.id', '=', id).executeTakeFirst();
	if (!row) throw notFound();

	// Merge-patch scope: omitted = unchanged, explicit null = unset.
	const scope: RuleScopeIds = {
		projectId: body.project_id !== undefined ? body.project_id : row.project_id,
		workflowStateId:
			body.workflow_state_id !== undefined ? body.workflow_state_id : row.workflow_state_id
	};
	const scopeChanged =
		scope.projectId !== row.project_id || scope.workflowStateId !== row.workflow_state_id;
	const label = scopeLabel(
		await resolveScope(db, actor.userId, scope, { issue: false, requireActiveState: true })
	);
	const rules = await loadRulesForShadowing(db, actor.userId);
	if (scopeChanged) assertNoScopeCollision(scope, label, rules, id);

	const runnersById = await loadRunnersById(db, actor.userId);
	const targets =
		body.targets !== undefined
			? validateTargets(body.targets, runnersById)
			: (JSON.parse(row.targets) as RoutingTarget[]);

	if (!scopeChanged && JSON.stringify(targets) === row.targets) {
		return { ...serializeRule(row, runnersById), warnings: shadowWarnings({ ...scope, id }, rules) };
	}

	await runAtomic(env, [
		db
			.updateTable('routing_rule')
			.set({
				project_id: scope.projectId,
				workflow_state_id: scope.workflowStateId,
				targets: JSON.stringify(targets),
				updated_at: Date.now()
			})
			.where('id', '=', id)
			.compile(),
		eventInsert(db, actor, {
			type: 'routing_rule.updated',
			projectId: scope.projectId,
			payload: {
				rule_id: id,
				scope_label: label,
				targets: targets.map((t) => ({
					runner_name: runnersById.get(t.runner_id)?.name,
					tier: t.tier ?? null
				}))
			}
		})
	]);
	return {
		...(await getRoutingRule(db, actor.userId, id)),
		warnings: shadowWarnings({ ...scope, id }, rules)
	};
}

export async function deleteRoutingRule(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	id: string
): Promise<void> {
	const row = await ruleQuery(db, actor.userId).where('routing_rule.id', '=', id).executeTakeFirst();
	if (!row) throw notFound();
	await runAtomic(env, [
		db.deleteFrom('routing_rule').where('id', '=', id).compile(),
		eventInsert(db, actor, {
			type: 'routing_rule.deleted',
			projectId: row.project_id,
			payload: { rule_id: id, scope_label: rowScope(row).label }
		})
	]);
}
