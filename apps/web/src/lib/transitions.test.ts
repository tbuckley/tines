import { describe, expect, it } from 'vitest';
import type {
	AllowedTransition,
	ArtifactRequirementCheck,
	StateCategory,
	WorkflowState
} from '@tines/shared';
import { directionOf, escapeStateId, fitDirect, planTransitions } from './transitions';

// Fixtures mirror the live workflows' shapes (state names, categories and
// positions as of 2026-09-05); ids are derived from names so the tables below
// read as the UI does.

const states = (spec: [string, StateCategory][]): WorkflowState[] =>
	spec.map(([name, category], position) => ({
		id: `s:${name}`,
		name,
		category,
		position,
		inherits_from: null
	}));

const missing = (artifact: string): ArtifactRequirementCheck => ({
	artifact,
	status: 'missing',
	current_version: null,
	current_type: null
});
const satisfied = (artifact: string): ArtifactRequirementCheck => ({
	artifact,
	status: 'satisfied',
	current_version: { version: 1, created_at: 0 },
	current_type: 'text'
});

/**
 * A move out of the current state. `requires` present with an unsatisfied
 * entry means blocked — the same convention the issue page's `unmetFor` uses.
 */
const move = (
	all: WorkflowState[],
	name: string,
	to: string,
	requires?: ArtifactRequirementCheck[]
): AllowedTransition => {
	const toState = all.find((s) => s.name === to);
	if (!toState) throw new Error(`no state ${to}`);
	return { transition_id: `t:${name}`, name, to_state: toState, ...(requires ? { requires } : {}) };
};

// Matches the issue page's `unmetFor`: undefined `requires` (an optimistic
// move in flight) counts as enabled.
const isBlocked = (t: AllowedTransition) =>
	(t.requires ?? []).some((r) => r.status !== 'satisfied');

const ENGINEERING = states([
	['Backlog', 'backlog'],
	['Research', 'active'],
	['Design', 'active'],
	['Implementation', 'active'],
	['Automated Review', 'active'],
	['Human Review', 'awaiting_human'],
	['Needs Clarification', 'awaiting_human'],
	['Merging', 'active'],
	['Closed', 'done'],
	['Canceled', 'done']
]);

const STANDARD = states([
	['Open', 'active'],
	['Human Review', 'awaiting_human'],
	['Closed', 'done']
]);

const SCOUT = states([
	['Backlog', 'backlog'],
	['Scouting', 'active'],
	['Filed', 'done'],
	['Nothing found', 'done'],
	['Abandoned', 'done']
]);

const PRODUCT_DIRECTION = states([
	['Proposed', 'backlog'],
	['Drafting', 'active'],
	['PRD Review', 'awaiting_human'],
	['Planning', 'active'],
	['Delivering', 'active'],
	['Shipped', 'done'],
	['Dropped', 'done']
]);

const IDEA = states([
	['New', 'backlog'],
	['Proposed', 'awaiting_human'],
	['Reworking', 'active'],
	['Approved', 'awaiting_human'],
	['Visited', 'done'],
	['Passed', 'done']
]);

const WORKSTREAM = states([
	['Defined', 'backlog'],
	['Retired', 'done']
]);

const DISTILLATION = states([
	['Backlog', 'backlog'],
	['Distilling', 'active'],
	['Proposal Review', 'awaiting_human'],
	['Applying', 'active'],
	['Closed', 'done'],
	['Canceled', 'done']
]);

const at = (all: WorkflowState[], name: string): WorkflowState => {
	const s = all.find((x) => x.name === name);
	if (!s) throw new Error(`no state ${name}`);
	return s;
};

