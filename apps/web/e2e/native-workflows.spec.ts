import type { APIRequestContext } from '@playwright/test';
import type { UpdateWorkflowRequest, WorkflowResponse } from '@tines/shared';
import { expect, test } from './fixtures';
import { ALICE } from './constants.mjs';
import { d1, sqlLiteral } from './d1';
import { apiClient, body, errorBody } from './helpers';

const RACE_HEADER = 'x-tines-e2e-workflow-race';

async function fixture(request: APIRequestContext, name: string): Promise<WorkflowResponse> {
	return body<WorkflowResponse>(
		await apiClient(request, ALICE.apiKey).post('/api/v1/workflows', {
			name,
			initial_state: 'Draft',
			states: [
				{ name: 'Draft', category: 'active', prompt: 'Draft instructions' },
				{ name: 'Review', category: 'awaiting_human', prompt: 'Review instructions' },
				{ name: 'Done', category: 'done', prompt: 'Done instructions' }
			],
			transitions: [
				{ name: 'submit', from: 'Draft', to: 'Review' },
				{ name: 'approve', from: 'Review', to: 'Done' },
				{ name: 'finish', from: 'Draft', to: 'Done' }
			]
		})
	);
}

function patch(
	request: APIRequestContext,
	workflowId: string,
	data: UpdateWorkflowRequest,
	race?: 'wait-for-competing-save' | 'release-held-save'
) {
	return request.patch(`/api/v1/workflows/${workflowId}`, {
		headers: { authorization: `Bearer ${ALICE.apiKey}`, ...(race ? { [RACE_HEADER]: race } : {}) },
		data
	});
}

function workflowRow(workflowId: string) {
	return d1<{ name: string; definition_revision: number; initial_state_id: string }>(
		`SELECT name,definition_revision,initial_state_id FROM workflow WHERE id=${sqlLiteral(workflowId)}`
	);
}

function stateRows(workflowId: string) {
	return d1<{ id: string; name: string; category: string; position: number }>(
		`SELECT id,name,category,position FROM workflow_state WHERE workflow_id=${sqlLiteral(workflowId)} ORDER BY position`
	);
}

function transitionRows(workflowId: string) {
	return d1<{ name: string; from_state: string; to_state: string; requirements: string | null }>(
		`SELECT t.name,f.name AS from_state,s.name AS to_state,t.requirements
		FROM workflow_transition t
		JOIN workflow_state f ON f.id=t.from_state_id
		JOIN workflow_state s ON s.id=t.to_state_id
		WHERE t.workflow_id=${sqlLiteral(workflowId)} ORDER BY t.name`
	);
}

/** Stage instructions attached to the workflow's states, by state name. */
function contextRows(workflowId: string) {
	return d1<{ id: string; state: string; body: string | null }>(
		`SELECT c.id,s.name AS state,c.body FROM context_item c
		JOIN workflow_state s ON s.id=c.workflow_state_id
		WHERE s.workflow_id=${sqlLiteral(workflowId)} ORDER BY s.position,c.id`
	);
}

function updatedEvents(workflowId: string) {
	return d1<{ payload: string }>(
		`SELECT payload FROM event WHERE type='workflow.updated'
		AND json_extract(payload,'$.workflow_id')=${sqlLiteral(workflowId)} ORDER BY created_at,id`
	).map((row) => JSON.parse(row.payload) as Record<string, unknown>);
}

function contextDeletedEvents(contextIds: string[]) {
	return d1<{ id: string }>(
		`SELECT id FROM event WHERE type='context.deleted'
		AND json_extract(payload,'$.context_id') IN (${contextIds.map(sqlLiteral).join(',')})`
	);
}

