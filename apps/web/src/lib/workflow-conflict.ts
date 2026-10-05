import type { ArtifactRequirement, Workflow, WorkflowTransition } from '@tines/shared';

/**
 * What a save conflict shows the person whose draft was refused: the named
 * differences between the definition their draft started from and the one
 * now stored. Lines, not counts — the server's own diff helper returns
 * counts for the event payload, and a reviewer needs to read what moved.
 */

type Definition = Pick<
	Workflow,
	'name' | 'description' | 'initial_state_id' | 'states' | 'transitions'
>;

const quote = (value: string) => `“${value}”`;

function requirementLabel(requirement: ArtifactRequirement): string {
	const filter = [requirement.type, requirement.content_type].filter(Boolean).join(', ');
	return filter ? `${requirement.artifact} (${filter})` : requirement.artifact;
}

function gateLabel(requires: ArtifactRequirement[] | undefined): string {
	return requires && requires.length > 0 ? requires.map(requirementLabel).join(', ') : 'nothing';
}

/** Order-sensitive, description included: the server stores the list as given. */
const gateKey = (requires: ArtifactRequirement[] | undefined) =>
	JSON.stringify(
		(requires ?? []).map((r) => [
			r.artifact,
			r.type ?? '',
			r.content_type ?? '',
			r.description ?? ''
		])
	);

/**
 * Transition ids are reissued on every semantic graph save, so an action is
 * matched by what makes it unique in the editor: its source state and name.
 */
const actionKey = (transition: WorkflowTransition) =>
	`${transition.from_state_id}:${transition.name.trim().toLowerCase()}`;

export function summarizeWorkflowChanges(base: Definition, latest: Definition): string[] {
	const lines: string[] = [];
	const baseStates = new Map(base.states.map((state) => [state.id, state]));
	const latestStates = new Map(latest.states.map((state) => [state.id, state]));
	const stateName = (id: string) =>
		latestStates.get(id)?.name ?? baseStates.get(id)?.name ?? 'a removed state';

	if (latest.name !== base.name) {
		lines.push(`The workflow was renamed from ${quote(base.name)} to ${quote(latest.name)}.`);
	}
	if (latest.description !== base.description) {
		lines.push(
			latest.description ? 'The description was changed.' : 'The description was cleared.'
		);
	}
	if (latest.initial_state_id !== base.initial_state_id) {
		lines.push(`The initial state is now ${quote(stateName(latest.initial_state_id))}.`);
	}

	for (const state of latest.states) {
		const before = baseStates.get(state.id);
		if (!before) {
			lines.push(`State ${quote(state.name)} was added.`);
			continue;
		}
		if (before.name !== state.name) {
			lines.push(`State ${quote(before.name)} was renamed to ${quote(state.name)}.`);
		}
		if (before.category !== state.category) {
			lines.push(
				`State ${quote(state.name)} changed category from ${before.category} to ${state.category}.`
			);
		}
	}
	for (const state of base.states) {
		if (!latestStates.has(state.id)) lines.push(`State ${quote(state.name)} was removed.`);
	}
	const keptBefore = base.states.filter((state) => latestStates.has(state.id)).map((s) => s.id);
	const keptAfter = latest.states.filter((state) => baseStates.has(state.id)).map((s) => s.id);
	if (keptBefore.join('\n') !== keptAfter.join('\n')) {
		lines.push(`States were reordered: ${latest.states.map((s) => s.name).join(', ')}.`);
	}

	const actionLabel = (transition: WorkflowTransition) =>
		`${quote(transition.name)} (${stateName(transition.from_state_id)} → ${stateName(transition.to_state_id)})`;
	const baseActions = new Map(base.transitions.map((t) => [actionKey(t), t]));
	const latestActions = new Map(latest.transitions.map((t) => [actionKey(t), t]));
	for (const transition of latest.transitions) {
		const before = baseActions.get(actionKey(transition));
		if (!before) {
			const gate =
				transition.requires && transition.requires.length > 0
					? `, requiring ${gateLabel(transition.requires)}`
					: '';
			lines.push(`Action ${actionLabel(transition)} was added${gate}.`);
			continue;
		}
		if (before.to_state_id !== transition.to_state_id) {
			lines.push(
				`Action ${quote(transition.name)} from ${quote(stateName(transition.from_state_id))} now leads to ${quote(stateName(transition.to_state_id))} instead of ${quote(stateName(before.to_state_id))}.`
			);
		}
		if (gateKey(before.requires) !== gateKey(transition.requires)) {
			lines.push(
				`Action ${actionLabel(transition)} now requires ${gateLabel(transition.requires)} (was ${gateLabel(before.requires)}).`
			);
		}
	}
	for (const transition of base.transitions) {
		if (!latestActions.has(actionKey(transition))) {
			lines.push(`Action ${actionLabel(transition)} was removed.`);
		}
	}
	return lines;
}

/**
 * Draft states the latest version no longer has. Saving the draft over the
 * latest cannot keep their ids, so they go out as new states.
 */
export function statesDeletedInLatest<T extends { id?: string }>(
	draftStates: T[],
	latest: Pick<Workflow, 'states'>
): T[] {
	const latestIds = new Set(latest.states.map((state) => state.id));
	return draftStates.filter((state) => state.id !== undefined && !latestIds.has(state.id));
}

export function deletedStateLine(name: string): string {
	return `${quote(name)} was deleted in the latest version; saving your version re-creates it as a new state without its stage instructions.`;
}
