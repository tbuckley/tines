import type { ModelTier, RoutingTarget } from './types.js';

/** Reserved routing target meaning “inherit runners and override their tier”. */
export const INHERIT_RUNNER_ID = '*';

export interface RoutingScopeIds {
	project_id?: string | null;
	workflow_state_id?: string | null;
	label_id?: string | null;
}

/** Canonical label > project > state routing specificity. */
export function routingScopeSpecificity(scope: RoutingScopeIds): number {
	return (scope.label_id ? 4 : 0) + (scope.project_id ? 2 : 0) + (scope.workflow_state_id ? 1 : 0);
}

export function isGlobalRoutingScope(scope: RoutingScopeIds): boolean {
	return !scope.project_id && !scope.workflow_state_id && !scope.label_id;
}

/** True only for the canonical singleton tier-only target list. */
export function isTierOnlyTargets(
	targets: readonly RoutingTarget[]
): targets is [RoutingTarget & { runner_id: '*'; tier: ModelTier }] {
	return (
		targets.length === 1 &&
		targets[0]?.runner_id === INHERIT_RUNNER_ID &&
		(targets[0].tier === 'smartest' ||
			targets[0].tier === 'balanced' ||
			targets[0].tier === 'cheapest')
	);
}
