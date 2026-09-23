import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '$lib/server/api/test-db';
import { ApiFail, type ActorContext } from '$lib/server/api/core';
import { createStateRetirementInventory } from './inventory';
import {
	acquireStateRetirementHold,
	applyStateRetirement,
	prepareStateRetirement
} from './service';

const actor: ActorContext = {
	userId: 'hold-u1',
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
		VALUES ('hold-u1', 'Alice', 'alice-hold@example.com', 1, 1, 1);
		INSERT INTO workflow (id, user_id, name, description, initial_state_id, created_at, updated_at)
		VALUES ('hold-wf', 'hold-u1', 'Design', '', 'hold-root', 1, 1);
		INSERT INTO workflow_state
			(id, workflow_id, name, category, position, inherits_from_state_id, created_at)
		VALUES ('hold-root', 'hold-wf', 'Craft', 'active', 0, NULL, 1),
		       ('hold-child', 'hold-wf', 'Build', 'active', 1, 'hold-root', 2);
		INSERT INTO project (id, user_id, name, description, default_workflow_id, created_at, updated_at)
		VALUES ('hold-project', 'hold-u1', 'Tines', '', 'hold-wf', 1, 1);
		INSERT INTO issue
			(id, project_id, number, title, description, workflow_id, state_id,
			 state_entered_at, created_at, updated_at, project_assignment_token)
		VALUES ('hold-issue', 'hold-project', 1, 'Preserve', '', 'hold-wf', 'hold-child',
			1, 1, 1, 'assignment-1');
		INSERT INTO runner
			(id, user_id, type, name, status, max_concurrent, max_run_minutes, default_tier,
			 config, created_at, updated_at)
		VALUES ('hold-runner', 'hold-u1', 'local', 'Runner', 'active', 1, 30,
			'balanced', '{}', 1, 1);
		INSERT INTO agent_run
			(id, user_id, issue_id, runner_id, status, tier, state_id_at_start,
			 project_assignment_token, created_at)
		VALUES ('hold-run', 'hold-u1', 'hold-issue', 'hold-runner', 'running',
			'balanced', 'hold-root', 'assignment-1', 3);
	`);
});

async function reviewedRequest() {
	const inventory = await createStateRetirementInventory(t.db, actor, 100);
	return {
		inventory,
		request: {
			inventory_json: JSON.stringify(inventory),
			confirmation: { inventory_digest: inventory.inventory_digest }
		}
	};
}

describe('state retirement hold', () => {
	it('atomically holds the complete component and records every original pointer', async () => {
		const { request } = await reviewedRequest();
		const hold = await acquireStateRetirementHold(t.db, t.env, actor, request, 101);

		expect(hold).toMatchObject({
			created_at: 101,
			held_states: [
				{ state_id: 'hold-child', workflow_name: 'Design', state_name: 'Build' },
				{ state_id: 'hold-root', workflow_name: 'Design', state_name: 'Craft' }
			],
			active_runs: [{ id: 'hold-run', state_id_at_start: 'hold-root', status: 'running' }]
		});
		expect(
			await t.db.selectFrom('state_retirement_pointer').selectAll().executeTakeFirstOrThrow()
		).toMatchObject({
			hold_id: hold.id,
			child_state_id: 'hold-child',
			original_parent_state_id: 'hold-root',
			successful_receipt_id: null
		});
	});

	it('refuses stale inventory before writing a hold', async () => {
		const { request } = await reviewedRequest();
		t.sqlite.exec("UPDATE workflow_state SET name = 'Changed' WHERE id = 'hold-child'");
		const error = await acquireStateRetirementHold(t.db, t.env, actor, request).catch(
			(caught) => caught
		);

		expect(error).toBeInstanceOf(ApiFail);
		expect(error).toMatchObject({ status: 409, code: 'retirement_inventory_stale' });
		expect(await t.db.selectFrom('state_retirement_hold').selectAll().execute()).toEqual([]);
	});

	it('refuses a second active hold on any state in the component', async () => {
		const first = await reviewedRequest();
		await acquireStateRetirementHold(t.db, t.env, actor, first.request, 101);
		const second = await reviewedRequest();
		const error = await acquireStateRetirementHold(t.db, t.env, actor, second.request, 102).catch(
			(caught) => caught
		);

		expect(error).toBeInstanceOf(ApiFail);
		expect(error).toMatchObject({ status: 409, code: 'retirement_state_already_held' });
		expect(await t.db.selectFrom('state_retirement_hold').selectAll().execute()).toHaveLength(1);
	});

	it('refuses a run-key actor independently', async () => {
		const { request } = await reviewedRequest();
		const error = await acquireStateRetirementHold(
			t.db,
			t.env,
			{ ...actor, agentRunId: 'hold-run' },
			request
		).catch((caught) => caught);

		expect(error).toMatchObject({ status: 403, code: 'run_key_forbidden' });
	});

	it('does not sign while an affected run is still draining', async () => {
		const { inventory, request } = await reviewedRequest();
		const hold = await acquireStateRetirementHold(t.db, t.env, actor, request, 101);
		const error = await prepareStateRetirement(
			t.db,
			{ ...t.env, BETTER_AUTH_SECRET: 'retirement-test-secret' },
			actor,
			{ hold_id: hold.id },
			102
		).catch((caught) => caught);
		expect(error).toMatchObject({ status: 409, code: 'retirement_active_runs' });
		expect(await t.db.selectFrom('state_retirement_receipt').selectAll().execute()).toEqual([]);
	});

	it('prepares, applies once, and recovers the durable receipt', async () => {
		t.sqlite.exec("DELETE FROM agent_run WHERE id = 'hold-run'");
		t.sqlite.exec(`
			INSERT INTO context_item
				(id,user_id,kind,name,description,project_id,workflow_state_id,label_id,issue_id,body,position,version,created_at,updated_at)
			VALUES ('root-prompt','hold-u1','prompt','instructions','root','hold-project','hold-root',NULL,NULL,'exact root bytes',0,1,1,1)
		`);
		const opActor = { ...actor, apiKeyId: null, viaSession: true };
		const base = Date.now();
		const inventory = await createStateRetirementInventory(t.db, opActor, base);
		const request = {
			inventory_json: JSON.stringify(inventory),
			confirmation: { inventory_digest: inventory.inventory_digest }
		};
		const hold = await acquireStateRetirementHold(t.db, t.env, opActor, request, base + 1);
		const signingEnv = { ...t.env, BETTER_AUTH_SECRET: 'retirement-test-secret' };
		const prepared = await prepareStateRetirement(
			t.db,
			signingEnv,
			opActor,
			{
				hold_id: hold.id,
				inventory_json: JSON.stringify(inventory)
			},
			base + 2
		);
		expect(prepared.plan_token).toMatch(/^srp1\./);
		const applyRequest = {
			plan_token: prepared.plan_token!,
			inventory_json: prepared.inventory_json,
			confirmation: { plan_digest: prepared.plan_digest }
		};
		const receipt = await applyStateRetirement(t.db, signingEnv, opActor, applyRequest, base + 3);
		expect(receipt).toMatchObject({
			version: 1,
			hold_id: hold.id,
			plan_digest: prepared.plan_digest
		});
		expect(receipt.cleared_pointers).toEqual([
			{ child_state_id: 'hold-child', parent_state_id: 'hold-root' }
		]);
		expect(
			t.all('SELECT inherits_from_state_id FROM workflow_state WHERE id = ?', 'hold-child')[0]
		).toEqual({ inherits_from_state_id: null });
		const recovered = await applyStateRetirement(t.db, signingEnv, opActor, applyRequest, base + 4);
		expect(recovered).toEqual(receipt);
		expect(t.all('SELECT id FROM state_retirement_receipt')).toHaveLength(1);
	});
});
