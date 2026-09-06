/**
 * The read-only gate in isolation: the predicate, its 422, and the drain
 * exemption that lets a run already under way finish its own issue.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
	OPEN,
	PROJECT,
	USER,
	addIssue,
	addRun,
	addRunner,
	seedBase
} from '../supervisor/test-fixtures';
import {
	archivedDate,
	assertProjectWritableById,
	assertWritable,
	issueProject,
	projectArchivedError
} from './archive';
import { ApiFail, type ActorContext } from './core';
import { createTestDb, type TestDb } from './test-db';

const ARCHIVED_AT = Date.parse('2026-09-05T11:22:33Z');

const session: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

let t: TestDb;

beforeEach(() => {
	t = createTestDb();
	seedBase(t);
});

/** A run on `issueId` plus the actor its run key resolves to. */
function runActor(issueId: string, status = 'running'): ActorContext {
	const runId = addRun(t, { issueId, runnerId: addRunner(t), status, stateAtStart: OPEN });
	return {
		userId: USER,
		userName: 'alice',
		apiKeyId: `key_${runId}`,
		apiKeyName: `run ${runId}`,
		viaSession: false,
		agentRunId: runId
	};
}

const live = { id: PROJECT, name: 'demo', archived_at: null };
const archived = { id: PROJECT, name: 'demo', archived_at: ARCHIVED_AT };

async function failure(fn: () => Promise<unknown>): Promise<ApiFail> {
	try {
		await fn();
	} catch (e) {
		if (e instanceof ApiFail) return e;
		throw e;
	}
	throw new Error('expected the call to throw');
}

describe('the archived-project 422', () => {
	it('quotes the project, the archive date and the command that undoes it', () => {
		const e = projectArchivedError(archived);
		expect(e.status).toBe(422);
		expect(e.code).toBe('project_archived');
		expect(e.message).toBe(
			'project "demo" is archived (since 2026-09-05); run `tines projects unarchive "demo"` to make changes'
		);
		expect(e.details).toEqual({
			project_id: PROJECT,
			project_name: 'demo',
			archived_at: ARCHIVED_AT,
			unarchive_command: 'tines projects unarchive "demo"'
		});
	});

	it('dates the archive by its UTC day', () => {
		expect(archivedDate(ARCHIVED_AT)).toBe('2026-09-05');
	});
});

describe('assertWritable', () => {
	it('passes a live project without touching the database', async () => {
		const seen = t.spyOnQueries();
		await expect(assertWritable(t.db, session, live)).resolves.toBeUndefined();
		expect(seen()).toEqual([]);
	});

	it('refuses a session actor on an archived project', async () => {
		const e = await failure(() => assertWritable(t.db, session, archived));
		expect(e.code).toBe('project_archived');
	});

	it('refuses a session actor even on an issue with an active run', async () => {
		const issue = addIssue(t);
		runActor(issue);
		const e = await failure(() => assertWritable(t.db, session, archived, { issueId: issue }));
		expect(e.code).toBe('project_archived');
	});

	for (const status of ['launching', 'assigned', 'running'] as const) {
		it(`exempts a ${status} run writing its own issue`, async () => {
			const issue = addIssue(t);
			const actor = runActor(issue, status);
			await expect(
				assertWritable(t.db, actor, archived, { issueId: issue })
			).resolves.toBeUndefined();
		});
	}

	it('refuses a run key writing another issue in the project', async () => {
		const own = addIssue(t);
		const other = addIssue(t);
		const actor = runActor(own);
		const e = await failure(() => assertWritable(t.db, actor, archived, { issueId: other }));
		expect(e.code).toBe('project_archived');
	});

	it('refuses a run key once its run has ended', async () => {
		const issue = addIssue(t);
		const actor = runActor(issue, 'completed');
		const e = await failure(() => assertWritable(t.db, actor, archived, { issueId: issue }));
		expect(e.code).toBe('project_archived');
	});

	it('refuses a run key on a project-level write (no issue to anchor on)', async () => {
		const issue = addIssue(t);
		const actor = runActor(issue);
		const e = await failure(() => assertWritable(t.db, actor, archived));
		expect(e.code).toBe('project_archived');
	});
});

describe('assertProjectWritableById', () => {
	it('passes for a live project of the actor', async () => {
		await expect(assertProjectWritableById(t.db, session, PROJECT)).resolves.toBeUndefined();
	});

	it('404s for a project that is not the actor’s', async () => {
		const e = await failure(() => assertProjectWritableById(t.db, session, 'prj_nope'));
		expect(e.status).toBe(404);
	});

	it('422s once the project is archived', async () => {
		t.sqlite.exec(`UPDATE project SET archived_at = ${ARCHIVED_AT} WHERE id = '${PROJECT}'`);
		const e = await failure(() => assertProjectWritableById(t.db, session, PROJECT));
		expect(e.code).toBe('project_archived');
	});
});

describe('issueProject', () => {
	it("reads an issue row's denormalised project columns", () => {
		expect(
			issueProject({ project_id: PROJECT, project_name: 'demo', project_archived_at: ARCHIVED_AT })
		).toEqual(archived);
	});
});