test.describe.serial('native D1 workflow save revision', () => {
	test('a save held before its batch is refused whole once a competing save commits', async ({
		request,
		uniqueName
	}) => {
		test.setTimeout(120_000);
		const created = await fixture(request, uniqueName('native-workflow-race'));
		expect(created.revision).toBe(1);
		const stateId = (name: string) => created.states.find((state) => state.name === name)!.id;
		const contextBefore = contextRows(created.id);
		expect(contextBefore.map((row) => row.state)).toEqual(['Draft', 'Review', 'Done']);

		// The loser read revision 1 and removes Review, forcing the sweep of its
		// stage instructions; it holds after its reads, with its batch compiled.
		const loserBody: UpdateWorkflowRequest = {
			expected_revision: 1,
			force_delete_context: true,
			states: [
				{ id: stateId('Draft'), name: 'Draft', category: 'active' },
				{ id: stateId('Done'), name: 'Done', category: 'done' }
			],
			transitions: [{ name: 'finish', from: 'Draft', to: 'Done' }]
		};
		const held = patch(request, created.id, loserBody, 'wait-for-competing-save');

		// The winner also read revision 1; it commits while the loser holds.
		const winnerName = uniqueName('native-workflow-winner');
		const winner = await patch(
			request,
			created.id,
			{
				expected_revision: 1,
				name: winnerName,
				states: [
					{ id: stateId('Draft'), name: 'Draft', category: 'active' },
					{ id: stateId('Review'), name: 'Review', category: 'awaiting_human' },
					{ name: 'QA', category: 'active', prompt: 'QA instructions' },
					{ id: stateId('Done'), name: 'Done', category: 'done' }
				],
				transitions: [
					{ name: 'submit', from: 'Draft', to: 'Review' },
					{
						name: 'approve',
						from: 'Review',
						to: 'Done',
						requires: [{ artifact: 'report', type: 'text' }]
					},
					{ name: 'finish', from: 'Draft', to: 'Done' },
					{ name: 'check', from: 'Review', to: 'QA' }
				]
			},
			'release-held-save'
		);
		const committed = await body<WorkflowResponse>(winner);
		expect(winner.status()).toBe(200);
		expect(committed.revision).toBe(2);

		const loser = await held;
		expect(loser.status()).toBe(409);
		expect((await errorBody(loser)).error).toMatchObject({
			code: 'workflow_conflict',
			details: {
				committed: false,
				expected_revision: 1,
				current_revision: 2,
				remedy: 'reload_workflow'
			}
		});

		// Revision advanced by exactly one, with exactly one event: the winner's.
		expect(workflowRow(created.id)).toEqual([
			{ name: winnerName, definition_revision: 2, initial_state_id: stateId('Draft') }
		]);
		const events = updatedEvents(created.id);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			base_revision: 1,
			revision: 2,
			states_added: ['QA'],
			transitions_added: 1,
			transition_requirements_changed: true
		});
		expect(events[0].states_removed).toBeUndefined();

		// Rows equal the winner's definition; nothing of the loser's landed.
		expect(
			stateRows(created.id).map(({ name, category, position }) => [name, category, position])
		).toEqual([
			['Draft', 'active', 0],
			['Review', 'awaiting_human', 1],
			['QA', 'active', 2],
			['Done', 'done', 3]
		]);
		expect(
			stateRows(created.id)
				.filter((state) => state.name !== 'QA')
				.map((state) => state.id)
		).toEqual([stateId('Draft'), stateId('Review'), stateId('Done')]);
		expect(
			transitionRows(created.id).map((row) => ({
				...row,
				requirements: row.requirements ? JSON.parse(row.requirements) : null
			}))
		).toEqual([
			{
				name: 'approve',
				from_state: 'Review',
				to_state: 'Done',
				requirements: [{ artifact: 'report', type: 'text' }]
			},
			{ name: 'check', from_state: 'Review', to_state: 'QA', requirements: null },
			{ name: 'finish', from_state: 'Draft', to_state: 'Done', requirements: null },
			{ name: 'submit', from_state: 'Draft', to_state: 'Review', requirements: null }
		]);

		// The loser's forced sweep deleted nothing and recorded no deletion.
		const contextAfter = contextRows(created.id);
		expect(contextAfter.filter((row) => row.state !== 'QA')).toEqual(contextBefore);
		expect(contextAfter.filter((row) => row.state === 'QA')).toHaveLength(1);
		expect(contextDeletedEvents(contextBefore.map((row) => row.id))).toEqual([]);

		const read = await body<WorkflowResponse>(
			await apiClient(request, ALICE.apiKey).get(`/api/v1/workflows/${created.id}`)
		);
		expect(read.revision).toBe(2);
		expect(read.states.map((state) => state.name)).toEqual(['Draft', 'Review', 'QA', 'Done']);

		// Control: the same body against the revision it now names commits, so
		// the refusal above was the revision check and not the request.
		const retried = await body<WorkflowResponse>(
			await patch(request, created.id, { ...loserBody, expected_revision: 2 })
		);
		expect(retried.revision).toBe(3);
		expect(retried.deleted_context).toHaveLength(2);
		expect(contextRows(created.id).map((row) => row.state)).toEqual(['Draft', 'Done']);
		expect(updatedEvents(created.id)).toHaveLength(2);
	});

	test('unheld concurrent saves leave one event and one revision step per success', async ({
		request,
		uniqueName
	}) => {
		test.setTimeout(120_000);
		const created = await fixture(request, uniqueName('native-workflow-concurrent'));
		const responses = await Promise.all(
			[0, 1, 2, 3].map((n) => patch(request, created.id, { description: `concurrent ${n}` }))
		);
		const statuses = responses.map((response) => response.status());
		expect(statuses.every((status) => status === 200 || status === 409)).toBe(true);
		for (const refused of responses.filter((response) => response.status() === 409)) {
			expect((await errorBody(refused)).error.code).toBe('workflow_conflict');
		}
		const succeeded = statuses.filter((status) => status === 200).length;
		expect(succeeded).toBeGreaterThanOrEqual(1);
		expect(workflowRow(created.id)[0].definition_revision).toBe(1 + succeeded);
		expect(updatedEvents(created.id)).toHaveLength(succeeded);
		// Description-only saves write no state or transition row.
		expect(stateRows(created.id).map((state) => state.id)).toEqual(
			created.states.map((state) => state.id)
		);
		expect(transitionRows(created.id)).toHaveLength(3);
	});
});
