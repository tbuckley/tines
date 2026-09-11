import { execFileSync } from 'node:child_process';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { IssueDetail, Project } from '@tines/shared';
import { ALICE } from './constants.mjs';
import { apiClient, body, errorBody, runId } from './helpers';

function d1(sql: string): Array<Record<string, unknown>> {
	const output = execFileSync(
		'pnpm',
		[
			'exec',
			'wrangler',
			'd1',
			'execute',
			'tines',
			'--local',
			'--persist-to',
			'.wrangler-e2e',
			'--command',
			sql,
			'--json'
		],
		{ encoding: 'utf8' }
	);
	const result = JSON.parse(output) as Array<{ results?: Array<Record<string, unknown>> }>;
	return result[0]?.results ?? [];
}

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

async function makeIssues(request: APIRequestContext, marker: string, count: number) {
	const api = apiClient(request, ALICE.apiKey);
	const project = await body<Project>(
		await api.post('/api/v1/projects', { name: `native-links-${runId}-${marker}` })
	);
	const issues: IssueDetail[] = [];
	for (let i = 0; i < count; i++) {
		issues.push(
			await body<IssueDetail>(
				await api.post(`/api/v1/projects/${project.id}/issues`, { title: `${marker}-${i}` })
			)
		);
	}
	return { api, project, issues };
}

async function race(
	api: ReturnType<typeof apiClient>,
	first: { issue: string; kind: 'blocks' | 'blocked_by' | 'duplicate_of'; other: string },
	second: { issue: string; kind: 'blocks' | 'blocked_by' | 'duplicate_of'; other: string }
) {
	return Promise.all([
		api.post(`/api/v1/issues/${first.issue}/links`, {
			kind: first.kind,
			issue_id: first.other
		}),
		api.post(`/api/v1/issues/${second.issue}/links`, {
			kind: second.kind,
			issue_id: second.other
		})
	]);
}

test.describe.serial('native D1 issue-link concurrency guard', () => {
	for (const [name, firstKind, secondKind] of [
		['reciprocal-block', 'blocks', 'blocks'],
		['reciprocal-duplicate', 'duplicate_of', 'duplicate_of'],
		['mixed', 'blocks', 'duplicate_of'],
		['blocked-by-alias', 'blocked_by', 'blocked_by']
	] as const) {
		test(`${name} races never commit a cycle`, async ({ request }) => {
			test.setTimeout(120_000);
			for (let iteration = 0; iteration < 5; iteration++) {
				const {
					api,
					project,
					issues: [a, b]
				} = await makeIssues(request, `${name}-${iteration}`, 2);
				const responses = await race(
					api,
					{ issue: a.id, kind: firstKind, other: b.id },
					{ issue: b.id, kind: secondKind, other: a.id }
				);
				expect(responses.map((response) => response.status()).sort()).toEqual([201, 422]);
				const loser = responses.find((response) => response.status() === 422)!;
				const error = (await errorBody(loser)).error;
				expect(error.code).toBe('link_cycle');
				expect(error.message).toContain(`${project.name}/`);
				expect((error.details?.path as unknown[]).length).toBe(3);
				expect(
					d1(
						`SELECT COUNT(*) AS n FROM issue_link WHERE source_issue_id IN (${literal(a.id)},${literal(b.id)})`
					)
				).toEqual([{ n: 1 }]);
				expect(
					d1(
						`SELECT COUNT(*) AS n FROM event WHERE type='issue.link_added' AND issue_id IN (${literal(a.id)},${literal(b.id)})`
					)
				).toEqual([{ n: 2 }]);
			}
		});
	}

	test('disjoint four-node closure rejects one candidate and keeps both seed edges', async ({
		request
	}) => {
		const {
			api,
			project,
			issues: [a, b, c, d]
		} = await makeIssues(request, 'four-node', 4);
		expect(
			(await api.post(`/api/v1/issues/${a.id}/links`, { kind: 'blocks', issue_id: b.id })).status()
		).toBe(201);
		expect(
			(await api.post(`/api/v1/issues/${c.id}/links`, { kind: 'blocks', issue_id: d.id })).status()
		).toBe(201);
		const responses = await race(
			api,
			{ issue: b.id, kind: 'blocks', other: c.id },
			{ issue: d.id, kind: 'blocks', other: a.id }
		);
		expect(responses.map((response) => response.status()).sort()).toEqual([201, 422]);
		const error = (await errorBody(responses.find((response) => response.status() === 422)!)).error;
		expect(error.code).toBe('link_cycle');
		expect(error.message).toContain(project.name);
		expect(
			d1(
				`SELECT COUNT(*) AS n FROM issue_link WHERE source_issue_id IN (${[a, b, c, d]
					.map((issue) => literal(issue.id))
					.join(',')})`
			)
		).toEqual([{ n: 3 }]);
	});

	test('concurrent acyclic and conflicting additions retain their established outcomes', async ({
		request
	}) => {
		const {
			api,
			issues: [a, b, c, d, e, f]
		} = await makeIssues(request, 'outcomes', 6);
		let responses = await race(
			api,
			{ issue: a.id, kind: 'blocks', other: b.id },
			{ issue: c.id, kind: 'blocks', other: d.id }
		);
		expect(responses.map((response) => response.status()).sort()).toEqual([201, 201]);

		responses = await race(
			api,
			{ issue: b.id, kind: 'blocks', other: e.id },
			{ issue: b.id, kind: 'blocks', other: e.id }
		);
		expect(responses.map((response) => response.status()).sort()).toEqual([201, 409]);

		responses = await race(
			api,
			{ issue: f.id, kind: 'duplicate_of', other: a.id },
			{ issue: f.id, kind: 'duplicate_of', other: c.id }
		);
		expect(responses.map((response) => response.status()).sort()).toEqual([201, 422]);
		expect(
			(await errorBody(responses.find((response) => response.status() === 422)!)).error.code
		).toBe('already_duplicate');
	});
});
