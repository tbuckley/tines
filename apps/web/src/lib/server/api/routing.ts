import type {
	ContextScope,
	CreateRoutingRuleRequest,
	RoutingRule,
	RoutingRuleWithWarnings,
	RoutingTarget,
	ShadowWarning,
	UpdateRoutingRuleRequest
} from '@tines/shared';
import type { CompiledQuery, Kysely } from 'kysely';
import { newId, type Database } from '$lib/server/db';
import { ApiFail, notFound, runAtomic, type ActorContext } from './core';
import { eventInsert } from './events';
import { requireTier } from './runners';
import { resolveScope, scopeLabel, toContextScope } from './scope';

// ---------------------------------------------------------------------------
// Scope: three nullable dimensions (no issue — pins cover that), AND semantics

export interface RuleScopeIds {
	projectId: string | null;
	workflowStateId: string | null;
	labelId: string | null;
}

/**
 * Routing is winner-take-all, so specificity is a total order — and unlike
 * the context system's merge ordering it puts project above state:
 * `label ∧ project ∧ state` (7) > `label ∧ project` (6) > `label ∧ state` (5)
 * > `label` (4) > `project ∧ state` (3) > `project` (2) > `state` (1) >
 * global (0). Ownership ("acme work never leaves my laptop") is
 * project-shaped, and a label outranks it because a label says what the work
 * *is* ("anything labelled security stays on the laptop") — the strongest
 * claim on where it may run. Adding label as the high bit is a prefix
 * extension: every rule that existed before it keeps its rank.
 */
export function ruleSpecificity(scope: {
	projectId?: string | null;
	workflowStateId?: string | null;
	labelId?: string | null;
}): number {
	return (scope.labelId ? 4 : 0) + (scope.projectId ? 2 : 0) + (scope.workflowStateId ? 1 : 0);
}

/** Two rule scopes can match the same issue iff no set dimension conflicts. */
export function ruleScopesOverlap(a: RuleScopeIds, b: RuleScopeIds): boolean {
	const projectsCompatible = !a.projectId || !b.projectId || a.projectId === b.projectId;
	const statesCompatible =
		!a.workflowStateId || !b.workflowStateId || a.workflowStateId === b.workflowStateId;
	// Labels never make two scopes disjoint: an issue carries a *set* of them,
	// so `label design` and `label qa` both match an issue carrying both.
	// There is deliberately no label term here.
	return projectsCompatible && statesCompatible;
}

