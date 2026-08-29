import { describe, expect, it } from 'vitest';
import { ApiFail } from './core';
import { resolveScope, scopeLabel, toContextScope, type ResolvedScope } from './scope';
import { createTestDb } from './test-db';

describe('scopeLabel', () => {
	it('renders set dimensions in project · state · issue order', () => {
		expect(
			scopeLabel({ projectName: 'Tines', stateName: 'Review', issueProjectName: 'Tines', issueNumber: 42 })
		).toBe('project Tines · state Review · issue Tines/42');
	});

	it('renders single dimensions without separators', () => {
		expect(scopeLabel({ projectName: 'Tines' })).toBe('project Tines');
		expect(scopeLabel({ stateName: 'Review' })).toBe('state Review');
		expect(scopeLabel({ issueProjectName: 'Tines', issueNumber: 7 })).toBe('issue Tines/7');
	});

	it('labels the empty scope "global"', () => {
		expect(scopeLabel({})).toBe('global');
	});

	it('falls back to the id for a set dimension whose name is unknown', () => {
		expect(scopeLabel({ projectId: 'prj_1', workflowStateId: 'wfs_1' })).toBe(
			'project prj_1 · state wfs_1'
		);
		expect(scopeLabel({ projectId: 'prj_1', projectName: 'Tines' })).toBe('project Tines');
		expect(scopeLabel({ issueId: 'iss_1' })).toBe('issue iss_1');
		// A dangling reference never reads as "global".
		expect(scopeLabel({ projectId: 'prj_gone' })).not.toBe('global');
	});
});

describe('toContextScope', () => {
	const base: ResolvedScope = {
		projectId: null,
		workflowStateId: null,
		issueId: null,
		projectName: null,
		stateName: null,
		workflowId: null,
		workflowName: null,
		issueNumber: null,
		issueProjectName: null,
		issueProjectId: null
	};

	it('serializes the wire shape, including the issue ref and the label', () => {
		expect(
			toContextScope({
				...base,
				projectId: 'prj_1',
				projectName: 'Tines',
				workflowStateId: 'wfs_1',
				stateName: 'Review',
				workflowId: 'wf_1',
				workflowName: 'Engineering',
				issueId: 'iss_1',
				issueNumber: 42,
				issueProjectName: 'Tines',
				issueProjectId: 'prj_1'
			})
		).toEqual({
			project_id: 'prj_1',
			project_name: 'Tines',
			workflow_state_id: 'wfs_1',
			workflow_state_name: 'Review',
			workflow_id: 'wf_1',
			workflow_name: 'Engineering',
			issue_id: 'iss_1',
			issue_ref: { project_name: 'Tines', number: 42 },
			label: 'project Tines · state Review · issue Tines/42'
		});
	});

	it('is "global" with a null issue ref for the empty scope', () => {
		expect(toContextScope(base)).toMatchObject({ issue_ref: null, label: 'global' });
	});
});

