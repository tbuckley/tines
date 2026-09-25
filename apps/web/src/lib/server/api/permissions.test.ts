import { FULL_API_KEY_PERMISSIONS, parseApiKeyPermissions } from '@tines/shared';
import { describe, expect, it } from 'vitest';
import type { ActorContext } from './core';
import { projectReadPredicate, requireAccess } from './permissions';
import { createTestDb } from './test-db';

const session: ActorContext = {
	userId: 'u1',
	userName: 'Alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true,
	permissions: FULL_API_KEY_PERMISSIONS,
	runRestriction: null
};

const scoped: ActorContext = {
	...session,
	apiKeyId: 'key_1',
	apiKeyName: 'scoped',
	viaSession: false,
	permissions: parseApiKeyPermissions({
		projects: { access: 'write', scope: ['prj_a'] },
		workspace: 'read',
		control_plane: 'none'
	})
};

describe('requireAccess', () => {
	it('checks independently required domains', () => {
		expect(() =>
			requireAccess(
				scoped,
				[
					{ domain: 'project', access: 'write', projectId: 'prj_a' },
					{ domain: 'workspace', access: 'read' }
				],
				'issue.update',
				{ projectId: 'prj_a' }
			)
		).not.toThrow();
		expect(() =>
			requireAccess(
				scoped,
				[
					{ domain: 'project', access: 'write', projectId: 'prj_a' },
					{ domain: 'control_plane', access: 'write' }
				],
				'issue.pin',
				{ projectId: 'prj_a' }
			)
		).toThrow(expect.objectContaining({ code: 'insufficient_permissions' }));
	});

	it('never treats a missing policy on a key actor as full authority', () => {
		expect(() =>
			requireAccess(
				{ ...scoped, permissions: undefined },
				[{ domain: 'project', access: 'read', projectId: 'prj_a' }],
				'project.read'
			)
		).toThrow(expect.objectContaining({ code: 'missing_actor_permissions' }));
	});

	it('applies the independent run project and operation ceiling', () => {
		const run: ActorContext = {
			...scoped,
			agentRunId: 'run_1',
			runRestriction: {
				policy: 'run-v1',
				runId: 'run_1',
				issueId: 'iss_a',
				projectId: 'prj_a',
				launchStateId: 'wfs_a'
			}
		};
		expect(() =>
			requireAccess(
				run,
				[{ domain: 'project', access: 'read', projectId: 'prj_b' }],
				'project.read',
				{ projectId: 'prj_b' }
			)
		).toThrow(expect.objectContaining({ code: 'run_key_forbidden' }));
		expect(() => requireAccess(run, [], 'api_key.create', { projectId: 'prj_a' })).toThrow(
			expect.objectContaining({ code: 'run_key_forbidden' })
		);
	});

	it('allows run-key context reads in its project without a mutation marker, subject to stored domains', () => {
		const run: ActorContext = {
			...scoped,
			agentRunId: 'run_1',
			runRestriction: {
				policy: 'run-v1',
				runId: 'run_1',
				issueId: 'iss_a',
				projectId: 'prj_a',
				launchStateId: 'wfs_a'
			}
		};
		const contextRequirements = [
			{ domain: 'project', access: 'read', projectId: 'prj_a' },
			{ domain: 'workspace', access: 'read' }
		] as const;
		for (const issueId of ['iss_a', 'iss_other']) {
			expect(() =>
				requireAccess(run, contextRequirements, 'context.read', { projectId: 'prj_a', issueId })
			).not.toThrow();
		}
		expect(() =>
			requireAccess(
				run,
				[{ domain: 'project', access: 'read', projectId: 'prj_b' }],
				'context.read',
				{ projectId: 'prj_b', issueId: 'iss_b' }
			)
		).toThrow(
			expect.objectContaining({
				code: 'run_key_forbidden',
				details: expect.objectContaining({ reason: 'outside_run_project' })
			})
		);
		const insufficient = (domain: string) =>
			expect.objectContaining({
				code: 'insufficient_permissions',
				details: expect.objectContaining({ domain })
			});
		expect(() =>
			requireAccess(
				{
					...run,
					permissions: parseApiKeyPermissions({
						...run.permissions!,
						projects: { access: 'read', scope: ['prj_b'] }
					})
				},
				contextRequirements,
				'context.read',
				{ projectId: 'prj_a', issueId: 'iss_a' }
			)
		).toThrow(insufficient('project'));
		expect(() =>
			requireAccess(
				{ ...run, permissions: parseApiKeyPermissions({ ...run.permissions!, workspace: 'none' }) },
				contextRequirements,
				'context.read',
				{ projectId: 'prj_a', issueId: 'iss_a' }
			)
		).toThrow(insufficient('workspace'));
		const promptRequirements = [
			...contextRequirements,
			{ domain: 'control_plane', access: 'read' }
		] as const;
		expect(() =>
			requireAccess(run, promptRequirements, 'context.read', {
				projectId: 'prj_a',
				issueId: 'iss_a'
			})
		).toThrow(insufficient('control_plane'));
		expect(() =>
			requireAccess(run, contextRequirements, 'context.read', {
				projectId: 'prj_a',
				issueId: 'iss_a'
			})
		).not.toThrow();
	});

	it('binds every existing-issue context and link mutation to the run issue', () => {
		const run: ActorContext = {
			...scoped,
			agentRunId: 'run_1',
			permissions: FULL_API_KEY_PERMISSIONS,
			runRestriction: {
				policy: 'run-v1',
				runId: 'run_1',
				issueId: 'iss_a',
				projectId: 'prj_a',
				launchStateId: 'wfs_a'
			}
		};
		for (const operation of [
			'context.create',
			'context.update',
			'context.append',
			'context.delete',
			'issue_link.create',
			'issue_link.remove'
		]) {
			const issueTarget = {
				projectId: 'prj_a',
				issueId: 'iss_a',
				...(operation.startsWith('context.') ? { issueScoped: true } : {})
			};
			expect(() => requireAccess(run, [], operation, issueTarget)).not.toThrow();
			expect(() =>
				requireAccess(run, [], operation, {
					projectId: 'prj_a',
					issueId: 'iss_other'
				})
			).toThrow(expect.objectContaining({ code: 'run_key_forbidden' }));
			expect(() => requireAccess(run, [], operation, { projectId: 'prj_a' })).toThrow(
				expect.objectContaining({ code: 'run_key_forbidden' })
			);
		}
		for (const operation of [
			'context.create',
			'context.update',
			'context.append',
			'context.delete'
		]) {
			for (const issueScoped of [undefined, false]) {
				expect(() =>
					requireAccess(run, [], operation, { projectId: 'prj_a', issueId: 'iss_a', issueScoped })
				).toThrow(
					expect.objectContaining({
						code: 'run_key_forbidden',
						details: expect.objectContaining({ reason: 'context_not_issue_scoped' })
					})
				);
			}
			expect(() =>
				requireAccess(run, [], operation, {
					projectId: 'prj_a',
					issueId: 'iss_other',
					issueScoped: true
				})
			).toThrow(
				expect.objectContaining({
					code: 'run_key_forbidden',
					details: expect.objectContaining({ reason: 'outside_run_issue' })
				})
			);
		}
	});

	it('never lets a run key satisfy an all-projects requirement', () => {
		const run: ActorContext = {
			...session,
			apiKeyId: 'key_run',
			viaSession: false,
			agentRunId: 'run_1',
			runRestriction: {
				policy: 'run-v1',
				runId: 'run_1',
				issueId: 'iss_a',
				projectId: 'prj_a',
				launchStateId: 'wfs_a'
			}
		};
		expect(() =>
			requireAccess(run, [{ domain: 'project', access: 'read', scope: 'all' }], 'library.prepare')
		).toThrow(expect.objectContaining({ code: 'insufficient_permissions' }));
	});
});

