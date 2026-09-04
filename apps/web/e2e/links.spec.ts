import type {
	Issue,
	IssueDetail,
	IssueLink,
	ListResponse,
	Project,
	TinesEvent
} from '@tines/shared';
import { expect, test } from '@playwright/test';
import { ALICE, BOB } from './constants.mjs';
import { apiClient, body, errorBody, runId } from './helpers';

/**
 * Dependencies & duplicates (specs/issue_dependencies/SPEC.md): blocking
 * links, virtual duplicate passthrough, the ready filter, and cycle
 * rejection over the combined graph.
 */
test.describe.serial('issue links', () => {
	const projectName = `links-${runId}`;
	const otherProjectName = `links2-${runId}`;
	let projectId: string;
	let otherProjectId: string;
	// a blocks b; c duplicate_of a; d free-standing.
	let a: IssueDetail;
	let b: IssueDetail;
	let c: IssueDetail;
	let d: IssueDetail;
	let blockLinkId: string;

	const closeIssue = async (
		api: ReturnType<typeof apiClient>,
		issue: IssueDetail
	): Promise<void> => {
		// Standard workflow: Open → (Abandon) → a done state, in one hop.
		const detail = await body<IssueDetail>(await api.get(`/api/v1/issues/${issue.id}`));
		const toDone = detail.allowed_transitions.find((t) => t.to_state.category === 'done');
		expect(toDone, `no done transition from ${detail.state.name}`).toBeTruthy();
		const res = await api.post(`/api/v1/issues/${issue.id}/transition`, {
			transition_id: toDone!.transition_id
		});
		expect(res.ok()).toBe(true);
	};

	test('seeds two projects and four issues', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		projectId = (await body<Project>(await api.post('/api/v1/projects', { name: projectName }))).id;
		otherProjectId = (
			await body<Project>(await api.post('/api/v1/projects', { name: otherProjectName }))
		).id;
		a = await body<IssueDetail>(
			await api.post(`/api/v1/projects/${projectId}/issues`, { title: 'Blocker A' })
		);
		b = await body<IssueDetail>(
			await api.post(`/api/v1/projects/${projectId}/issues`, { title: 'Blocked B' })
		);
		c = await body<IssueDetail>(
			await api.post(`/api/v1/projects/${otherProjectId}/issues`, { title: 'Duplicate C' })
		);
		d = await body<IssueDetail>(
			await api.post(`/api/v1/projects/${projectId}/issues`, { title: 'Free D' })
		);
		expect(a.links).toEqual({ blocked_by: [], blocks: [], duplicate_of: null, duplicated_by: [] });
		expect(a.open_blockers).toEqual([]);
		expect(a.duplicate_of).toBeNull();
		expect(a.effective_state).toEqual(a.state);
	});

	test('adds a blocking link via blocked_by sugar; both sides see it', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const res = await api.post(`/api/v1/issues/${b.id}/links`, {
			kind: 'blocked_by',
			issue_id: a.id
		});
		expect(res.status()).toBe(201);
		const link = await body<IssueLink>(res);
		expect(link.kind).toBe('blocks');
		expect(link.source_issue_id).toBe(a.id);
		expect(link.target_issue_id).toBe(b.id);
		blockLinkId = link.id;

		const bDetail = await body<IssueDetail>(await api.get(`/api/v1/issues/${b.id}`));
		expect(bDetail.links.blocked_by.map((l) => l.issue_id)).toEqual([a.id]);
		expect(bDetail.open_blockers).toEqual([
			{ project_name: projectName, number: a.number, title: 'Blocker A' }
		]);
		const aDetail = await body<IssueDetail>(await api.get(`/api/v1/issues/${a.id}`));
		expect(aDetail.links.blocks.map((l) => l.issue_id)).toEqual([b.id]);

		// Both feeds record the link.
		for (const issue of [a, b]) {
			const events = await body<ListResponse<TinesEvent>>(
				await api.get(`/api/v1/events?issue=${issue.id}&type=issue.link_added`)
			);
			expect(events.items.length).toBe(1);
			expect(events.items[0].payload.kind).toBe('blocks');
		}
	});

	test('re-adding the same link is a 409; self-links are rejected', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const dup = await api.post(`/api/v1/issues/${a.id}/links`, { kind: 'blocks', issue_id: b.id });
		expect(dup.status()).toBe(409);
		const self = await api.post(`/api/v1/issues/${a.id}/links`, { kind: 'blocks', issue_id: a.id });
		expect(self.status()).toBe(422);
		expect((await errorBody(self)).error.code).toBe('self_link');
	});

	test('links to another user’s issue are indistinguishable from nonexistent', async ({
		request
	}) => {
		const bob = apiClient(request, BOB.apiKey);
		const res = await bob.post(`/api/v1/issues/${a.id}/links`, { kind: 'blocks', issue_id: b.id });
		expect(res.status()).toBe(404);
	});

	test('cross-project duplicate: effective state passes through, virtually', async ({
		request
	}) => {
		const api = apiClient(request, ALICE.apiKey);
		const res = await api.post(`/api/v1/issues/${c.id}/links`, {
			kind: 'duplicate_of',
			issue_id: a.id
		});
		expect(res.status()).toBe(201);

		let cDetail = await body<IssueDetail>(await api.get(`/api/v1/issues/${c.id}`));
		expect(cDetail.duplicate_of).toEqual({
			project_name: projectName,
			number: a.number,
			title: 'Blocker A'
		});
		expect(cDetail.links.duplicate_of?.issue_id).toBe(a.id);
		// A is still open, so C's effective state is A's (same category here).
		expect(cDetail.effective_state.id).toBe(a.state.id);

		await closeIssue(api, a);

		// C's own state row never changed, but its effective state is done.
		cDetail = await body<IssueDetail>(await api.get(`/api/v1/issues/${c.id}`));
		expect(cDetail.state.category).not.toBe('done');
		expect(cDetail.effective_state.category).toBe('done');
		// hide_done follows the effective state, so C disappears with it.
		const hidden = await body<ListResponse<Issue>>(
			await api.get(`/api/v1/issues?project=${otherProjectName}&hide_done=1`)
		);
		expect(hidden.items.map((i) => i.id)).not.toContain(c.id);
		// A closing also unblocked B (the blocker's effective category is done).
		const bDetail = await body<IssueDetail>(await api.get(`/api/v1/issues/${b.id}`));
		expect(bDetail.open_blockers).toEqual([]);
	});

	test('a second duplicate_of on the same issue is rejected', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const res = await api.post(`/api/v1/issues/${c.id}/links`, {
			kind: 'duplicate_of',
			issue_id: d.id
		});
		expect(res.status()).toBe(422);
		expect((await errorBody(res)).error.code).toBe('already_duplicate');
	});

	test('ready lists unblocked, not-done, non-duplicate issues only', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const ready = async (params = '') =>
			(await body<ListResponse<Issue>>(await api.get(`/api/v1/issues?ready=1${params}`))).items.map(
				(i) => i.id
			);

		const ids = await ready(`&project=${projectName}`);
		// A is done, B is unblocked now (A closed), D was always ready.
		expect(ids).not.toContain(a.id);
		expect(ids).toContain(b.id);
		expect(ids).toContain(d.id);
		// C is a duplicate (and effectively done): never ready.
		expect(await ready(`&project=${otherProjectName}`)).toEqual([]);
		// Composes with category filters.
		expect(await ready(`&project=${projectName}&category=done`)).toEqual([]);
	});

	test('cycles are rejected with the offending path, in every shape', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		// Direct back-edge: b → a while a → b exists.
		const back = await api.post(`/api/v1/issues/${b.id}/links`, {
			kind: 'blocks',
			issue_id: a.id
		});
		expect(back.status()).toBe(422);
		const err = (await errorBody(back)).error;
		expect(err.code).toBe('link_cycle');
		expect(err.message).toContain(`${projectName}/${b.number}`);
		expect(err.message).toContain(`${projectName}/${a.number}`);
		expect((err.details?.path as unknown[]).length).toBe(3);

		// Mixed loop: b duplicate_of a while a blocks b.
		const mixed = await api.post(`/api/v1/issues/${b.id}/links`, {
			kind: 'duplicate_of',
			issue_id: a.id
		});
		expect(mixed.status()).toBe(422);
		expect((await errorBody(mixed)).error.code).toBe('link_cycle');

		// Duplicate loop closing a chain: a duplicate_of c while c duplicate_of a.
		const loop = await api.post(`/api/v1/issues/${a.id}/links`, {
			kind: 'duplicate_of',
			issue_id: c.id
		});
		expect(loop.status()).toBe(422);
		expect((await errorBody(loop)).error.code).toBe('link_cycle');
	});

	test('duplicate chains resolve to the terminus', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		// d duplicate_of c, c duplicate_of a (closed) ⇒ d effectively done.
		const res = await api.post(`/api/v1/issues/${d.id}/links`, {
			kind: 'duplicate_of',
			issue_id: c.id
		});
		expect(res.status()).toBe(201);
		const dDetail = await body<IssueDetail>(await api.get(`/api/v1/issues/${d.id}`));
		expect(dDetail.effective_state.category).toBe('done');
		// The direct canonical ref is C, not the terminus.
		expect(dDetail.duplicate_of?.number).toBe(c.number);
	});

	test('removing a link restores the untouched state, addressed from either end', async ({
		request
	}) => {
		const api = apiClient(request, ALICE.apiKey);
		const dDetail = await body<IssueDetail>(await api.get(`/api/v1/issues/${d.id}`));
		const linkId = dDetail.links.duplicate_of!.link_id;
		// Addressed via the other endpoint (c) — either end works.
		const res = await api.delete(`/api/v1/issues/${c.id}/links/${linkId}`);
		expect(res.status()).toBe(204);

		const fresh = await body<IssueDetail>(await api.get(`/api/v1/issues/${d.id}`));
		expect(fresh.duplicate_of).toBeNull();
		expect(fresh.effective_state.category).not.toBe('done');
		const events = await body<ListResponse<TinesEvent>>(
			await api.get(`/api/v1/events?issue=${d.id}&type=issue.link_removed`)
		);
		expect(events.items.length).toBe(1);

		// Unknown / already-removed link id → 404.
		expect((await api.delete(`/api/v1/issues/${c.id}/links/${linkId}`)).status()).toBe(404);
		// Bob can't remove Alice's links.
		const bob = apiClient(request, BOB.apiKey);
		expect((await bob.delete(`/api/v1/issues/${b.id}/links/${blockLinkId}`)).status()).toBe(404);
	});

	test('blocking is advisory: a blocked issue still transitions', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		// b is still blocked-linked to a (a is done, but the link exists); block
		// b on a fresh open blocker, then close b anyway.
		const e = await body<IssueDetail>(
			await api.post(`/api/v1/projects/${projectId}/issues`, { title: 'Blocker E' })
		);
		const res = await api.post(`/api/v1/issues/${b.id}/links`, {
			kind: 'blocked_by',
			issue_id: e.id
		});
		expect(res.status()).toBe(201);
		await closeIssue(api, b);
		const bDetail = await body<IssueDetail>(await api.get(`/api/v1/issues/${b.id}`));
		expect(bDetail.state.category).toBe('done');
	});
});
