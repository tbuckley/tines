import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeCursor } from '$lib/server/api/core';

const mocks = vi.hoisted(() => ({
	listIssues: vi.fn(),
	resolveFocus: vi.fn(),
	setFocus: vi.fn(),
	getProject: vi.fn()
}));

vi.mock('$lib/server/db', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/api/issues', () => ({
	listIssues: mocks.listIssues,
	countIssuesByCategory: vi.fn(async () => ({
		backlog: 0,
		active: 0,
		awaiting_human: 0,
		done: 0
	}))
}));
vi.mock('$lib/server/api/preferences', () => ({
	resolveFocus: mocks.resolveFocus,
	setFocus: mocks.setFocus
}));
vi.mock('$lib/server/api/projects', () => ({
	getProject: mocks.getProject,
	listProjects: vi.fn(async () => [])
}));
vi.mock('$lib/server/api/labels', () => ({ listLabels: vi.fn(async () => []) }));
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
		mocks.resolveFocus.mockResolvedValue({ focusId: null, lastProjectId: null });
		mocks.getProject.mockResolvedValue({ id: 'prj_test', name: 'Test project' });
	});

	it('resets a bounded all-issues page when its recorded focus no longer matches', async () => {
		mocks.resolveFocus.mockResolvedValue({ focusId: 'prj_new', lastProjectId: null });
		const cursor = encodeCursor(42, 'iss_boundary');

		await expect(
			callLoad(
				loadIssues,
				event(`https://example.test/issues?q=needle&after=${cursor}&page_scope=prj_old`)
			)
		).rejects.toMatchObject({ status: 303, location: '/issues?q=needle' });
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
});
