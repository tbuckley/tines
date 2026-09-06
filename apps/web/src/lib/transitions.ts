import type { AllowedTransition, WorkflowState } from '@tines/shared';

/**
 * Which move the issue page offers first, and which one it fills.
 *
 * The rule: the *lead* is the workflow's expected next step — the first
 * transition, in workflow order, whose target sits later in the workflow and
 * is not the escape lane. It is filled (the one primary button) only when it
 * is enabled; there is no fall-through to some other enabled move, because a
 * side-step is not what the workflow expects next. A state with exactly one
 * transition leads with it whatever its direction: there is nothing to
 * mis-tap against.
 *
 * The escape lane (Cancel / Abandon run / Drop) is identified by heuristic:
 * `workflow_transition` has no `position` column and no "escape" flag, so we
 * take the last state by position when it is `done` and the workflow has more
 * than one `done` state. That is correct on every live workflow — and
 * deliberately null for workflows whose single done state is the payoff
 * (Standard's `Closed` is reached by both `Approve` and `Abandon`), so their
 * `Approve` keeps its filled button. If a workflow ever breaks the pattern,
 * the fix is a schema change (a `position`/`is_escape` column on
 * `workflow_transition`), not a cleverer heuristic.
 *
 * Ordering is forward-enabled, forward-blocked, backward, escape. This
 * deliberately reverses Tines/128's "enabled first" for steps back: a blocked
 * forward move outranks an enabled step back, because its requirement line
 * *is* the next action.
 */

/** The workflow's escape lane, or null when its single done state is the payoff. */
export function escapeStateId(states: WorkflowState[]): string | null {
	const done = states.filter((s) => s.category === 'done');
	if (done.length < 2) return null;
	const last = states.reduce((a, b) => (b.position > a.position ? b : a));
	return last.category === 'done' ? last.id : null;
}

export type Direction = 'forward' | 'backward' | 'escape';

/** Forward = strictly later in the workflow and not the escape lane; self-loops count as backward. */
export function directionOf(
	transition: AllowedTransition,
	current: WorkflowState,
	escapeId: string | null
): Direction {
	if (escapeId !== null && transition.to_state.id === escapeId) return 'escape';
	return transition.to_state.position > current.position ? 'forward' : 'backward';
}

export interface TransitionPlan {
	/** forward-enabled, forward-blocked, backward, escape — workflow order inside each group. */
	ordered: AllowedTransition[];
	/** The step the workflow expects next (first forward non-escape, or the lone transition), or null. */
	leadId: string | null;
	/** `leadId` when the lead is enabled, else null. The one filled button. */
	primaryId: string | null;
}

export function planTransitions(
	/** In workflow (server) order. */
	transitions: AllowedTransition[],
	current: WorkflowState,
	states: WorkflowState[],
	isBlocked: (t: AllowedTransition) => boolean
): TransitionPlan {
	const escapeId = escapeStateId(states);
	const group = (d: Direction) =>
		transitions.filter((t) => directionOf(t, current, escapeId) === d);
	const forward = group('forward');

	const ordered = [
		...forward.filter((t) => !isBlocked(t)),
		...forward.filter((t) => isBlocked(t)),
		...group('backward'),
		...group('escape')
	];

	// The lead is picked in workflow order, not `ordered` order: a blocked
	// forward move is still the lead, it just is not filled.
	const lead = transitions.length === 1 ? transitions[0] : (forward[0] ?? null);

	return {
		ordered,
		leadId: lead?.transition_id ?? null,
		primaryId: lead && !isBlocked(lead) ? lead.transition_id : null
	};
}

/**
 * How many leading buttons fit the phone bar.
 *
 * Only the first slot may take width from the state chip, down to
 * `stateMin` — the chip is a redundant copy of the header badge, and losing a
 * few of its glyphs is a far smaller loss than losing the expected next step
 * off the bar entirely. A second button never costs the chip its name.
 * Transition names are never truncated: a button either fits whole or lives
 * in the sheet.
 */
export function fitDirect({
	widths,
	moreWidth,
	barWidth,
	stateWidth,
	stateMin,
	gap,
	max
}: {
	/** Natural width of each transition button, in transition order. */
	widths: number[];
	moreWidth: number;
	barWidth: number;
	/** The state chip at its natural width. */
	stateWidth: number;
	/** The floor the chip may shrink to for the first slot only. */
	stateMin: number;
	gap: number;
	max: number;
}): number {
	let used = 0;
	let count = 0;
	for (let i = 0; i < Math.min(max, widths.length); i++) {
		const chip = i === 0 ? Math.min(stateWidth, stateMin) : stateWidth;
		const available = barWidth - chip - gap;
		const next = used + (i === 0 ? 0 : gap) + widths[i];
		// Room for the "more" button too whenever this one would leave some hidden.
		const needsMore = i < widths.length - 1;
		if (next + (needsMore ? gap + moreWidth : 0) > available) break;
		used = next;
		count = i + 1;
	}
	return count;
}
