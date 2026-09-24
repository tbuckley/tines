import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeCursor } from '$lib/server/api/core';

const mocks = vi.hoisted(() => ({
	listIssues: vi.fn(),
	countIssuesByCategory: vi.fn(),
	resolveFocus: vi.fn(),
	setFocus: vi.fn(),
	getProject: vi.fn()
}));

vi.mock('$lib/server/db', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/api/issues', () => ({
	listIssues: mocks.listIssues,
	countIssuesByCategory: mocks.countIssuesByCategory
}));
vi.mock('$lib/server/api/preferences', () => ({
	resolveFocus: mocks.resolveFocus,
	setFocus: mocks.setFocus
}));
vi.mock('$lib/server/api/projects', () => ({
	getProject: mocks.getProject,
	listProjects: vi.fn(async () => [])
}));
vi.mock('$lib/server/api/project-access', () => ({
	resolveProjectAccess: vi.fn(async () => ({ role: 'owner' }))
}));
vi.mock('$lib/server/api/labels', () => ({ listLabelsInternal: vi.fn(async () => []) }));
vi.mock('$lib/server/api/workflows', () => ({ loadWorkflows: vi.fn(async () => []) }));
vi.mock('$lib/server/api/context', () => ({
	listContextItems: vi.fn(async () => ({ items: [], hasMore: false }))
}));
vi.mock('$lib/server/api/routing', () => ({ listRoutingRules: vi.fn(async () => []) }));
vi.mock('$lib/server/api/schedules', () => ({
	listSchedules: vi.fn(async () => ({ items: [], hasMore: false }))
}));

import { load as loadIssues } from './issues/+page.server';
import { load as loadProject } from './projects/[id]/+page.server';

type TestEvent = {
	locals: { user: { id: string } };
	platform: { env: Record<string, never> };
	params: Record<string, string>;
	url: URL;
	depends: ReturnType<typeof vi.fn>;
};

const event = (url: string, params: Record<string, string> = {}): TestEvent => ({
	locals: { user: { id: 'usr_test' } },
	platform: { env: {} },
	params,
	url: new URL(url),
	depends: vi.fn()
});

const callLoad = (load: unknown, input: TestEvent) =>
	(load as (event: TestEvent) => Promise<unknown>)(input);