describe('resolveScope', () => {
	const now = 1_723_000_000_000;

	function seed() {
		const t = createTestDb();
		t.sqlite.exec(`
			INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES
				('u1', 'alice', 'a@example.com', 1, ${now}, ${now}),
				('u2', 'bob', 'b@example.com', 1, ${now}, ${now});
			INSERT INTO project (id, user_id, name, created_at, updated_at) VALUES
				('prj_alice', 'u1', 'acme', ${now}, ${now}),
				('prj_other', 'u1', 'other', ${now}, ${now}),
				('prj_bob', 'u2', 'bobs', ${now}, ${now});
			INSERT INTO workflow (id, user_id, name, description, initial_state_id, created_at, updated_at)
				VALUES ('wf_alice', 'u1', 'Engineering', '', 'wfs_alice_impl', ${now}, ${now});
			INSERT INTO workflow_state (id, workflow_id, name, category, position, created_at) VALUES
				('wfs_alice_impl', 'wf_alice', 'Implementation', 'active', 0, ${now});
			INSERT INTO issue (id, project_id, number, title, workflow_id, state_id, created_at, updated_at)
				VALUES ('iss_1', 'prj_alice', 7, 'a bug', 'wf_standard', 'wfs_std_open', ${now}, ${now});
		`);
		return t;
	}

	const empty = { projectId: null, workflowStateId: null, issueId: null };

	it('accepts the empty scope', async () => {
		const t = seed();
		expect(await resolveScope(t.db, 'u1', empty)).toMatchObject({
			projectId: null,
			projectName: null,
			stateName: null
		});
	});

	it('denormalizes the names of every set dimension', async () => {
		const t = seed();
		const scope = await resolveScope(t.db, 'u1', {
			projectId: 'prj_alice',
			workflowStateId: 'wfs_std_open',
			issueId: 'iss_1'
		});
		expect(scopeLabel(scope)).toBe('project acme · state Open · issue acme/7');
		expect(scope).toMatchObject({
			projectName: 'acme',
			stateName: 'Open',
			workflowId: 'wf_standard',
			workflowName: 'Standard',
			issueNumber: 7,
			issueProjectName: 'acme',
			issueProjectId: 'prj_alice'
		});
	});

	it('rejects a project that does not exist or is not the user’s', async () => {
		const t = seed();
		for (const projectId of ['prj_nope', 'prj_bob']) {
			await expect(
				resolveScope(t.db, 'u1', { ...empty, projectId })
			).rejects.toMatchObject({ status: 422, code: 'unknown_project', details: { field: 'project_id' } });
		}
	});

	it('rejects a state that does not exist or belongs to another user’s workflow', async () => {
		const t = seed();
		t.sqlite.exec(`
			INSERT INTO workflow (id, user_id, name, description, initial_state_id, created_at, updated_at)
				VALUES ('wf_bob', 'u2', 'Bobs', '', 'wfs_bob', ${now}, ${now});
			INSERT INTO workflow_state (id, workflow_id, name, category, position, created_at)
				VALUES ('wfs_bob', 'wf_bob', 'Doing', 'active', 0, ${now});
		`);
		for (const workflowStateId of ['wfs_nope', 'wfs_bob']) {
			await expect(
				resolveScope(t.db, 'u1', { ...empty, workflowStateId })
			).rejects.toMatchObject({
				status: 422,
				code: 'unknown_state',
				details: { field: 'workflow_state_id' }
			});
		}
	});

	it('accepts states from the system standard workflow and from the user’s own', async () => {
		const t = seed();
		expect(
			await resolveScope(t.db, 'u1', { ...empty, workflowStateId: 'wfs_std_open' })
		).toMatchObject({ stateName: 'Open', workflowName: 'Standard' });
		expect(
			await resolveScope(t.db, 'u1', { ...empty, workflowStateId: 'wfs_alice_impl' })
		).toMatchObject({ stateName: 'Implementation', workflowName: 'Engineering' });
	});

	it('rejects a non-active state only when requireActiveState is set', async () => {
		const t = seed();
		// Human Review (awaiting_human) and Closed (done) in the standard workflow.
		for (const workflowStateId of ['wfs_std_review', 'wfs_std_closed']) {
			expect(await resolveScope(t.db, 'u1', { ...empty, workflowStateId })).toMatchObject({
				workflowStateId
			});
			await expect(
				resolveScope(t.db, 'u1', { ...empty, workflowStateId }, { requireActiveState: true })
			).rejects.toMatchObject({ status: 422, code: 'state_not_dispatchable' });
		}
		// An active state passes the flag.
		expect(
			await resolveScope(
				t.db,
				'u1',
				{ ...empty, workflowStateId: 'wfs_std_open' },
				{ requireActiveState: true }
			)
		).toMatchObject({ stateName: 'Open' });
	});

	it('rejects an issue that does not exist or is not the user’s', async () => {
		const t = seed();
		await expect(resolveScope(t.db, 'u1', { ...empty, issueId: 'iss_nope' })).rejects.toMatchObject({
			status: 422,
			code: 'unknown_issue',
			details: { field: 'issue_id' }
		});
		await expect(resolveScope(t.db, 'u2', { ...empty, issueId: 'iss_1' })).rejects.toMatchObject({
			code: 'unknown_issue'
		});
	});

	it('rejects an issue that is not in the scoped project', async () => {
		const t = seed();
		await expect(
			resolveScope(t.db, 'u1', { ...empty, projectId: 'prj_other', issueId: 'iss_1' })
		).rejects.toMatchObject({ status: 422, code: 'scope_incoherent' });
	});

	it("rejects a state outside the issue's bound workflow", async () => {
		const t = seed();
		await expect(
			resolveScope(t.db, 'u1', { ...empty, workflowStateId: 'wfs_alice_impl', issueId: 'iss_1' })
		).rejects.toMatchObject({ status: 422, code: 'scope_incoherent' });
	});

	it('leaves the issue dimension unresolved when the caller has none', async () => {
		const t = seed();
		// Routing rules pass `{ issue: false }`; a rule scope has no issue id.
		const scope = await resolveScope(
			t.db,
			'u1',
			{ projectId: 'prj_alice', workflowStateId: null },
			{ issue: false, requireActiveState: true }
		);
		expect(scope).toMatchObject({ issueId: null, issueNumber: null, issueProjectName: null });
		expect(scopeLabel(scope)).toBe('project acme');
	});

	it('throws ApiFail, so the api() wrapper renders a structured 422', async () => {
		const t = seed();
		await expect(
			resolveScope(t.db, 'u1', { ...empty, projectId: 'prj_nope' })
		).rejects.toBeInstanceOf(ApiFail);
	});
});