describe('escapeStateId', () => {
	it('names the last state of a workflow with more than one done state', () => {
		expect(escapeStateId(ENGINEERING)).toBe('s:Canceled');
		expect(escapeStateId(SCOUT)).toBe('s:Abandoned');
		expect(escapeStateId(PRODUCT_DIRECTION)).toBe('s:Dropped');
		expect(escapeStateId(IDEA)).toBe('s:Passed');
	});

	it('is null when the single done state is the payoff', () => {
		// Standard's Closed is reached by both Approve and Abandon: category
		// cannot tell them apart, so nothing is treated as an escape lane.
		expect(escapeStateId(STANDARD)).toBeNull();
		expect(escapeStateId(WORKSTREAM)).toBeNull();
	});

	it('is null when the last state is not done', () => {
		expect(
			escapeStateId(
				states([
					['Closed', 'done'],
					['Canceled', 'done'],
					['Open', 'active']
				])
			)
		).toBeNull();
	});
});

describe('directionOf', () => {
	const escape = escapeStateId(ENGINEERING);
	const design = at(ENGINEERING, 'Design');

	it('classifies later, earlier, self and escape targets', () => {
		expect(directionOf(move(ENGINEERING, 'a', 'Implementation'), design, escape)).toBe('forward');
		expect(directionOf(move(ENGINEERING, 'b', 'Research'), design, escape)).toBe('backward');
		expect(directionOf(move(ENGINEERING, 'c', 'Design'), design, escape)).toBe('backward');
		expect(directionOf(move(ENGINEERING, 'd', 'Canceled'), design, escape)).toBe('escape');
		// Closed is later and not the escape lane: a payoff, not an escape.
		expect(directionOf(move(ENGINEERING, 'e', 'Closed'), design, escape)).toBe('forward');
	});
});

interface Case {
	name: string;
	states: WorkflowState[];
	current: string;
	transitions: (all: WorkflowState[]) => AllowedTransition[];
	ordered: string[];
	lead: string | null;
	primary: string | null;
}

