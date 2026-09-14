import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@tines/shared';
import { createTestDb } from '$lib/server/api/test-db';
import {
	addIssue,
	addRun,
	addRunner,
	NOW,
	OPEN,
	PROJECT,
	seedBase,
	setSettings,
	USER
} from '$lib/server/supervisor/test-fixtures';
import { load } from './agents/+page.server';

const loadStageStats = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/api/supervisor', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/api/supervisor')>()),
	loadStageStats
}));

const project: Project = {
	id: PROJECT,
	name: 'demo',
	description: '',
	default_workflow_id: null,
	created_at: NOW,
	updated_at: NOW,
	issue_count: 1,
	archived_at: null
};

function fixture() {
	const t = createTestDb();
	seedBase(t);
	setSettings(t);
	const runnerId = addRunner(t);
	const issueId = addIssue(t, { id: 'iss_agents_loader' });
	addRun(t, { id: 'arun_agents_loader', issueId, runnerId, stateAtStart: OPEN });
	t.sqlite.exec(`
		INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
		VALUES ('foreign-user', 'bob', 'bob@test', 1, ${NOW}, ${NOW});
		INSERT INTO project (id, user_id, name, created_at, updated_at)
		VALUES ('foreign-project', 'foreign-user', 'foreign', ${NOW}, ${NOW});
	`);
	return t;
}

function event(t: ReturnType<typeof fixture>, query = '') {
	return {
		locals: {
			user: {
				id: USER,
				name: 'alice',
				email: 'a@example.com',
				emailVerified: true,
				createdAt: new Date(NOW),
				updatedAt: new Date(NOW)
			}
		},
		platform: { env: t.env },
		url: new URL(`http://test/agents${query}`),
		parent: async () => ({
			user: {},
			projects: [project],
			archivedProjects: [],
			focus: null,
			lastProjectId: null
		})
	} as unknown as Parameters<typeof load>[0];
}

describe('agents page loader', () => {
	it.each(['', '?agents_view=spend'])(
		'does not compute or serialize weekly analytics for %s',
		async (query) => {
			loadStageStats.mockClear();
			const result = (await load(event(fixture(), query)))!;
			expect(loadStageStats).not.toHaveBeenCalled();
			expect(result).not.toHaveProperty('stats');
		}
	);

	it('returns resolved Board project metadata and state-filtered runs', async () => {
		const result = (await load(event(fixture(), `?project=demo&runs_state=${OPEN}`)))!;
		expect(result.boardProject).toBe(PROJECT);
		expect(result.boardProjectName).toBe('demo');
		expect(result.displayRuns.map((run: { id: string }) => run.id)).toEqual(['arun_agents_loader']);
	});

	it('keeps All projects lightweight and ignores the one-shot rule project', async () => {
		const all = (await load(event(fixture())))!;
		expect(all).toMatchObject({ boardProject: null, boardProjectName: null });
		const rule = (await load(event(fixture(), '?new=rule&project=missing')))!;
		expect(rule).toMatchObject({ boardProject: null, boardProjectName: null });
	});

	it.each(['missing', 'foreign-project'])(
		'rejects an unavailable Board project (%s)',
		async (selected) => {
			await expect(load(event(fixture(), `?project=${selected}`))).rejects.toMatchObject({
				status: 404
			});
		}
	);
});
