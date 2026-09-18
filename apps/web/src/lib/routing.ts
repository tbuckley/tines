/**
 * Routing writes the browser makes outside the routing editor: the one-click
 * "route everything to this runner" that the add-runner wizard and the
 * first-run checklist both offer.
 */
import type { RoutingRule, Runner } from '@tines/shared';
import { api } from '$lib/api';

/** All three scope dimensions null — a bare `label x` rule is not global. */
export function findGlobalRule(rules: RoutingRule[]): RoutingRule | null {
	return (
		rules.find(
			(r) =>
				r.scope.project_id === null &&
				r.scope.workflow_state_id === null &&
				r.scope.label_id === null
		) ?? null
	);
}

/**
 * Route everything to one runner: append it to the global rule, or create that
 * rule when there is none. A no-op when the rule already targets it.
 */
export async function addRunnerToGlobalRule(
	rules: RoutingRule[],
	runner: Runner
): Promise<RoutingRule> {
	const globalRule = findGlobalRule(rules);
	if (globalRule) {
		if (globalRule.targets.some((t) => t.runner_id === runner.id)) return globalRule;
		return api.updateRoutingRule(globalRule.id, {
			targets: [
				...globalRule.targets.map((t) => ({
					runner_id: t.runner_id,
					...(t.tier ? { tier: t.tier } : {})
				})),
				{ runner_id: runner.id }
			]
		});
	}
	return api.createRoutingRule({
		project_id: null,
		workflow_state_id: null,
		targets: [{ runner_id: runner.id }]
	});
}
