import { describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { createTestDb, type TestDb } from './test-db';
import { TEST_NOOP_DISPATCH_EFFECTS } from './test-dispatch-effects';
import { requireActor, sessionActor, sha256Hex } from './core';
import { createComment, createIssue, transitionIssue } from './issues';
import { createContextItem, updateContextItem } from './context';
import { loadWorkflow, setStateRunScope } from './workflows';
import {
	ENG_STATES,
	OPEN,
	PROJECT,
	REVIEW,
	USER,
	addEngineeringWorkflow,
	addIssue,
	addRun,
	addRunKey,
	addRunner,
	seedBase
} from '../supervisor/test-fixtures';

const BEARER = 'run-scope-test-key';

/** A running run on its own issue, with a real bearer, both issues in Open. */
async function setup() {
	const t = createTestDb();
	seedBase(t);
	const own = addIssue(t, { state: OPEN, title: 'Triage run' });
	const other = addIssue(t, { state: OPEN, title: 'Stale request' });
	const runnerId = addRunner(t);
	const runId = addRun(t, { issueId: own, runnerId, status: 'running', stateAtStart: OPEN });
	const keyId = addRunKey(t, runId);
	t.sqlite.prepare('UPDATE api_key SET key_hash = ?, permissions = ? WHERE id = ?').run(
		await sha256Hex(BEARER),
		JSON.stringify({
			version: 1,
			projects: { access: 'write', scope: [PROJECT] },
			workspace: 'write',
			control_plane: 'read'
		}),
		keyId
	);
	return { t, own, other };
}

function scope(t: TestDb, stateId: string, runScope: string) {
	t.sqlite.prepare('UPDATE workflow_state SET run_scope = ? WHERE id = ?').run(runScope, stateId);
}

function runActor(t: TestDb) {
	const url = new URL('http://test/api/v1/anything');
	return requireActor({
		locals: {},
		platform: { env: t.env, ctx: { waitUntil: () => {} } },
		request: new Request(url, { headers: { authorization: `Bearer ${BEARER}` } }),
		url
	} as unknown as RequestEvent);
}

const forbidden = (reason: string) => ({
	status: 403,
	code: 'run_key_forbidden',
	details: expect.objectContaining({ reason })
});

describe('run scope', () => {
	it('loads the launch state scope onto the run key, read per request', async () => {
		const { t } = await setup();
		expect((await runActor(t)).runRestriction?.scope).toBe('issue');
		scope(t, OPEN, 'project');
		expect((await runActor(t)).runRestriction?.scope).toBe('project');
	});

	it('keeps an own-issue run off other issues, and lets a project run work them', async () => {
		const { t, other } = await setup();
		const narrow = await runActor(t);
		await expect(createComment(t.db, t.env, narrow, other, { body: 'no' })).rejects.toMatchObject(
			forbidden('outside_run_issue')
		);
		await expect(
			transitionIssue(t.db, t.env, narrow, TEST_NOOP_DISPATCH_EFFECTS, other, {
				action: 'Abandon'
			})
		).rejects.toMatchObject(forbidden('outside_run_issue'));

		scope(t, OPEN, 'project');
		const wide = await runActor(t);
		await createComment(t.db, t.env, wide, other, { body: 'Already done in #278.' });
		await expect(
			transitionIssue(t.db, t.env, wide, TEST_NOOP_DISPATCH_EFFECTS, other, { action: 'Abandon' })
		).resolves.toMatchObject({ state: { name: 'Closed' } });
	});

	it("lets a project run rewrite another stage's journal but not shared prompts", async () => {
		const { t } = await setup();
		const owner = sessionActor({ id: USER, name: 'alice' });
		const journal = await createContextItem(t.db, t.env, owner, {
			kind: 'prompt',
			name: 'journal',
			body: '- old lesson',
			project_id: PROJECT,
			workflow_state_id: REVIEW
		});
		const prompt = await createContextItem(t.db, t.env, owner, {
			kind: 'prompt',
			name: 'instructions',
			body: 'Review carefully.',
			workflow_state_id: REVIEW
		});
		await expect(
			updateContextItem(t.db, t.env, await runActor(t), journal.id, { body: '- pruned' })
		).rejects.toMatchObject({ status: 403, code: 'run_key_forbidden' });

		scope(t, OPEN, 'project');
		const project = await runActor(t);
		await expect(
			updateContextItem(t.db, t.env, project, journal.id, { body: '- pruned' })
		).resolves.toMatchObject({ version: 2 });
		await expect(
			updateContextItem(t.db, t.env, project, prompt.id, { body: 'Rewritten' })
		).rejects.toMatchObject(forbidden('outside_run_issue'));

		scope(t, OPEN, 'workspace');
		const workspace = await runActor(t);
		await expect(
			updateContextItem(t.db, t.env, workspace, prompt.id, { body: 'Rewritten' })
		).resolves.toMatchObject({ version: 2 });
		// Env items stay fenced at every scope.
		await expect(
			createContextItem(t.db, t.env, workspace, {
				kind: 'env',
				name: 'TOKEN',
				value: 'x',
				project_id: PROJECT
			})
		).rejects.toMatchObject({ status: 403, code: 'run_key_forbidden' });
	});

	it('never lets a run put an issue into a stage that reaches further than its own', async () => {
		const { t, other } = await setup();
		scope(t, OPEN, 'project');
		scope(t, REVIEW, 'workspace');
		const run = await runActor(t);
		await expect(
			transitionIssue(t.db, t.env, run, TEST_NOOP_DISPATCH_EFFECTS, other, {
				action: 'Submit for review'
			})
		).rejects.toMatchObject(forbidden('run_scope_ceiling'));
		await expect(
			createIssue(t.db, t.env, run, TEST_NOOP_DISPATCH_EFFECTS, PROJECT, {
				title: 'Escalate me',
				state: REVIEW
			})
		).rejects.toMatchObject(forbidden('run_scope_ceiling'));
		// Same reach is fine.
		scope(t, REVIEW, 'project');
		await expect(
			transitionIssue(t.db, t.env, run, TEST_NOOP_DISPATCH_EFFECTS, other, {
				action: 'Submit for review'
			})
		).resolves.toMatchObject({ state: { id: REVIEW } });
	});

	it('is set only by the owner from a browser session, with an event', async () => {
		const { t } = await setup();
		addEngineeringWorkflow(t);
		const owner = sessionActor({ id: USER, name: 'alice' });
		const fullKey = { ...owner, viaSession: false, apiKeyId: 'key_full', bearerPresent: true };
		for (const actor of [fullKey, await runActor(t)])
			await expect(
				setStateRunScope(t.db, t.env, actor, 'wf_eng', ENG_STATES.impl, {
					run_scope: 'workspace'
				})
			).rejects.toMatchObject({ status: 403, code: 'run_scope_browser_required' });
		await expect(
			setStateRunScope(t.db, t.env, owner, 'wf_eng', ENG_STATES.impl, { run_scope: 'root' })
		).rejects.toMatchObject({ status: 422 });
		await expect(
			setStateRunScope(t.db, t.env, owner, 'wf_standard', OPEN, { run_scope: 'project' })
		).rejects.toMatchObject({ status: 403, code: 'workflow_read_only' });

		const updated = await setStateRunScope(t.db, t.env, owner, 'wf_eng', ENG_STATES.impl, {
			run_scope: 'project'
		});
		expect(updated.states.find((s) => s.id === ENG_STATES.impl)?.run_scope).toBe('project');
		expect((await loadWorkflow(t.db, USER, 'wf_eng')).states[0].run_scope).toBe('issue');
		expect(t.all("SELECT payload FROM event WHERE type = 'workflow.run_scope_changed'")).toEqual([
			{
				payload: expect.stringContaining('"previous_run_scope":"issue"')
			}
		]);
	});
});
