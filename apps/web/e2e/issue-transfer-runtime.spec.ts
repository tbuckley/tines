import type {
	AgentRun,
	IssueTransferPreview,
	IssueTransferResult,
	ListResponse
} from '@tines/shared';
import { expect, test } from './fixtures';
import { TRANSFER_RUNTIME } from './constants.mjs';
import { d1, sqlLiteral } from './d1';
import { apiClient, body } from './helpers';

const issueRows = (issueId: string) =>
	d1(`SELECT * FROM issue WHERE id = ${sqlLiteral(issueId)} ORDER BY id`);
const addressRows = (issueId: string) =>
	d1(
		`SELECT * FROM issue_address WHERE issue_id = ${sqlLiteral(issueId)} ORDER BY project_id, number`
	);
const transferEvents = (issueId: string) =>
	d1(
		`SELECT * FROM event WHERE issue_id = ${sqlLiteral(issueId)} AND type = 'issue.transferred' ORDER BY created_at, id`
	);

test.describe.serial('project transfer real worker runtime', () => {
	test('same-project no-op is write-free, including preview', async ({ request }) => {
		const api = apiClient(request, TRANSFER_RUNTIME.apiKey);
		const before = {
			issue: issueRows(TRANSFER_RUNTIME.noopIssueId),
			addresses: addressRows(TRANSFER_RUNTIME.noopIssueId),
			events: transferEvents(TRANSFER_RUNTIME.noopIssueId)
		};
		const preview = await body<IssueTransferPreview>(
			await api.get(
				`/api/v1/issues/${TRANSFER_RUNTIME.noopIssueId}/transfer?project=${TRANSFER_RUNTIME.sourceId}`
			)
		);
		expect(preview.noop).toBe(true);
		expect(preview.preview_token).toEqual(expect.any(String));
		const result = await body<IssueTransferResult>(
			await api.post(`/api/v1/issues/${TRANSFER_RUNTIME.noopIssueId}/transfer`, {
				project_id: TRANSFER_RUNTIME.sourceId,
				preview_token: preview.preview_token
			})
		);
		expect(result).toMatchObject({ status: 'noop', event_id: null });
		expect(issueRows(TRANSFER_RUNTIME.noopIssueId)).toEqual(before.issue);
		expect(addressRows(TRANSFER_RUNTIME.noopIssueId)).toEqual(before.addresses);
		expect(transferEvents(TRANSFER_RUNTIME.noopIssueId)).toEqual(before.events);
	});

	test('a successful transfer queues and claims through destination routing', async ({
		request
	}) => {
		const api = apiClient(request, TRANSFER_RUNTIME.apiKey);
		d1(
			`UPDATE runner SET last_seen_at = ${Date.now()} WHERE id = ${sqlLiteral(TRANSFER_RUNTIME.runnerId)}`
		);
		const before = issueRows(TRANSFER_RUNTIME.claimIssueId)[0] as {
			project_assignment_token: string;
		};
		expect(
			d1(`SELECT id FROM agent_run WHERE issue_id = ${sqlLiteral(TRANSFER_RUNTIME.claimIssueId)}`)
		).toEqual([]);
		const preview = await body<IssueTransferPreview>(
			await api.get(
				`/api/v1/issues/${TRANSFER_RUNTIME.claimIssueId}/transfer?project=${TRANSFER_RUNTIME.destinationId}`
			)
		);
		expect(preview.routing.after).toMatchObject({ eligible: true });
		expect(preview.preview_token).toEqual(expect.any(String));
		const response = await api.post(`/api/v1/issues/${TRANSFER_RUNTIME.claimIssueId}/transfer`, {
			project_id: TRANSFER_RUNTIME.destinationId,
			preview_token: preview.preview_token
		});
		expect(response.status()).toBe(200);
		const receipt = await body<IssueTransferResult>(response);
		expect(receipt).toMatchObject({ status: 'transferred', event_id: expect.any(String) });

		await expect
			.poll(async () => {
				const runs = await body<ListResponse<AgentRun>>(
					await api.get(`/api/v1/runs?issue=${TRANSFER_RUNTIME.claimIssueId}`)
				);
				return runs.items.filter(
					(run) => run.runner_id === TRANSFER_RUNTIME.runnerId && run.status === 'assigned'
				).length;
			})
			.toBe(1);
		const issue = issueRows(TRANSFER_RUNTIME.claimIssueId)[0] as {
			project_id: string;
			project_assignment_token: string;
		};
		expect(issue.project_id).toBe(TRANSFER_RUNTIME.destinationId);
		expect(issue.project_assignment_token).not.toBe(before.project_assignment_token);
		const runs = d1<{ project_assignment_token: string; runner_id: string }>(
			`SELECT project_assignment_token, runner_id FROM agent_run WHERE issue_id = ${sqlLiteral(TRANSFER_RUNTIME.claimIssueId)}`
		);
		expect(runs).toEqual([
			{
				project_assignment_token: issue.project_assignment_token,
				runner_id: TRANSFER_RUNTIME.runnerId
			}
		]);
		expect(transferEvents(TRANSFER_RUNTIME.claimIssueId)).toEqual([
			expect.objectContaining({ id: receipt.event_id })
		]);
	});

	test.afterAll(async ({ request }) => {
		const api = apiClient(request, TRANSFER_RUNTIME.apiKey);
		d1(
			`UPDATE supervisor_settings SET enabled = 0 WHERE user_id = ${sqlLiteral(TRANSFER_RUNTIME.id)}`
		);
		const runs = await body<ListResponse<AgentRun>>(
			await api.get(`/api/v1/runs?issue=${TRANSFER_RUNTIME.claimIssueId}`)
		);
		for (const run of runs.items.filter((item) =>
			['assigned', 'launching', 'running'].includes(item.status)
		)) {
			await api.post(`/api/v1/runs/${run.id}/cancel`);
		}
		d1(`DELETE FROM routing_rule WHERE id = ${sqlLiteral(TRANSFER_RUNTIME.ruleId)}`);
		d1(`DELETE FROM agent_run WHERE issue_id = ${sqlLiteral(TRANSFER_RUNTIME.claimIssueId)}`);
		d1(`DELETE FROM runner WHERE id = ${sqlLiteral(TRANSFER_RUNTIME.runnerId)}`);
	});
});