const cases: Case[] = [
	{
		name: 'Engineering/Research, findings not yet attached',
		states: ENGINEERING,
		current: 'Research',
		transitions: (s) => [
			move(s, 'Research complete', 'Design', [missing('research-findings')]),
			move(s, 'Ask for clarification', 'Needs Clarification', [missing('clarification-request')]),
			move(s, 'Cancel', 'Canceled')
		],
		ordered: ['Research complete', 'Ask for clarification', 'Cancel'],
		lead: 'Research complete',
		primary: null
	},
	{
		name: 'Engineering/Research with research-findings attached',
		states: ENGINEERING,
		current: 'Research',
		transitions: (s) => [
			move(s, 'Research complete', 'Design', [satisfied('research-findings')]),
			move(s, 'Ask for clarification', 'Needs Clarification', [missing('clarification-request')]),
			move(s, 'Cancel', 'Canceled')
		],
		ordered: ['Research complete', 'Ask for clarification', 'Cancel'],
		lead: 'Research complete',
		primary: 'Research complete'
	},
	{
		name: 'Engineering/Research with only clarification-request attached: no fall-through',
		states: ENGINEERING,
		current: 'Research',
		transitions: (s) => [
			move(s, 'Research complete', 'Design', [missing('research-findings')]),
			move(s, 'Ask for clarification', 'Needs Clarification', [satisfied('clarification-request')]),
			move(s, 'Cancel', 'Canceled')
		],
		// Ask for clarification is enabled and forward, so it sorts first — but
		// it is a side-step, and the lead does not fall through to it.
		ordered: ['Ask for clarification', 'Research complete', 'Cancel'],
		lead: 'Research complete',
		primary: null
	},
	{
		name: 'Engineering/Design',
		states: ENGINEERING,
		current: 'Design',
		transitions: (s) => [
			move(s, 'Design complete', 'Implementation', [missing('design-doc')]),
			move(s, 'Ask for clarification', 'Needs Clarification', [missing('clarification-request')]),
			move(s, 'Needs more research', 'Research'),
			move(s, 'Cancel', 'Canceled')
		],
		ordered: ['Design complete', 'Ask for clarification', 'Needs more research', 'Cancel'],
		lead: 'Design complete',
		primary: null
	},
	{
		name: 'Engineering/Design, optimistic move in flight (no requires at all)',
		states: ENGINEERING,
		current: 'Design',
		transitions: (s) => [
			move(s, 'Design complete', 'Implementation'),
			move(s, 'Ask for clarification', 'Needs Clarification'),
			move(s, 'Needs more research', 'Research'),
			move(s, 'Cancel', 'Canceled')
		],
		ordered: ['Design complete', 'Ask for clarification', 'Needs more research', 'Cancel'],
		lead: 'Design complete',
		primary: 'Design complete'
	},
	{
		name: 'Engineering/Human Review',
		states: ENGINEERING,
		current: 'Human Review',
		transitions: (s) => [
			move(s, 'Approve', 'Merging'),
			move(s, 'Send back to implementation', 'Implementation'),
			move(s, 'Send back to design', 'Design'),
			move(s, 'Send back to research', 'Research'),
			move(s, 'Cancel', 'Canceled')
		],
		ordered: [
			'Approve',
			'Send back to implementation',
			'Send back to design',
			'Send back to research',
			'Cancel'
		],
		lead: 'Approve',
		primary: 'Approve'
	},
	{
		name: 'Engineering/Merging: a done target is still the payoff',
		states: ENGINEERING,
		current: 'Merging',
		transitions: (s) => [
			move(s, 'Merged', 'Closed'),
			move(s, 'Send back to implementation', 'Implementation'),
			move(s, 'Cancel', 'Canceled')
		],
		ordered: ['Merged', 'Send back to implementation', 'Cancel'],
		lead: 'Merged',
		primary: 'Merged'
	},
	{
		name: 'Engineering/Needs Clarification: every exit is a step back',
		states: ENGINEERING,
		current: 'Needs Clarification',
		transitions: (s) => [
			move(s, 'Clarified (research)', 'Research'),
			move(s, 'Clarified (design)', 'Design'),
			move(s, 'Clarified (implementation)', 'Implementation'),
			move(s, 'Cancel', 'Canceled')
		],
		ordered: ['Clarified (research)', 'Clarified (design)', 'Clarified (implementation)', 'Cancel'],
		// Nothing is the expected next step, so nothing is filled — where today
		// Cancel was.
		lead: null,
		primary: null
	},
	{
		name: 'Standard/Human Review: one done state, so Approve keeps its fill',
		states: STANDARD,
		current: 'Human Review',
		transitions: (s) => [move(s, 'Approve', 'Closed'), move(s, 'Send back', 'Open')],
		ordered: ['Approve', 'Send back'],
		lead: 'Approve',
		primary: 'Approve'
	},
	{
		name: 'Standard/Open',
		states: STANDARD,
		current: 'Open',
		transitions: (s) => [
			move(s, 'Submit for review', 'Human Review'),
			move(s, 'Abandon', 'Closed')
		],
		ordered: ['Submit for review', 'Abandon'],
		lead: 'Submit for review',
		primary: 'Submit for review'
	},
	{
		name: 'Scout/Scouting',
		states: SCOUT,
		current: 'Scouting',
		transitions: (s) => [
			move(s, 'Filed', 'Filed', [missing('scout-report')]),
			move(s, 'Nothing found', 'Nothing found', [missing('scout-report')]),
			move(s, 'Abandon run', 'Abandoned')
		],
		ordered: ['Filed', 'Nothing found', 'Abandon run'],
		lead: 'Filed',
		primary: null
	},
	{
		name: 'Product Direction/PRD Review',
		states: PRODUCT_DIRECTION,
		current: 'PRD Review',
		transitions: (s) => [
			move(s, 'Approve', 'Planning'),
			move(s, 'Rework', 'Drafting'),
			move(s, 'Drop', 'Dropped')
		],
		ordered: ['Approve', 'Rework', 'Drop'],
		lead: 'Approve',
		primary: 'Approve'
	},
	{
		name: 'Product Direction/Dropped: a lone backward move leads',
		states: PRODUCT_DIRECTION,
		current: 'Dropped',
		transitions: (s) => [move(s, 'Reopen', 'Drafting')],
		ordered: ['Reopen'],
		lead: 'Reopen',
		primary: 'Reopen'
	},
	{
		name: 'Idea/Reworking: a lone backward move, gated',
		states: IDEA,
		current: 'Reworking',
		transitions: (s) => [move(s, 'Propose', 'Proposed', [missing('idea-brief')])],
		ordered: ['Propose'],
		lead: 'Propose',
		primary: null
	},
	{
		name: 'Workstream/Defined: lone move into the single done state',
		states: WORKSTREAM,
		current: 'Defined',
		transitions: (s) => [move(s, 'Retire', 'Retired')],
		ordered: ['Retire'],
		lead: 'Retire',
		primary: 'Retire'
	},
	{
		name: 'Distillation/Proposal Review',
		states: DISTILLATION,
		current: 'Proposal Review',
		transitions: (s) => [
			move(s, 'Approve proposal', 'Applying'),
			move(s, 'Close without applying', 'Closed'),
			move(s, 'Send back', 'Distilling')
		],
		ordered: ['Approve proposal', 'Close without applying', 'Send back'],
		lead: 'Approve proposal',
		primary: 'Approve proposal'
	}
];

