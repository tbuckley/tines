import type { ContextItem, Workflow } from '@tines/shared';
import { describe, expect, it } from 'vitest';
import { groupContextByWorkflow } from './context-groups';

function item(name: string, scope: Partial<ContextItem['scope']> = {}): ContextItem {
	return {
		id: `ctx_${name}`,
		kind: 'prompt',
		name,
		description: '',
		position: 0,
		version: 1,
		created_at: 0,
		updated_at: 0,
		scope: {
			project_id: 'prj_1',
			project_name: 'Tines',
			workflow_state_id: null,
			workflow_state_name: null,
			label_id: null,
			label_name: null,
			label_color: null,
			workflow_id: null,
			workflow_name: null,
			issue_id: null,
			issue_ref: null,
			label: 'project Tines',
			...scope
		}
	};
}

/** A state-scoped item in `<workflow>` / `<state>`. */
const stateItem = (name: string, workflow: string, state: string) =>
	item(name, {
		workflow_id: `wf_${workflow}`,
		workflow_name: workflow,
		workflow_state_id: `st_${state}`,
		workflow_state_name: state,
		label: `state ${workflow} / ${state}`
	});

const workflows: Pick<Workflow, 'id' | 'states'>[] = [
	{
		id: 'wf_Engineering',
		states: [
			{ id: 'st_Research', name: 'Research', category: 'active', position: 0 },
			{ id: 'st_Design', name: 'Design', category: 'active', position: 1 },
			{ id: 'st_Done', name: 'Done', category: 'done', position: 2 }
		]
	},
	{
		id: 'wf_Docs',
		states: [{ id: 'st_Draft', name: 'Draft', category: 'active', position: 0 }]
	}
];

describe('groupContextByWorkflow', () => {
	it('ignores project-only items', () => {
		const groups = groupContextByWorkflow(
			[item('project-context'), item('tines-github'), stateItem('journal', 'Docs', 'Draft')],
			workflows
		);
		expect(groups).toHaveLength(1);
		expect(groups[0].states[0].items.map((i) => i.name)).toEqual(['journal']);
		expect(groups[0].itemCount).toBe(1);
	});

	it('makes interleaved workflows contiguous and alphabetical, with item counts', () => {
		// The server returns context `updated_at DESC`, which interleaves workflows.
		const groups = groupContextByWorkflow(
			[
				stateItem('eng-design', 'Engineering', 'Design'),
				stateItem('docs-draft', 'Docs', 'Draft'),
				stateItem('eng-research', 'Engineering', 'Research')
			],
			workflows
		);
		expect(groups.map((g) => [g.workflowName, g.states.length, g.itemCount])).toEqual([
			['Docs', 1, 1],
			['Engineering', 2, 2]
		]);
	});

	it('orders states by workflow position and items within a state by name', () => {
		const groups = groupContextByWorkflow(
			[
				stateItem('a-done', 'Engineering', 'Done'),
				stateItem('z-research', 'Engineering', 'Research'),
				stateItem('a-research', 'Engineering', 'Research')
			],
			workflows
		);
		expect(groups[0].states.map((s) => s.state.name)).toEqual(['Research', 'Done']);
		expect(groups[0].states[0].items.map((i) => i.name)).toEqual(['a-research', 'z-research']);
		expect(groups[0].states.map((s) => s.state.category)).toEqual(['active', 'done']);
	});

	it('still groups an item whose workflow is unknown, sorting its states last', () => {
		const groups = groupContextByWorkflow(
			[
				stateItem('ghost', 'Engineering', 'Deleted'),
				stateItem('eng-design', 'Engineering', 'Design')
			],
			// The workflow is present but no longer lists `st_Deleted`.
			workflows
		);
		expect(groups[0].states.map((s) => s.state.name)).toEqual(['Design', 'Deleted']);
		expect(groups[0].states[1].state.category).toBe('active');

		const orphan = groupContextByWorkflow([stateItem('orphan', 'Gone', 'Somewhere')], workflows);
		expect(orphan).toEqual([
			expect.objectContaining({ workflowId: 'wf_Gone', workflowName: 'Gone', itemCount: 1 })
		]);
	});

	it('is order-independent', () => {
		const items = [
			stateItem('eng-design', 'Engineering', 'Design'),
			stateItem('docs-draft', 'Docs', 'Draft'),
			stateItem('eng-research', 'Engineering', 'Research'),
			stateItem('eng-research-2', 'Engineering', 'Research'),
			item('project-context')
		];
		const shape = (items: ContextItem[]) =>
			groupContextByWorkflow(items, workflows).map((g) => ({
				workflow: g.workflowName,
				states: g.states.map((s) => [s.state.name, s.items.map((i) => i.name)])
			}));
		expect(shape([...items].reverse())).toEqual(shape(items));
		expect(shape([items[2], items[4], items[0], items[3], items[1]])).toEqual(shape(items));
	});
});