describe('projectReadPredicate', () => {
	it('filters in SQL using one JSON-bound scope', async () => {
		const t = createTestDb();
		const now = Date.now();
		t.sqlite.exec(`
			INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
			VALUES ('u1', 'Alice', 'alice@example.com', 1, ${now}, ${now});
			INSERT INTO project (id, user_id, name, description, created_at, updated_at)
			VALUES ('prj_a', 'u1', 'A', '', ${now}, ${now}), ('prj_b', 'u1', 'B', '', ${now}, ${now});
		`);
		const rows = await t.db
			.selectFrom('project')
			.select('id')
			.where(projectReadPredicate(scoped, 'project.id'))
			.execute();
		expect(rows).toEqual([{ id: 'prj_a' }]);
	});
});

describe('run scope', () => {
	const runAt = (scope: 'issue' | 'project' | 'workspace' | undefined): ActorContext => ({
		...session,
		apiKeyId: 'key_run',
		apiKeyName: 'run',
		viaSession: false,
		agentRunId: 'run_1',
		permissions: parseApiKeyPermissions({
			projects: { access: 'write', scope: ['prj_a'] },
			workspace: 'write',
			control_plane: 'read'
		}),
		runRestriction: {
			policy: 'run-v1',
			runId: 'run_1',
			issueId: 'iss_a',
			projectId: 'prj_a',
			launchStateId: 'wfs_a',
			...(scope ? { scope } : {})
		}
	});
	const write = [{ domain: 'project', access: 'write', projectId: 'prj_a' }] as const;
	const reason = (why: string) =>
		expect.objectContaining({
			code: 'run_key_forbidden',
			details: expect.objectContaining({ reason: why })
		});

	it('keeps the default scope on the run issue', () => {
		for (const run of [runAt(undefined), runAt('issue')]) {
			expect(() =>
				requireAccess(run, write, 'issue.transition', { projectId: 'prj_a', issueId: 'iss_a' })
			).not.toThrow();
			for (const op of ['issue.transition', 'comment.create', 'issue.update', 'label.assign'])
				expect(() =>
					requireAccess(run, write, op, { projectId: 'prj_a', issueId: 'iss_other' })
				).toThrow(reason('outside_run_issue'));
			expect(() => requireAccess(run, [], 'context.update', { issueScoped: false })).toThrow(
				reason('outside_run_issue')
			);
			expect(() => requireAccess(run, [], 'workflow.update')).toThrow(
				reason('operation_forbidden')
			);
		}
	});

	it('lets a project-scope run write any issue in its project, and nothing outside it', () => {
		const run = runAt('project');
		for (const op of ['issue.transition', 'comment.create', 'issue.update', 'issue_link.create'])
			expect(() =>
				requireAccess(run, write, op, { projectId: 'prj_a', issueId: 'iss_other' })
			).not.toThrow();
		expect(() =>
			requireAccess(
				run,
				[{ domain: 'project', access: 'write', projectId: 'prj_b' }],
				'issue.transition',
				{ projectId: 'prj_b', issueId: 'iss_b' }
			)
		).toThrow(reason('outside_run_project'));
		// Shared (non-issue) context and the library stay out of reach.
		expect(() => requireAccess(run, [], 'context.update', { issueScoped: false })).toThrow(
			reason('outside_run_issue')
		);
		expect(() => requireAccess(run, [], 'workflow.update')).toThrow(reason('operation_forbidden'));
	});

	it('lets a workspace-scope run edit shared context, workflows and labels, never the control plane', () => {
		const run = runAt('workspace');
		const workspace = [{ domain: 'workspace', access: 'write' }] as const;
		for (const op of [
			'context.update',
			'context.create',
			'workflow.create',
			'workflow.update',
			'label.create'
		])
			expect(() => requireAccess(run, workspace, op, { issueScoped: false })).not.toThrow();
		expect(() =>
			requireAccess(run, write, 'issue.transition', { projectId: 'prj_a', issueId: 'iss_other' })
		).not.toThrow();
		// Deletes need workspace delete, which a run key's stored policy never grants.
		expect(() =>
			requireAccess(run, [{ domain: 'workspace', access: 'delete' }], 'workflow.update')
		).toThrow(expect.objectContaining({ code: 'insufficient_permissions' }));
		for (const op of [
			'workflow.delete',
			'label.delete',
			'runner.update',
			'api_key.create',
			'library.import'
		])
			expect(() => requireAccess(run, [], op)).toThrow(reason('operation_forbidden'));
		expect(() =>
			requireAccess(run, [{ domain: 'control_plane', access: 'write' }], 'label.assign', {
				projectId: 'prj_a',
				issueId: 'iss_a'
			})
		).toThrow(expect.objectContaining({ code: 'insufficient_permissions' }));
	});
});