describe('issue-list page loaders', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.listIssues.mockResolvedValue({ items: [], hasMore: false });
		mocks.countIssuesByCategory.mockResolvedValue({
			backlog: 0,
			active: 0,
			awaiting_human: 0,
			done: 0
		});
		mocks.resolveFocus.mockResolvedValue({ focusId: null, lastProjectId: null });
		mocks.getProject.mockResolvedValue({ id: 'prj_test', name: 'Test project' });
	});

	it('resets a bounded all-issues page when its recorded focus no longer matches', async () => {
		mocks.resolveFocus.mockResolvedValue({ focusId: 'prj_new', lastProjectId: null });
		const cursor = encodeCursor(42, 'iss_boundary');

		await expect(
			callLoad(
				loadIssues,
				event(
					`https://example.test/issues?q=needle&duplicates=1&after=${cursor}&page_scope=prj_old`
				)
			)
		).rejects.toMatchObject({ status: 303, location: '/issues?q=needle&duplicates=1' });
		expect(mocks.listIssues).not.toHaveBeenCalled();
	});

	it('requests a brief, 100-row cursor page for the all-issues list', async () => {
		const cursor = encodeCursor(42, 'iss_boundary');
		await callLoad(loadIssues, event(`https://example.test/issues?after=${cursor}&page_scope=all`));

		expect(mocks.listIssues).toHaveBeenCalledWith(
			{},
			'usr_test',
			expect.objectContaining({ brief: true }),
			expect.objectContaining({
				cursor: { createdAt: 42, id: 'iss_boundary' },
				direction: 'after',
				limit: 100
			})
		);
	});

	it('requests a brief, 100-row cursor page for the project issue list', async () => {
		const cursor = encodeCursor(42, 'iss_boundary');
		await callLoad(
			loadProject,
			event(`https://example.test/projects/prj_test?before=${cursor}`, { id: 'prj_test' })
		);

		expect(mocks.listIssues).toHaveBeenCalledWith(
			{},
			'usr_test',
			expect.objectContaining({ projectId: 'prj_test', brief: true }),
			expect.objectContaining({
				cursor: { createdAt: 42, id: 'iss_boundary' },
				direction: 'before',
				limit: 100
			})
		);
	});

	it.each([
		['all issues', loadIssues, 'https://example.test/issues', {}, undefined],
		[
			'project issues',
			loadProject,
			'https://example.test/projects/prj_test',
			{ id: 'prj_test' },
			'prj_test'
		]
	] as const)(
		'passes workflow and state through the %s rows and category counts',
		async (_name, load, baseUrl, params, projectId) => {
			const result = (await callLoad(
				load,
				event(
					`${baseUrl}?workflow=wf_eng&state=s_review&q=needle&ready=1&label=lab_a&label=lab_b`,
					params
				)
			)) as { filters: Record<string, unknown> };
			const scope = {
				...(projectId ? { projectId } : {}),
				workflow: 'wf_eng',
				state: 's_review',
				hideDuplicates: true,
				ready: true,
				q: 'needle',
				labels: ['lab_a', 'lab_b']
			};

			expect(result.filters).toMatchObject({ workflow: 'wf_eng', state: 's_review' });
			expect(mocks.countIssuesByCategory).toHaveBeenCalledWith({}, 'usr_test', scope);
			expect(mocks.listIssues).toHaveBeenCalledWith(
				{},
				'usr_test',
				{ ...scope, category: undefined, hideDone: false, brief: true },
				expect.objectContaining({ limit: 100 })
			);
		}
	);

	it.each([
		['all issues', loadIssues, 'https://example.test/issues', {}, undefined],
		[
			'project issues',
			loadProject,
			'https://example.test/projects/prj_test',
			{ id: 'prj_test' },
			'prj_test'
		]
	] as const)(
		'parses duplicate visibility consistently for %s',
		async (_name, load, baseUrl, params, projectId) => {
			for (const [query, showDuplicates] of [
				['', false],
				['?duplicates=1', true],
				['?duplicates=0', false],
				['?duplicates=true', false]
			] as const) {
				vi.clearAllMocks();
				mocks.listIssues.mockResolvedValue({ items: [], hasMore: false });
				mocks.countIssuesByCategory.mockResolvedValue({
					backlog: 0,
					active: 0,
					awaiting_human: 0,
					done: 0
				});
				mocks.resolveFocus.mockResolvedValue({ focusId: null, lastProjectId: null });
				mocks.getProject.mockResolvedValue({ id: 'prj_test', name: 'Test project' });
				const result = (await callLoad(load, event(`${baseUrl}${query}`, params))) as {
					filters: { showDuplicates: boolean };
				};
				const scope = {
					...(projectId ? { projectId } : {}),
					workflow: undefined,
					state: undefined,
					hideDuplicates: !showDuplicates,
					ready: false,
					q: undefined,
					labels: []
				};
				expect(result.filters.showDuplicates).toBe(showDuplicates);
				expect(mocks.countIssuesByCategory).toHaveBeenCalledWith({}, 'usr_test', scope);
				expect(mocks.listIssues).toHaveBeenCalledWith(
					{},
					'usr_test',
					{ ...scope, category: undefined, hideDone: true, brief: true },
					expect.objectContaining({ limit: 100 })
				);
			}
		}
	);

	it.each([
		['workflow only', '?workflow=wf_eng', true],
		['explicit state', '?workflow=wf_eng&state=s_review', false],
		['category', '?workflow=wf_eng&category=done', false],
		['show done', '?workflow=wf_eng&done=1', false]
	])('keeps established hide-done behavior for %s', async (_name, query, hideDone) => {
		await callLoad(loadIssues, event(`https://example.test/issues${query}`));
		expect(mocks.listIssues).toHaveBeenCalledWith(
			{},
			'usr_test',
			expect.objectContaining({ workflow: 'wf_eng', hideDone }),
			expect.anything()
		);
	});

	it('preserves workflow and state while clearing a stale bounded focus page', async () => {
		mocks.resolveFocus.mockResolvedValue({ focusId: 'prj_new', lastProjectId: null });
		const cursor = encodeCursor(42, 'iss_boundary');
		await expect(
			callLoad(
				loadIssues,
				event(
					`https://example.test/issues?workflow=wf_eng&state=s_review&after=${cursor}&page_scope=prj_old`
				)
			)
		).rejects.toMatchObject({
			status: 303,
			location: '/issues?workflow=wf_eng&state=s_review'
		});
	});
});
