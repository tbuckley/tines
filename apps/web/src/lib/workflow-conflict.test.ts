import type { Workflow, WorkflowState, WorkflowTransition } from '@tines/shared';
import { describe, expect, it } from 'vitest';
import {
	deletedStateLine,
	statesDeletedInLatest,
	summarizeWorkflowChanges
} from './workflow-conflict';

const state = (
	id: string,
	name: string,
	category: WorkflowState['category'],
	position: number
): WorkflowState => ({ id, name, category, position, inherits_from: null });

const transition = (
	id: string,
	name: string,
	from: string,
	to: string,
	requires?: WorkflowTransition['requires']
): WorkflowTransition => ({
	id,
	name,
	from_state_id: from,
	to_state_id: to,
	...(requires ? { requires } : {})
});

function workflow(overrides: Partial<Workflow> = {}): Workflow {
	return {
		id: 'wf_a',
		name: 'Engineering',
		description: 'How engineering work moves.',
		is_system: false,
		initial_state_id: 'st_open',
		states: [
			state('st_open', 'Open', 'active', 0),
			state('st_review', 'Review', 'awaiting_human', 1),
			state('st_done', 'Done', 'done', 2)
		],
		transitions: [
			transition('tr_1', 'Submit', 'st_open', 'st_review'),
			transition('tr_2', 'Approve', 'st_review', 'st_done')
		],
		issue_count: 0,
		revision: 1,
		created_at: 1,
		updated_at: 1,
		...overrides
	};
}

describe('summarizeWorkflowChanges', () => {
	it('reports nothing for an identical definition, even at a later revision', () => {
		expect(summarizeWorkflowChanges(workflow(), workflow({ revision: 2, updated_at: 9 }))).toEqual(
			[]
		);
	});

	it('ignores reissued transition ids', () => {
		const latest = workflow({
			transitions: [
				transition('tr_8', 'Submit', 'st_open', 'st_review'),
				transition('tr_9', 'Approve', 'st_review', 'st_done')
			]
		});
		expect(summarizeWorkflowChanges(workflow(), latest)).toEqual([]);
	});

	it('names a rename, a description change and a new initial state', () => {
		const latest = workflow({
			name: 'Product',
			description: 'Changed.',
			initial_state_id: 'st_review'
		});
		expect(summarizeWorkflowChanges(workflow(), latest)).toEqual([
			'The workflow was renamed from “Engineering” to “Product”.',
			'The description was changed.',
			'The initial state is now “Review”.'
		]);
		expect(summarizeWorkflowChanges(workflow(), workflow({ description: '' }))).toEqual([
			'The description was cleared.'
		]);
	});

	it('names states added, removed, renamed and recategorised', () => {
		const latest = workflow({
			states: [
				state('st_open', 'Triage', 'backlog', 0),
				state('st_done', 'Done', 'done', 1),
				state('st_new', 'Canceled', 'done', 2)
			],
			transitions: []
		});
		expect(summarizeWorkflowChanges(workflow({ transitions: [] }), latest)).toEqual([
			'State “Open” was renamed to “Triage”.',
			'State “Triage” changed category from active to backlog.',
			'State “Canceled” was added.',
			'State “Review” was removed.'
		]);
	});

	it('reports a reorder of the states both versions keep, not a shift caused by an addition', () => {
		const reordered = workflow({
			states: [
				state('st_review', 'Review', 'awaiting_human', 0),
				state('st_open', 'Open', 'active', 1),
				state('st_done', 'Done', 'done', 2)
			]
		});
		expect(summarizeWorkflowChanges(workflow(), reordered)).toEqual([
			'States were reordered: Review, Open, Done.'
		]);

		const inserted = workflow({
			states: [
				state('st_open', 'Open', 'active', 0),
				state('st_new', 'Design', 'active', 1),
				state('st_review', 'Review', 'awaiting_human', 2),
				state('st_done', 'Done', 'done', 3)
			]
		});
		expect(summarizeWorkflowChanges(workflow(), inserted)).toEqual(['State “Design” was added.']);
	});

	it('names actions added, removed and retargeted', () => {
		const latest = workflow({
			transitions: [
				transition('tr_3', 'Submit', 'st_open', 'st_done'),
				transition('tr_4', 'Send back', 'st_review', 'st_open', [
					{ artifact: 'review-notes', type: 'text' }
				])
			]
		});
		expect(summarizeWorkflowChanges(workflow(), latest)).toEqual([
			'Action “Submit” from “Open” now leads to “Done” instead of “Review”.',
			'Action “Send back” (Review → Open) was added, requiring review-notes (text).',
			'Action “Approve” (Review → Done) was removed.'
		]);
	});

	it('names a gate change per action', () => {
		const gated = workflow({
			transitions: [
				transition('tr_1', 'Submit', 'st_open', 'st_review'),
				transition('tr_2', 'Approve', 'st_review', 'st_done', [
					{ artifact: 'sign-off', type: 'text', content_type: 'text/markdown' }
				])
			]
		});
		expect(summarizeWorkflowChanges(workflow(), gated)).toEqual([
			'Action “Approve” (Review → Done) now requires sign-off (text, text/markdown) (was nothing).'
		]);
		expect(summarizeWorkflowChanges(gated, workflow())).toEqual([
			'Action “Approve” (Review → Done) now requires nothing (was sign-off (text, text/markdown)).'
		]);
	});

	it('labels an action on a removed state with the name it had', () => {
		const latest = workflow({
			states: [state('st_open', 'Open', 'active', 0), state('st_done', 'Done', 'done', 1)],
			transitions: []
		});
		expect(summarizeWorkflowChanges(workflow(), latest)).toEqual([
			'State “Review” was removed.',
			'Action “Submit” (Open → Review) was removed.',
			'Action “Approve” (Review → Done) was removed.'
		]);
	});
});

describe('statesDeletedInLatest', () => {
	it('returns existing draft states the latest version no longer has, and no new ones', () => {
		const latest = workflow({
			states: [state('st_open', 'Open', 'active', 0), state('st_done', 'Done', 'done', 1)]
		});
		const draft = [
			{ id: 'st_open', name: 'Open' },
			{ id: 'st_review', name: 'Review' },
			{ name: 'Brand new' }
		];
		expect(statesDeletedInLatest(draft, latest)).toEqual([{ id: 'st_review', name: 'Review' }]);
		expect(deletedStateLine('Review')).toBe(
			'“Review” was deleted in the latest version; saving your version re-creates it as a new state without its stage instructions.'
		);
	});
});
