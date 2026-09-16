import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from './fixtures';
import type { IssueDetail, IssueLink, Project } from '@tines/shared';
import { ALICE, ALICE_AGENT } from './constants.mjs';
import { apiClient, body, errorBody, runId } from './helpers';

function d1(sql: string): Array<Record<string, unknown>> {
	let output = '';
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			output = execFileSync(
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
			break;
		} catch (error) {
			if (attempt === 2) throw error;
		}
	}
	const result = JSON.parse(output) as Array<{ results?: Array<Record<string, unknown>> }>;
	return result[0]?.results ?? [];
}

function d1File(sql: string): void {
	const dir = mkdtempSync(join(tmpdir(), 'tines-native-links-'));
	const file = join(dir, 'fixture.sql');
	try {
		writeFileSync(file, sql);
		execFileSync(
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
				'--file',
				file,
				'--json'
			],
			{ encoding: 'utf8' }
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

function insertChunks(prefix: string, rows: string[]): string {
	const statements: string[] = [];
	for (let i = 0; i < rows.length; i += 100) {
		statements.push(`${prefix} VALUES ${rows.slice(i, i + 100).join(',\n')};`);
	}
	return statements.join('\n');
}

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
	firstApi: ReturnType<typeof apiClient>,
	secondApi: ReturnType<typeof apiClient>,
	first: { issue: string; kind: 'blocks' | 'blocked_by' | 'duplicate_of'; other: string },
	second: { issue: string; kind: 'blocks' | 'blocked_by' | 'duplicate_of'; other: string }
) {
	return Promise.all([
		firstApi.post(`/api/v1/issues/${first.issue}/links`, {
			kind: first.kind,
			issue_id: first.other
		}),
		secondApi.post(`/api/v1/issues/${second.issue}/links`, {
			kind: second.kind,
			issue_id: second.other
		})
	]);
}

function audit(ids: string[]) {
	const inList = ids.map(literal).join(',');
	let rows: Array<Record<string, unknown>> = [];
	for (let attempt = 0; attempt < 3; attempt++) {
		rows = d1(`
			SELECT 'link' AS row_type, id, source_issue_id AS source, target_issue_id AS target,
				kind, NULL AS issue_id, NULL AS project_id, NULL AS actor_api_key_id, NULL AS payload
			FROM issue_link WHERE source_issue_id IN (${inList}) AND target_issue_id IN (${inList})
			UNION ALL
			SELECT 'event', json_extract(payload, '$.link_id'), NULL, NULL, NULL, issue_id,
				project_id, actor_api_key_id, payload
			FROM event WHERE type = 'issue.link_added' AND issue_id IN (${inList})
		`);
		if (rows.length > 0) break;
	}
	return rows;
}

function expectAcyclic(rows: Array<Record<string, unknown>>) {
	const edges = rows.filter((row) => row.row_type === 'link');
	const adjacency = new Map<string, string[]>();
	for (const edge of edges) {
		const list = adjacency.get(edge.source as string) ?? [];
		list.push(edge.target as string);
		adjacency.set(edge.source as string, list);
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (node: string): boolean => {
		if (visiting.has(node)) return false;
		if (visited.has(node)) return true;
		visiting.add(node);
		for (const target of adjacency.get(node) ?? []) if (!visit(target)) return false;
		visiting.delete(node);
		visited.add(node);
		return true;
	};
	for (const node of adjacency.keys()) expect(visit(node)).toBe(true);
}

function expectWinnerAudit(
	rows: Array<Record<string, unknown>>,
	link: IssueLink,
	issues: Map<string, IssueDetail>,
	projectId: string,
	actorKeyId: string
) {
	const events = rows.filter((row) => row.row_type === 'event' && row.id === link.id);
	expect(events).toHaveLength(2);
	for (const [self, peer, role] of [
		[link.source_issue_id, link.target_issue_id, 'source'],
		[link.target_issue_id, link.source_issue_id, 'target']
	] as const) {
		const row = events.find((event) => event.issue_id === self)!;
		expect(row).toMatchObject({ project_id: projectId, actor_api_key_id: actorKeyId });
		const payload = JSON.parse(row.payload as string);
		expect(payload).toEqual({
			link_id: link.id,
			kind: link.kind,
			role,
			other_issue_id: peer,
			other_project_name: issues.get(peer)!.project_name,
			other_number: issues.get(peer)!.number,
			other_title: issues.get(peer)!.title
		});
	}
}

test.describe.serial('native D1 issue-link concurrency guard', () => {
	for (const [name, firstKind, secondKind] of [
		['reciprocal-block', 'blocks', 'blocks'],
		['reciprocal-duplicate', 'duplicate_of', 'duplicate_of'],
		['mixed', 'blocks', 'duplicate_of'],
		['blocked-by-alias', 'blocked_by', 'blocked_by']
	] as const) {
		test(`${name} races never commit a cycle`, async ({ request }) => {
			test.setTimeout(180_000);
			for (let iteration = 0; iteration < 20; iteration++) {
				const {
					api,
					project,
					issues: [a, b]
				} = await makeIssues(request, `${name}-${iteration}`, 2);
				const agent = apiClient(request, ALICE_AGENT.apiKey);
				const firstApi = iteration % 2 === 0 ? api : agent;
				const secondApi = iteration % 2 === 0 ? agent : api;
				const responses = await race(
					firstApi,
					secondApi,
					{ issue: a.id, kind: firstKind, other: b.id },
					{ issue: b.id, kind: secondKind, other: a.id }
				);
				expect(responses.map((response) => response.status()).sort()).toEqual([201, 422]);
				const loser = responses.find((response) => response.status() === 422)!;
				const error = (await errorBody(loser)).error;
				expect(error.code).toBe('link_cycle');
				expect(error.message).toContain(`${project.name}/`);
				expect((error.details?.path as unknown[]).length).toBe(3);
				const winnerIndex = responses.findIndex((response) => response.status() === 201);
				const link = await body<IssueLink>(responses[winnerIndex]);
				const rows = audit([a.id, b.id]);
				expect(rows.filter((row) => row.row_type === 'link')).toHaveLength(1);
				expectAcyclic(rows);
				expectWinnerAudit(
					rows,
					link,
					new Map([
						[a.id, a],
						[b.id, b]
					]),
					project.id,
					winnerIndex === 0
						? iteration % 2 === 0
							? `key_${ALICE.id}`
							: ALICE_AGENT.id
						: iteration % 2 === 0
							? ALICE_AGENT.id
							: `key_${ALICE.id}`
				);
			}
		});
	}

	test('both sequential orders reject the closing edge with canonical refs', async ({
		request
	}) => {
		test.setTimeout(120_000);
		for (const [name, firstKind, secondKind] of [
			['block', 'blocks', 'blocks'],
			['duplicate', 'duplicate_of', 'duplicate_of'],
			['mixed', 'blocks', 'duplicate_of'],
			['alias', 'blocked_by', 'blocked_by']
		] as const) {
			for (const reverse of [false, true]) {
				const {
					api,
					project,
					issues: [a, b]
				} = await makeIssues(request, `sequential-${name}-${reverse}`, 2);
				const candidates = [
					{ issue: a.id, kind: firstKind, other: b.id },
					{ issue: b.id, kind: secondKind, other: a.id }
				];
				if (reverse) candidates.reverse();
				const accepted = await api.post(`/api/v1/issues/${candidates[0].issue}/links`, {
					kind: candidates[0].kind,
					issue_id: candidates[0].other
				});
				expect(accepted.status()).toBe(201);
				const rejected = await api.post(`/api/v1/issues/${candidates[1].issue}/links`, {
					kind: candidates[1].kind,
					issue_id: candidates[1].other
				});
				expect(rejected.status()).toBe(422);
				const error = (await errorBody(rejected)).error;
				expect(error.code).toBe('link_cycle');
				expect(error.message).toContain(`${project.name}/`);
				const rows = audit([a.id, b.id]);
				expect(rows.filter((row) => row.row_type === 'link')).toHaveLength(1);
				expectAcyclic(rows);
			}
		}
	});

	test('disjoint four-node closure rejects one candidate and keeps both seed edges', async ({
		request
	}) => {
		const {
			api,
			project,
			issues: [a, b, c, d]
		} = await makeIssues(request, 'four-node', 4);
		const seedOne = await body<IssueLink>(
			await api.post(`/api/v1/issues/${a.id}/links`, { kind: 'blocks', issue_id: b.id })
		);
		const seedTwo = await body<IssueLink>(
			await api.post(`/api/v1/issues/${c.id}/links`, { kind: 'blocks', issue_id: d.id })
		);
		const responses = await race(
			api,
			apiClient(request, ALICE_AGENT.apiKey),
			{ issue: b.id, kind: 'blocks', other: c.id },
			{ issue: d.id, kind: 'blocks', other: a.id }
		);
		expect(responses.map((response) => response.status()).sort()).toEqual([201, 422]);
		const error = (await errorBody(responses.find((response) => response.status() === 422)!)).error;
		expect(error.code).toBe('link_cycle');
		expect(error.message).toContain(project.name);
		const winnerIndex = responses.findIndex((response) => response.status() === 201);
		const winner = await body<IssueLink>(responses[winnerIndex]);
		const issues = new Map([a, b, c, d].map((issue) => [issue.id, issue]));
		const rows = audit([a.id, b.id, c.id, d.id]);
		expect(rows.filter((row) => row.row_type === 'link')).toHaveLength(3);
		expectAcyclic(rows);
		expectWinnerAudit(rows, seedOne, issues, project.id, `key_${ALICE.id}`);
		expectWinnerAudit(rows, seedTwo, issues, project.id, `key_${ALICE.id}`);
		expectWinnerAudit(
			rows,
			winner,
			issues,
			project.id,
			winnerIndex === 0 ? `key_${ALICE.id}` : ALICE_AGENT.id
		);
	});

	test('concurrent acyclic and conflicting additions retain their established outcomes', async ({
		request
	}) => {
		const {
			api,
			project,
			issues: [a, b, c, d, e, f]
		} = await makeIssues(request, 'outcomes', 6);
		let responses = await race(
			api,
			apiClient(request, ALICE_AGENT.apiKey),
			{ issue: a.id, kind: 'blocks', other: b.id },
			{ issue: c.id, kind: 'blocks', other: d.id }
		);
		expect(responses.map((response) => response.status()).sort()).toEqual([201, 201]);
		const acyclicLinks = await Promise.all(responses.map((response) => body<IssueLink>(response)));
		let rows = audit([a.id, b.id, c.id, d.id]);
		expectAcyclic(rows);
		const issues = new Map([a, b, c, d, e, f].map((issue) => [issue.id, issue]));
		expectWinnerAudit(rows, acyclicLinks[0], issues, project.id, `key_${ALICE.id}`);
		expectWinnerAudit(rows, acyclicLinks[1], issues, project.id, ALICE_AGENT.id);

		responses = await race(
			api,
			apiClient(request, ALICE_AGENT.apiKey),
			{ issue: b.id, kind: 'blocks', other: e.id },
			{ issue: b.id, kind: 'blocks', other: e.id }
		);
		expect(responses.map((response) => response.status()).sort()).toEqual([201, 409]);
		let winnerIndex = responses.findIndex((response) => response.status() === 201);
		let winner = await body<IssueLink>(responses[winnerIndex]);
		rows = audit([b.id, e.id]);
		expectAcyclic(rows);
		expectWinnerAudit(
			rows,
			winner,
			issues,
			project.id,
			winnerIndex === 0 ? `key_${ALICE.id}` : ALICE_AGENT.id
		);

		responses = await race(
			api,
			apiClient(request, ALICE_AGENT.apiKey),
			{ issue: f.id, kind: 'duplicate_of', other: a.id },
			{ issue: f.id, kind: 'duplicate_of', other: c.id }
		);
		expect(responses.map((response) => response.status()).sort()).toEqual([201, 422]);
		expect(
			(await errorBody(responses.find((response) => response.status() === 422)!)).error.code
		).toBe('already_duplicate');
		winnerIndex = responses.findIndex((response) => response.status() === 201);
		winner = await body<IssueLink>(responses[winnerIndex]);
		rows = audit([f.id, a.id, c.id]);
		expectAcyclic(rows);
		expectWinnerAudit(
			rows,
			winner,
			issues,
			project.id,
			winnerIndex === 0 ? `key_${ALICE.id}` : ALICE_AGENT.id
		);
	});

	test('a real-builder later event failure rolls the native batch back', async ({ request }) => {
		const {
			api,
			issues: [a, b]
		} = await makeIssues(request, 'rollback', 2);
		const trigger = `reject_native_link_event_${runId.replaceAll(/[^a-zA-Z0-9_]/g, '_')}`;
		d1(`CREATE TRIGGER ${trigger} BEFORE INSERT ON event
			WHEN NEW.type='issue.link_added' AND NEW.issue_id=${literal(b.id)}
			BEGIN SELECT RAISE(ABORT, 'native injected event failure'); END`);
		try {
			const response = await api.post(`/api/v1/issues/${a.id}/links`, {
				kind: 'blocks',
				issue_id: b.id
			});
			expect(response.status()).toBe(500);
			expect(audit([a.id, b.id])).toEqual([]);
		} finally {
			d1(`DROP TRIGGER IF EXISTS ${trigger}`);
		}
	});

	test('native traversal handles 1,000-node chain and converging fan-out fixtures', async ({
		request
	}) => {
		test.setTimeout(180_000);
		const marker = `large-${runId}`;
		const projectId = `prj_native_${marker}`;
		const chain = Array.from({ length: 1001 }, (_, i) => `iss_native_${marker}_chain_${i}`);
		const fan = Array.from({ length: 1002 }, (_, i) => `iss_native_${marker}_fan_${i}`);
		const issueRows = [...chain, ...fan].map(
			(id, i) =>
				`(${literal(id)},${literal(projectId)},${i + 1},${literal(`Native ${i}`)},'',` +
				`'wf_standard','wfs_std_open',1,1)`
		);
		const linkRows = [
			...chain
				.slice(0, -1)
				.map(
					(id, i) =>
						`('lnk_native_${marker}_chain_${i}',${literal(id)},${literal(chain[i + 1])},'blocks',1)`
				),
			...fan
				.slice(1, -1)
				.flatMap((id, i) => [
					`('lnk_native_${marker}_fan_out_${i}',${literal(fan[0])},${literal(id)},'blocks',1)`,
					`('lnk_native_${marker}_fan_in_${i}',${literal(id)},${literal(fan.at(-1)!)},'blocks',1)`
				])
		];
		d1File(`
			INSERT INTO project (id,user_id,name,description,created_at,updated_at)
			VALUES (${literal(projectId)},${literal(ALICE.id)},${literal(marker)},'',1,1);
			${insertChunks(
				'INSERT INTO issue (id,project_id,number,title,description,workflow_id,state_id,created_at,updated_at)',
				issueRows
			)}
			${insertChunks(
				'INSERT INTO issue_link (id,source_issue_id,target_issue_id,kind,created_at)',
				linkRows
			)}
		`);

		const api = apiClient(request, ALICE.apiKey);
		const measurements: Array<Record<string, unknown>> = [];
		for (const [name, source, target, expectedPath] of [
			['chain', chain.at(-1)!, chain[0], 1002],
			['fan', fan.at(-1)!, fan[0], 4]
		] as const) {
			const started = performance.now();
			const rejected = await api.post(`/api/v1/issues/${source}/links`, {
				kind: 'blocks',
				issue_id: target
			});
			expect(rejected.status(), name).toBe(422);
			const error = (await errorBody(rejected)).error;
			expect(error.code).toBe('link_cycle');
			expect(error.details?.path).toHaveLength(expectedPath);
			const elapsedMs = performance.now() - started;
			expect(elapsedMs, `${name} rejected traversal ms`).toBeLessThan(30_000);
			measurements.push({
				graph: name,
				outcome: 'rejected',
				elapsed_ms: Math.round(elapsedMs),
				path_steps: expectedPath,
				diagnostic_bytes: JSON.stringify(error).length
			});
		}
		for (const [name, target] of [
			['chain', chain[0]],
			['fan', fan[0]]
		] as const) {
			const extra = await body<IssueDetail>(
				await api.post(`/api/v1/projects/${projectId}/issues`, { title: `${name} valid source` })
			);
			const started = performance.now();
			const accepted = await api.post(`/api/v1/issues/${extra.id}/links`, {
				kind: 'blocks',
				issue_id: target
			});
			expect(accepted.status(), name).toBe(201);
			const elapsedMs = performance.now() - started;
			expect(elapsedMs, `${name} accepted traversal ms`).toBeLessThan(30_000);
			measurements.push({
				graph: name,
				outcome: 'accepted',
				elapsed_ms: Math.round(elapsedMs)
			});
		}

		const plan = d1(`EXPLAIN QUERY PLAN
			WITH RECURSIVE reachable(issue_id) AS (
				SELECT ${literal(chain[0])}
				UNION
				SELECT link.target_issue_id FROM reachable
				JOIN issue_link link ON link.source_issue_id = reachable.issue_id
				WHERE link.kind IN ('blocks','duplicate_of')
			)
			SELECT 1 WHERE NOT EXISTS (
				SELECT 1 FROM reachable WHERE issue_id = ${literal(chain.at(-1)!)}
			)`);
		expect(plan.map((row) => row.detail).join('\n')).toMatch(
			/issue_link.*source_issue_id|sqlite_autoindex_issue_link/i
		);
		console.info('native link traversal evidence', JSON.stringify({ measurements, plan }));
	});
});
