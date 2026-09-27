import type { APIRequestContext } from '@playwright/test';
import type { IssueDetail, Project, RunnerTokenResponse } from '@tines/shared';
import { expect, test } from './fixtures';
import { ALICE, BASE_URL } from './constants.mjs';
import { d1, sqlLiteral } from './d1';
import { apiClient, body, fireSweep, signedSessionCookie } from './helpers';

// Native-D1 races on shared-project launch material (Tines/752): guidance
// changes between building the material and minting the run key must never
// launch a run on stale material. `x-tines-e2e-bundle-race` fires the change
// inside the poll, after the material is built and before the guarded mint.

const sessionHeaders = {
	cookie: `better-auth.session_token=${signedSessionCookie(ALICE.sessionToken)}`,
	origin: BASE_URL
};

type Delivered = {
	assignments: { run: { id: string }; prompt: string; shared_bundle?: { digest: string } }[];
};

async function sharedRunner(request: APIRequestContext, name: string) {
	const key = apiClient(request, ALICE.apiKey);
	const project = await body<Project>(await key.post('/api/v1/projects', { name }));
	d1(
		`UPDATE project SET shared_at = ${Date.now()}, sharing_revision = 1 WHERE id = ${sqlLiteral(project.id)}`
	);
	const registered = await body<RunnerTokenResponse>(
		await key.post('/api/v1/runners/register', {
			name: `${name}-runner`,
			harness: 'custom',
			command: 'true'
		})
	);
	const runner = registered.runner;
	const rule = await body<{ id: string }>(
		await key.post('/api/v1/routing-rules', {
			project_id: project.id,
			targets: [{ runner_id: runner.id }]
		})
	);
	const poll = (headers: Record<string, string> = {}) =>
		request.post(`/api/v1/runners/${runner.id}/poll`, {
			headers: { authorization: `Bearer ${registered.runner_token}`, ...headers },
			data: {
				instance_id: `bundle_${runner.id}`,
				owned_runs: [],
				max_concurrent: 1,
				concurrency_control: { version: 1, allow_remote: false, ceiling: 1 }
			}
		});
	expect((await poll()).ok()).toBe(true);
	expect((await key.put('/api/v1/supervisor/settings', { enabled: true })).ok()).toBe(true);
	const assignedIssue = async (title: string) => {
		const issue = await body<IssueDetail>(
			await request.post(`/api/v1/projects/${project.id}/issues`, {
				headers: sessionHeaders,
				data: { title }
			})
		);
		await fireSweep(request);
		const run = d1<{ id: string; status: string }>(
			`SELECT id,status FROM agent_run WHERE issue_id = ${sqlLiteral(issue.id)}`
		)[0];
		expect(run?.status).toBe('assigned');
		return { issue, run };
	};
	const cleanup = async () => {
		// Delivered runs never start here; end them so they free the owner's slots.
		d1(`UPDATE agent_run SET status = 'canceled', ended_at = ${Date.now()}
			WHERE ended_at IS NULL AND issue_id IN
			(SELECT id FROM issue WHERE project_id = ${sqlLiteral(project.id)})`);
		await key.put('/api/v1/supervisor/settings', { enabled: false });
		await key.delete(`/api/v1/routing-rules/${rule.id}`);
		await key.delete(`/api/v1/runners/${runner.id}`);
	};
	return { key, project, poll, assignedIssue, cleanup };
}

const keyCount = (runId: string) =>
	d1<{ n: number }>(
		`SELECT count(*) AS n FROM api_key WHERE agent_run_id = ${sqlLiteral(runId)}`
	)[0].n;

test.describe.serial('native D1 shared launch material', () => {
	test('control: an unraced shared run launches with its bundle', async ({
		request,
		uniqueName
	}) => {
		const f = await sharedRunner(request, uniqueName('bundle-control'));
		try {
			const { run } = await f.assignedIssue('control');
			const delivered = await body<Delivered>(await f.poll());
			expect(delivered.assignments).toHaveLength(1);
			expect(delivered.assignments[0].run.id).toBe(run.id);
			expect(delivered.assignments[0].shared_bundle?.digest).toMatch(/^[0-9a-f]{64}$/);
			expect(keyCount(run.id)).toBe(1);
		} finally {
			await f.cleanup();
		}
	});

	for (const action of ['insert', 'edit', 'delete', 'rescope'] as const) {
		test(`${action} once between material and mint: rebuilt, then launched`, async ({
			request,
			uniqueName
		}) => {
			const f = await sharedRunner(request, uniqueName(`bundle-${action}-once`));
			try {
				const item = await body<{ id: string }>(
					await f.key.post('/api/v1/context', {
						kind: 'prompt',
						name: uniqueName(`${action}-guidance`),
						body: 'Original guidance.',
						project_id: f.project.id
					})
				);
				const { run } = await f.assignedIssue(`${action} once`);
				const delivered = await body<Delivered>(
					await f.poll({
						'x-tines-e2e-bundle-race': `${action}-once`,
						'x-tines-e2e-bundle-race-item': item.id
					})
				);
				expect(delivered.assignments).toHaveLength(1);
				const prompt = delivered.assignments[0].prompt;
				// The delivered material is the rebuilt one, never the stale first build.
				if (action === 'insert') expect(prompt).toContain('Raced guidance.');
				if (action === 'edit') expect(prompt).toContain('- raced ');
				if (action === 'delete' || action === 'rescope')
					expect(prompt).not.toContain('Original guidance.');
				expect(keyCount(run.id)).toBe(1);
				expect(
					d1(`SELECT 1 FROM issue_guidance_block WHERE issue_id = (SELECT issue_id FROM agent_run
						WHERE id = ${sqlLiteral(run.id)})`)
				).toHaveLength(0);
			} finally {
				await f.cleanup();
			}
		});
	}

	test('churn on every attempt: released without a key or strike, and held back', async ({
		request,
		uniqueName
	}) => {
		const f = await sharedRunner(request, uniqueName('bundle-churn'));
		try {
			const { issue, run } = await f.assignedIssue('churn');
			const delivered = await body<Delivered>(
				await f.poll({ 'x-tines-e2e-bundle-race': 'insert-always' })
			);
			expect(delivered.assignments).toEqual([]);
			const ended = d1<{ status: string; error: string }>(
				`SELECT status,error FROM agent_run WHERE id = ${sqlLiteral(run.id)}`
			)[0];
			expect(ended).toEqual({ status: 'canceled', error: 'guidance bundle unavailable: churn' });
			expect(keyCount(run.id)).toBe(0);
			const block = d1<{ reason: string; retry_after: number }>(
				`SELECT reason,retry_after FROM issue_guidance_block WHERE issue_id = ${sqlLiteral(issue.id)}`
			)[0];
			expect(block.reason).toBe('churn');
			expect(block.retry_after).toBeGreaterThan(Date.now());
			// No strike: the issue is not flagged for attention.
			expect(
				d1<{ n: number }>(
					`SELECT needs_attention AS n FROM issue WHERE id = ${sqlLiteral(issue.id)}`
				)[0].n
			).toBe(0);
			// The slot is free and the held issue is not claimed again yet.
			await fireSweep(request);
			expect(
				d1(
					`SELECT 1 FROM agent_run WHERE issue_id = ${sqlLiteral(issue.id)} AND status = 'assigned'`
				)
			).toHaveLength(0);
		} finally {
			await f.cleanup();
		}
	});
});
