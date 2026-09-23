import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '$lib/server/api/test-db';
import { ApiFail, type ActorContext } from '$lib/server/api/core';
import { createStateRetirementInventory } from './inventory';

const actor: ActorContext = {
	userId: 'retire-u1',
	userName: 'Alice',
	apiKeyId: 'key-1',
	apiKeyName: 'operator',
	viaSession: false,
	agentRunId: null
};

let t: TestDb;

beforeEach(() => {
	t = createTestDb();
	t.sqlite.exec(`
		INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
		VALUES ('retire-u1', 'Alice', 'alice-retire@example.com', 1, 1, 1);
		INSERT INTO workflow (id, user_id, name, description, initial_state_id, created_at, updated_at)
		VALUES ('retire-wf', 'retire-u1', 'Design', 'workflow bytes', 'retire-root', 1, 2);
		INSERT INTO workflow_state
			(id, workflow_id, name, category, position, inherits_from_state_id, created_at)
		VALUES ('retire-root', 'retire-wf', 'Craft', 'active', 0, NULL, 1),
		       ('retire-child', 'retire-wf', 'Build', 'active', 1, 'retire-root', 2);
		INSERT INTO project
			(id, user_id, name, description, default_workflow_id, created_at, updated_at)
		VALUES ('retire-project', 'retire-u1', 'Tines', '', 'retire-wf', 1, 1);
		INSERT INTO issue
			(id, project_id, number, title, description, workflow_id, state_id,
			 state_entered_at, created_at, updated_at, project_assignment_token)
		VALUES ('retire-issue', 'retire-project', 1, 'Preserve', '', 'retire-wf', 'retire-child',
			 1, 1, 1, 'assignment-1');
		INSERT INTO runner
			(id, user_id, type, name, status, max_concurrent, max_run_minutes, default_tier,
			 config, created_at, updated_at)
		VALUES ('retire-runner', 'retire-u1', 'local', 'Runner', 'active', 1, 30,
			 'balanced', '{}', 1, 1);
		INSERT INTO agent_run
			(id, user_id, issue_id, runner_id, status, tier, state_id_at_start,
			 project_assignment_token, created_at)
		VALUES ('retire-run', 'retire-u1', 'retire-issue', 'retire-runner', 'running',
			 'balanced', 'retire-root', 'assignment-1', 3);
		INSERT INTO context_item
			(id, user_id, kind, name, description, workflow_state_id, body,
			 position, version, created_at, updated_at)
		VALUES ('retire-prompt', 'retire-u1', 'prompt', 'instructions', 'exact description',
			 'retire-root', '  exact body\n', -2, 7, 3, 4),
		       ('retire-skill', 'retire-u1', 'skill', 'preserve-skill', 'skill description',
			 'retire-root', NULL, -1, 3, 3, 4),
		       ('retire-repo', 'retire-u1', 'repo', 'source', 'repo description',
			 'retire-root', NULL, 0, 2, 3, 4);
		UPDATE context_item SET repo_url = 'https://github.com/example/repo.git',
			repo_branch = 'main', repo_dir = 'repo-dir' WHERE id = 'retire-repo';
		INSERT INTO context_item_file
			(id, context_item_id, path, content, created_at, updated_at)
		VALUES ('retire-file', 'retire-skill', 'SKILL.md', '# exact skill\n', 3, 4);
	`);
});

describe.skip('state retirement inventory (Release A historical fixture)', () => {
	it('captures pointer chains, exact payloads, files, repositories, and active root runs', async () => {
		const inventory = await createStateRetirementInventory(t.db, actor, 1234);

		expect(inventory).toMatchObject({
			version: 1,
			owner_id: 'retire-u1',
			captured_at: 1234,
			diagnostics: [],
			pointers: [
				{
					child_state_id: 'retire-child',
					parent_state_id: 'retire-root',
					chain: ['retire-child', 'retire-root']
				}
			]
		});
		expect(inventory.inventory_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(inventory.topology_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(inventory.witness.context_items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: 'retire-prompt',
					body: '  exact body\n',
					position: -2,
					version: 7
				}),
				expect.objectContaining({
					id: 'retire-repo',
					repo_url: 'https://github.com/example/repo.git',
					repo_branch: 'main',
					repo_dir: 'repo-dir'
				})
			])
		);
		expect(inventory.witness.context_files).toContainEqual(
			expect.objectContaining({
				context_item_id: 'retire-skill',
				path: 'SKILL.md',
				content: '# exact skill\n'
			})
		);
		expect(inventory.witness.active_runs).toContainEqual(
			expect.objectContaining({ id: 'retire-run', state_id_at_start: 'retire-root' })
		);
	});

	it('changes its digest for late payload edits without changing topology', async () => {
		const before = await createStateRetirementInventory(t.db, actor, 1234);
		t.sqlite.exec(
			"UPDATE context_item SET body = body || 'late append', version = version + 1 WHERE id = 'retire-prompt'"
		);
		const after = await createStateRetirementInventory(t.db, actor, 1235);

		expect(after.inventory_digest).not.toBe(before.inventory_digest);
		expect(after.topology_digest).toBe(before.topology_digest);
	});

	it('independently refuses a run-key actor', async () => {
		const error = await createStateRetirementInventory(t.db, {
			...actor,
			agentRunId: 'retire-run'
		}).catch((caught) => caught);

		expect(error).toBeInstanceOf(ApiFail);
		expect(error).toMatchObject({ status: 403, code: 'run_key_forbidden' });
	});
});
