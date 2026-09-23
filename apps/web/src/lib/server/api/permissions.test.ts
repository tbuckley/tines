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
		expect(() =>
			requireAccess(run, [], 'context.create', {
				projectId: 'prj_a',
				issueId: 'iss_a'
			})
		).toThrow(
			expect.objectContaining({
				code: 'run_key_forbidden',
				details: expect.objectContaining({ reason: 'context_not_issue_scoped' })
			})
		);
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