describe('planTransitions', () => {
	for (const c of cases) {
		it(c.name, () => {
			const transitions = c.transitions(c.states);
			const plan = planTransitions(transitions, at(c.states, c.current), c.states, isBlocked);
			expect(plan.ordered.map((t) => t.name)).toEqual(c.ordered);
			expect(plan.leadId).toBe(c.lead === null ? null : `t:${c.lead}`);
			expect(plan.primaryId).toBe(c.primary === null ? null : `t:${c.primary}`);
		});
	}

	it('keeps every transition exactly once', () => {
		for (const c of cases) {
			const transitions = c.transitions(c.states);
			const plan = planTransitions(transitions, at(c.states, c.current), c.states, isBlocked);
			expect([...plan.ordered].map((t) => t.transition_id).sort()).toEqual(
				transitions.map((t) => t.transition_id).sort()
			);
		}
	});

	it('has no transitions at all in a terminal state', () => {
		const plan = planTransitions([], at(ENGINEERING, 'Closed'), ENGINEERING, isBlocked);
		expect(plan).toEqual({ ordered: [], leadId: null, primaryId: null });
	});
});

describe('fitDirect', () => {
	// The phone bar at 390 px: inner width 366, "more" 53, gap 8.
	const base = { moreWidth: 53, barWidth: 366, stateMin: 72, gap: 8, max: 2 };

	it('fits one lead button', () => {
		expect(fitDirect({ ...base, widths: [153, 90], stateWidth: 95 })).toBe(2);
		expect(fitDirect({ ...base, widths: [153, 90, 40], stateWidth: 95 })).toBe(1);
	});

	it('gives the first slot the chip’s width down to the floor', () => {
		// Engineering/Implementation as measured: chip 137, lead 217. Naturally
		// there are 221 px for a slot that needs 278; at the 72 px floor, 286.
		expect(fitDirect({ ...base, widths: [217, 90], stateWidth: 137 })).toBe(1);
		expect(fitDirect({ ...base, widths: [217, 90], stateWidth: 137, stateMin: 137 })).toBe(0);
	});

	it('never yields the chip for a second button', () => {
		expect(fitDirect({ ...base, widths: [90, 90, 40], stateWidth: 230 })).toBe(1);
		expect(fitDirect({ ...base, widths: [90, 90, 40], stateWidth: 72 })).toBe(2);
	});

	it('caps at max', () => {
		expect(fitDirect({ ...base, widths: [40, 40, 40], stateWidth: 72 })).toBe(2);
		expect(fitDirect({ ...base, widths: [40, 40, 40], stateWidth: 72, max: 3 })).toBe(3);
	});

	it('does not reserve the more button when nothing would be hidden', () => {
		// 290 px lead, chip at the 72 px floor: 366 - 72 - 8 = 286 available, so
		// it only fits when no "more" button is needed alongside it.
		expect(fitDirect({ ...base, widths: [280], stateWidth: 72 })).toBe(1);
		expect(fitDirect({ ...base, widths: [280, 40], stateWidth: 72 })).toBe(0);
	});

	it('shows nothing before measurement', () => {
		expect(fitDirect({ ...base, widths: [], stateWidth: 95 })).toBe(0);
	});
});