export function sameExactScope(a: RuleScopeIds, b: RuleScopeIds): boolean {
	return (
		a.projectId === b.projectId &&
		a.workflowStateId === b.workflowStateId &&
		a.labelId === b.labelId
	);
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
				kind: 'shadowed',
				rule_id: other.id,
				scope_label: other.label,
				message: `The ${other.label} rule is more specific, so issues it matches will use it instead of this rule`
			});
		} else if (otherSpec < savedSpec) {
			warnings.push({
				kind: 'shadows',
				rule_id: other.id,
				scope_label: other.label,
				message: `This rule takes precedence over the ${other.label} rule for issues both match`
			});
		} else {
			// Equal specificity with different scopes used to be unreachable:
			// two rules of the same rank differ in some dimension, and for
			// project/state a difference means they cannot both match. Labels
			// are set-valued, so two different-label rules of equal rank *can*
			// both match — and then neither is more specific, so the issue
			// fails closed rather than routing on a coin toss. Say so now,
			// while the rule is being written.
			warnings.push({
				kind: 'ambiguous',
				rule_id: other.id,
				scope_label: other.label,
				message: `Issues matching both this rule and the ${other.label} rule match them equally — neither is more specific, so those issues will not dispatch until one rule adds a project or state`
			});
		}
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
			throw new ApiFail(
				422,
				'invalid_field',
				`"targets[${i}]" must be an object { runner_id, tier? }`,
				{
					field: 'targets'
				}
			);
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
			input.tier === undefined || input.tier === null
				? null
				: requireTier(input.tier, `targets[${i}].tier`);
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
		targets.push(
			tier === null ? { runner_id: input.runner_id } : { runner_id: input.runner_id, tier }
		);
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
		.leftJoin('label as scope_label', 'scope_label.id', 'routing_rule.label_id')
		.selectAll('routing_rule')
		.select([
			'scope_project.name as scope_project_name',
			'scope_state.name as scope_state_name',
			'scope_label.name as scope_label_name',
			'scope_label.color as scope_label_color',
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
		labelId: row.label_id,
		issueId: null,
		projectName: row.scope_project_name,
		stateName: row.scope_state_name,
		labelName: row.scope_label_name,
		labelColor: row.scope_label_color,
		workflowId: row.scope_workflow_id,
		workflowName: row.scope_workflow_name,
		issueNumber: null,
		issueProjectName: null,
		issueProjectId: null,
		projectArchivedAt: null,
		issueProjectArchivedAt: null
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

/** The three scope dimensions of a rule row, as `ruleSpecificity` wants them. */
function rowScopeIds(row: RuleRow): RuleScopeIds {
	return {
		projectId: row.project_id,
		workflowStateId: row.workflow_state_id,
		labelId: row.label_id
	};
}

/**
 * Every rule the user owns, most specific first — the same total order the
 * dispatcher picks a winner in, so the list can be read top-down instead of
 * mentally sorted.
 *
 * Each rule carries the warnings that describe *itself*: `shadowed` (a rule
 * further up wins for issues both match) and `ambiguous` (a tie, so neither
 * dispatches). The `shadows` direction is deliberately dropped here — sorted,
 * it only ever says "the rule below me", which the order already shows. The
 * create/update responses still carry all three, because there the rule being
 * written has no place in a list yet.
 */
export async function listRoutingRules(
	db: Kysely<Database>,
	userId: string
): Promise<RoutingRuleWithWarnings[]> {
	const [rows, runnersById] = await Promise.all([
		ruleQuery(db, userId).execute(),
		loadRunnersById(db, userId)
	]);
	const entries = rows.map((row) => ({ row, rule: serializeRule(row, runnersById) }));
	const forShadowing: RuleForShadowing[] = entries.map(({ row, rule }) => ({
		id: row.id,
		...rowScopeIds(row),
		label: rule.scope.label
	}));
	// Most specific first, then by scope label for a stable, readable list.
	return entries
		.sort(
			(a, b) =>
				ruleSpecificity(rowScopeIds(b.row)) - ruleSpecificity(rowScopeIds(a.row)) ||
				a.rule.scope.label.localeCompare(b.rule.scope.label)
		)
		.map(({ row, rule }) => ({
			...rule,
			warnings: shadowWarnings({ id: row.id, ...rowScopeIds(row) }, forShadowing).filter(
				(w) => w.kind !== 'shadows'
			)
		}));
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
	return rows.map((row) => ({ id: row.id, ...rowScopeIds(row), label: rowScope(row).label }));
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
		workflowStateId: body.workflow_state_id ?? null,
		labelId: body.label_id ?? null
	};
	const label = scopeLabel(
		await resolveScope(
			db,
			actor.userId,
			{ ...scope, issueId: null },
			{
				issue: false,
				requireActiveState: true
			}
		)
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
				label_id: scope.labelId,
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
	const row = await ruleQuery(db, actor.userId)
		.where('routing_rule.id', '=', id)
		.executeTakeFirst();
	if (!row) throw notFound();

	// Merge-patch scope: omitted = unchanged, explicit null = unset.
	const scope: RuleScopeIds = {
		projectId: body.project_id !== undefined ? body.project_id : row.project_id,
		workflowStateId:
			body.workflow_state_id !== undefined ? body.workflow_state_id : row.workflow_state_id,
		labelId: body.label_id !== undefined ? body.label_id : row.label_id
	};
	const scopeChanged =
		scope.projectId !== row.project_id ||
		scope.workflowStateId !== row.workflow_state_id ||
		scope.labelId !== row.label_id;
	const label = scopeLabel(
		await resolveScope(
			db,
			actor.userId,
			{ ...scope, issueId: null },
			{
				issue: false,
				requireActiveState: true
			}
		)
	);
	const rules = await loadRulesForShadowing(db, actor.userId);
	if (scopeChanged) assertNoScopeCollision(scope, label, rules, id);

	const runnersById = await loadRunnersById(db, actor.userId);
	const targets =
		body.targets !== undefined
			? validateTargets(body.targets, runnersById)
			: (JSON.parse(row.targets) as RoutingTarget[]);

	if (!scopeChanged && JSON.stringify(targets) === row.targets) {
		return {
			...serializeRule(row, runnersById),
			warnings: shadowWarnings({ ...scope, id }, rules)
		};
	}

	await runAtomic(env, [
		db
			.updateTable('routing_rule')
			.set({
				project_id: scope.projectId,
				workflow_state_id: scope.workflowStateId,
				label_id: scope.labelId,
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

/**
 * The rules a label scopes, for label deletion (D5). Named by scope the way
 * `tines routing list` prints them, so the 422 reads like the rule list.
 */
export async function rulesScopedToLabel(
	db: Kysely<Database>,
	userId: string,
	labelId: string
): Promise<{ id: string; project_id: string | null; scope_label: string }[]> {
	const rows = await ruleQuery(db, userId).where('routing_rule.label_id', '=', labelId).execute();
	return rows.map((row) => ({
		id: row.id,
		project_id: row.project_id,
		scope_label: rowScope(row).label
	}));
}

/**
 * Compiled deletes + `routing_rule.deleted` events for a label's rules, for
 * the caller's batch. A label-scoped rule is *deleted*, never stripped of its
 * label: stripping would silently broaden `label docs ∧ project X` into
 * `project X` and route work nobody asked it to.
 */
export function routingRuleDeletes(
	db: Kysely<Database>,
	actor: ActorContext,
	rules: { id: string; project_id: string | null; scope_label: string }[]
): CompiledQuery[] {
	return rules.flatMap((rule) => [
		db.deleteFrom('routing_rule').where('id', '=', rule.id).compile(),
		eventInsert(db, actor, {
			type: 'routing_rule.deleted',
			projectId: rule.project_id,
			payload: { rule_id: rule.id, scope_label: rule.scope_label, via: 'label.deleted' }
		})
	]);
}

export async function deleteRoutingRule(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	id: string
): Promise<void> {
	const row = await ruleQuery(db, actor.userId)
		.where('routing_rule.id', '=', id)
		.executeTakeFirst();
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
