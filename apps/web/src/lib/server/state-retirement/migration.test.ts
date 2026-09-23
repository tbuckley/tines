import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '$lib/server/api/test-db';
import { type ActorContext, ApiFail } from '$lib/server/api/core';
import { createStateRetirementInventory } from './inventory';
import {
	acquireStateRetirementHold,
	applyStateRetirement,
	prepareStateRetirement,
	releaseStateRetirementHold
} from './service';

const migrationsDir = fileURLToPath(new URL('../../../../migrations/', import.meta.url));
const migrationName = '0033_state_retirement.sql';
const releaseBMigration = '0042_state_inheritance_retired.sql';

function preReleaseADb(): DatabaseSync {
	const db = new DatabaseSync(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	for (const file of readdirSync(migrationsDir).sort()) {
		// Main now has migrations after the original A filename. Model the
		// deployed ordering explicitly: all current-main migrations first, then
		// the colliding, already-applied A file.
		if (file === migrationName) continue;
		if (file > '0040_run_key_stage_snapshot.sql') continue;
		db.exec(readFileSync(`${migrationsDir}/${file}`, 'utf8'));
	}
	db.exec(readFileSync(`${migrationsDir}/${migrationName}`, 'utf8'));
	return db;
}

function seedPopulatedInheritance(db: DatabaseSync): void {
	db.exec(`
		INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
		VALUES ('u1', 'Alice', 'alice@example.com', 1, 1, 1);
		INSERT INTO workflow (id, user_id, name, description, initial_state_id, created_at, updated_at)
		VALUES ('wf1', 'u1', 'Craft', '', 'root', 1, 1);
		INSERT INTO workflow_state
			(id, workflow_id, name, category, position, inherits_from_state_id, created_at)
		VALUES ('root', 'wf1', 'Root', 'active', 0, NULL, 1),
		       ('child', 'wf1', 'Child', 'active', 1, 'root', 1);
		INSERT INTO project (id, user_id, name, description, default_workflow_id, created_at, updated_at)
		VALUES ('p1', 'u1', 'Project', '', 'wf1', 1, 1);
		INSERT INTO issue
			(id, project_id, number, title, description, workflow_id, state_id, created_at, updated_at)
		VALUES ('i1', 'p1', 1, 'Issue', '', 'wf1', 'child', 1, 1);
		INSERT INTO runner
			(id, user_id, type, name, status, max_concurrent, max_run_minutes, default_tier,
			 config, created_at, updated_at)
		VALUES ('r1', 'u1', 'local', 'Runner', 'active', 1, 30, 'balanced', '{}', 1, 1);
		INSERT INTO context_item
			(id, user_id, kind, name, description, project_id, workflow_state_id, label_id, issue_id,
			 body, position, version, created_at, updated_at)
		VALUES ('root-prompt', 'u1', 'prompt', 'instructions', '', NULL, 'root', NULL, NULL,
			 'Root guidance bytes', 0, 1, 1, 1),
		       ('root-journal', 'u1', 'prompt', 'journal', '', 'p1', 'root', NULL, NULL,
			 'Root journal bytes', 1, 1, 1, 1),
		       ('root-skill', 'u1', 'skill', 'review', '', NULL, 'root', NULL, NULL,
			 NULL, 2, 1, 1, 1),
		       ('root-repo', 'u1', 'repo', 'source', '', NULL, 'root', NULL, NULL,
			 NULL, 3, 1, 1, 1);
		UPDATE context_item SET repo_url = 'https://github.com/example/source.git',
			repo_branch = 'main', repo_dir = 'source' WHERE id = 'root-repo';
		INSERT INTO context_item_file
			(id, context_item_id, path, content, created_at, updated_at)
		VALUES ('root-skill-file', 'root-skill', 'SKILL.md', 'Root skill bytes', 1, 1);
	`);
}

function acquireHold(db: DatabaseSync): void {
	db.exec(`
		INSERT INTO state_retirement_hold
			(id, user_id, actor_key, topology_digest, inventory_digest, created_at)
		VALUES ('hold1', 'u1', 'session:u1', 'topology', 'inventory', 2);
		INSERT INTO state_retirement_hold_state
			(hold_id, user_id, state_id, workflow_name, state_name, state_category)
		VALUES ('hold1', 'u1', 'child', 'Craft', 'Child', 'active');
	`);
}

function applyReleaseB(db: DatabaseSync): void {
	db.exec(readFileSync(`${migrationsDir}/${releaseBMigration}`, 'utf8'));
}

const releaseAActor: ActorContext = {
	userId: 'u1',
	userName: 'Alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true,
	agentRunId: null
};

function preReleaseATestDb(): TestDb {
	return createTestDb({ excludeMigrations: [releaseBMigration] });
}

function releaseAEnv(t: TestDb): Env {
	return {
		...t.env,
		BETTER_AUTH_SECRET: 'native-release-a-test-secret',
		STATE_RETIREMENT_RELEASE: 'A'
	};
}

describe('state retirement Release A migration', () => {
	it('is additive and preserves populated inheritance before a hold exists', () => {
		const db = preReleaseADb();
		seedPopulatedInheritance(db);

		expect(
			db.prepare("SELECT inherits_from_state_id FROM workflow_state WHERE id = 'child'").get()
		).toEqual({ inherits_from_state_id: 'root' });
		db.exec(`
			INSERT INTO workflow_state
				(id, workflow_id, name, category, position, inherits_from_state_id, created_at)
			VALUES ('unheld', 'wf1', 'Unheld', 'active', 2, 'root', 2)
		`);
		expect(db.prepare("SELECT 1 FROM workflow_state WHERE id = 'unheld'").get()).toEqual({
			1: 1
		});
		expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
	});

	it('makes an active hold fail closed for old-worker run and pointer writes', () => {
		const db = preReleaseADb();
		seedPopulatedInheritance(db);
		acquireHold(db);

		// RAISE(IGNORE) gives an old claim the same zero-row CAS result as a lost race.
		db.exec(`
			INSERT INTO agent_run
				(id, user_id, issue_id, runner_id, status, tier, state_id_at_start, created_at)
			VALUES ('active', 'u1', 'i1', 'r1', 'assigned', 'balanced', 'child', 3)
		`);
		expect(db.prepare("SELECT 1 FROM agent_run WHERE id = 'active'").get()).toBeUndefined();

		db.exec(`
			INSERT INTO agent_run
				(id, user_id, issue_id, runner_id, status, tier, state_id_at_start, created_at)
			VALUES ('done', 'u1', 'i1', 'r1', 'completed', 'balanced', 'child', 3);
			UPDATE agent_run SET status = 'running' WHERE id = 'done';
		`);
		expect(db.prepare("SELECT status FROM agent_run WHERE id = 'done'").get()).toEqual({
			status: 'completed'
		});

		expect(() =>
			db.exec("UPDATE workflow_state SET inherits_from_state_id = 'root' WHERE id = 'child'")
		).toThrow(/state_retirement_hold_active/);
		db.exec("UPDATE workflow_state SET inherits_from_state_id = NULL WHERE id = 'child'");
		expect(() =>
			db.exec(`
				INSERT INTO workflow_state
					(id, workflow_id, name, category, position, inherits_from_state_id, created_at)
				VALUES ('late', 'wf1', 'Late', 'active', 3, 'root', 3)
			`)
		).toThrow(/state_retirement_hold_active/);

		db.exec("UPDATE state_retirement_hold SET released_at = 4 WHERE id = 'hold1'");
		db.exec("UPDATE workflow_state SET inherits_from_state_id = 'root' WHERE id = 'child'");
		db.exec(`
			INSERT INTO agent_run
				(id, user_id, issue_id, runner_id, status, tier, state_id_at_start, created_at)
			VALUES ('after', 'u1', 'i1', 'r1', 'assigned', 'balanced', 'child', 4)
		`);
		expect(db.prepare("SELECT status FROM agent_run WHERE id = 'after'").get()).toEqual({
			status: 'assigned'
		});
	});

	it('allows only one active hold per owner and state', () => {
		const db = preReleaseADb();
		seedPopulatedInheritance(db);
		acquireHold(db);
		db.exec(`
			INSERT INTO state_retirement_hold
				(id, user_id, actor_key, topology_digest, inventory_digest, created_at)
			VALUES ('hold2', 'u1', 'session:u1', 'topology2', 'inventory2', 3)
		`);
		expect(() =>
			db.exec(`
				INSERT INTO state_retirement_hold_state
					(hold_id, user_id, state_id, workflow_name, state_name, state_category)
				VALUES ('hold2', 'u1', 'child', 'Craft', 'Child', 'active')
			`)
		).toThrow(/state_retirement_state_already_held/);

		db.exec("UPDATE state_retirement_hold SET released_at = 4 WHERE id = 'hold1'");
		db.exec(`
			INSERT INTO state_retirement_hold_state
				(hold_id, user_id, state_id, workflow_name, state_name, state_category)
			VALUES ('hold2', 'u1', 'child', 'Craft', 'Child', 'active')
		`);
		expect(
			db.prepare("SELECT hold_id FROM state_retirement_hold_state WHERE hold_id = 'hold2'").get()
		).toEqual({ hold_id: 'hold2' });
	});
});

describe('state retirement Release B barrier migration', () => {
	it('runs the actual Release A transaction before the B barrier', async () => {
		const t = preReleaseATestDb();
		seedPopulatedInheritance(t.sqlite);
		const env = releaseAEnv(t);
		const base = Date.now();
		const captured = await createStateRetirementInventory(t.db, releaseAActor, base);
		const hold = await acquireStateRetirementHold(
			t.db,
			env,
			releaseAActor,
			{
				inventory_json: JSON.stringify(captured),
				confirmation: { inventory_digest: captured.inventory_digest }
			},
			base + 1
		);
		t.sqlite.exec("DELETE FROM agent_run WHERE id = 'r1'");
		const prepared = await prepareStateRetirement(
			t.db,
			env,
			releaseAActor,
			{ hold_id: hold.id, inventory_json: JSON.stringify(captured) },
			base + 2
		);
		expect(prepared.plan_token).toMatch(/^srp1\./);
		const applyRequest = {
			plan_token: prepared.plan_token!,
			inventory_json: prepared.inventory_json,
			confirmation: { plan_digest: prepared.plan_digest }
		};

		// Mutating a witnessed payload after prepare must fail before the batch writes anything.
		t.sqlite.exec(
			"UPDATE context_item SET body = 'late write', version = 2 WHERE id = 'root-prompt'"
		);
		const stale = await applyStateRetirement(
			t.db,
			env,
			releaseAActor,
			applyRequest,
			base + 3
		).catch((error) => error);
		expect(stale).toBeInstanceOf(ApiFail);
		expect(stale).toMatchObject({ status: 409, code: 'retirement_plan_stale' });
		expect(t.all('SELECT id FROM state_retirement_receipt')).toEqual([]);
		expect(t.all("SELECT id FROM context_item WHERE id LIKE 'ctx_preserve_%'")).toEqual([]);
		expect(t.all("SELECT inherits_from_state_id FROM workflow_state WHERE id = 'child'")).toEqual([
			{ inherits_from_state_id: 'root' }
		]);

		t.sqlite.exec(
			"UPDATE context_item SET body = 'Root guidance bytes', version = 1 WHERE id = 'root-prompt'"
		);
		const restored = await createStateRetirementInventory(t.db, releaseAActor, base + 4);
		expect(restored.inventory_digest).toBe(JSON.parse(prepared.inventory_json).inventory_digest);
		expect(restored.topology_digest).toBe(JSON.parse(prepared.inventory_json).topology_digest);
		const receipt = await applyStateRetirement(t.db, env, releaseAActor, applyRequest, base + 4);
		const retry = await applyStateRetirement(t.db, env, releaseAActor, applyRequest, base + 5);
		expect(retry).toEqual(receipt);
		expect(t.all('SELECT id FROM state_retirement_receipt')).toHaveLength(1);
		expect(t.all("SELECT inherits_from_state_id FROM workflow_state WHERE id = 'child'")).toEqual([
			{ inherits_from_state_id: null }
		]);
		const copies = receipt.copies.map((copy) => copy.copy_item_id);
		const copiedRows = t.all(
			`SELECT id, kind, body, repo_url FROM context_item WHERE id IN (${copies.map(() => '?').join(',')})`,
			...copies
		);
		expect(copiedRows).toHaveLength(4);
		expect(copiedRows).toEqual(
			expect.arrayContaining([
				{
					id: receipt.copies.find((copy) => copy.source_item_id === 'root-journal')!.copy_item_id,
					kind: 'prompt',
					body: 'Root journal bytes',
					repo_url: null
				},
				{
					id: receipt.copies.find((copy) => copy.source_item_id === 'root-prompt')!.copy_item_id,
					kind: 'prompt',
					body: 'Root guidance bytes',
					repo_url: null
				},
				{
					id: receipt.copies.find((copy) => copy.source_item_id === 'root-repo')!.copy_item_id,
					kind: 'repo',
					body: null,
					repo_url: 'https://github.com/example/source.git'
				},
				{
					id: receipt.copies.find((copy) => copy.source_item_id === 'root-skill')!.copy_item_id,
					kind: 'skill',
					body: null,
					repo_url: null
				}
			])
		);
		const journalCopy = receipt.copies.find((copy) => copy.source_item_id === 'root-journal')!;
		t.sqlite.exec(
			`UPDATE context_item SET body = 'Child journal append', version = 2 WHERE id = '${journalCopy.copy_item_id}'`
		);
		expect(t.all("SELECT body FROM context_item WHERE id = 'root-journal'")).toEqual([
			{ body: 'Root journal bytes' }
		]);
		const skillCopy = receipt.copies.find((copy) => copy.source_item_id === 'root-skill')!;
		expect(
			t.all('SELECT content FROM context_item_file WHERE id = ?', skillCopy.copy_file_ids[0])
		).toEqual([{ content: 'Root skill bytes' }]);

		await releaseStateRetirementHold(
			t.db,
			env,
			releaseAActor,
			hold.id,
			{ confirmation: { hold_id: hold.id, release: true } },
			base + 6
		);
		applyReleaseB(t.sqlite);
		expect(
			t.all(
				'SELECT pointer_count, unresolved_receipt_count FROM state_inheritance_retirement_barrier'
			)
		).toEqual([{ pointer_count: 0, unresolved_receipt_count: 0 }]);
		expect(() =>
			t.sqlite.exec("UPDATE workflow_state SET inherits_from_state_id = 'root' WHERE id = 'child'")
		).toThrow(/state_inheritance_removed/);
	});

	it('fails atomically on a leftover pointer and does not clear it', () => {
		const db = preReleaseADb();
		seedPopulatedInheritance(db);
		db.exec('BEGIN');
		expect(() => applyReleaseB(db)).toThrow(/CHECK constraint failed|UNIQUE constraint failed/);
		db.exec('ROLLBACK');
		expect(
			db.prepare("SELECT inherits_from_state_id FROM workflow_state WHERE id = 'child'").get()
		).toEqual({
			inherits_from_state_id: 'root'
		});
		expect(
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE name = 'state_inheritance_retirement_barrier'"
				)
				.get()
		).toBeUndefined();
	});

	it('accepts the frozen A shape after pointers are cleared and permanently rejects old-worker pointer writes', () => {
		const db = preReleaseADb();
		seedPopulatedInheritance(db);
		db.exec("UPDATE workflow_state SET inherits_from_state_id = NULL WHERE id = 'child'");
		applyReleaseB(db);
		db.exec("UPDATE workflow_state SET inherits_from_state_id = NULL WHERE id = 'child'");
		db.exec(`
			INSERT INTO workflow_state
				(id, workflow_id, name, category, position, inherits_from_state_id, created_at)
			VALUES ('ordinary', 'wf1', 'Ordinary', 'active', 2, NULL, 3)
		`);
		expect(() =>
			db.exec("UPDATE workflow_state SET inherits_from_state_id = 'root' WHERE id = 'child'")
		).toThrow(/state_inheritance_removed/);
		expect(() =>
			db.exec(`
			INSERT INTO workflow_state
				(id, workflow_id, name, category, position, inherits_from_state_id, created_at)
			VALUES ('reintroduced', 'wf1', 'Reintroduced', 'active', 3, 'root', 3)
		`)
		).toThrow(/state_inheritance_removed/);
		expect(
			db
				.prepare(
					'SELECT pointer_count, unresolved_receipt_count FROM state_inheritance_retirement_barrier'
				)
				.get()
		).toEqual({
			pointer_count: 0,
			unresolved_receipt_count: 0
		});

		// The old worker's explicit state-id drain/claim guards remain active on
		// the B schema even though its pointer writes can no longer succeed.
		acquireHold(db);
		db.exec(`
			INSERT INTO agent_run
				(id, user_id, issue_id, runner_id, status, tier, state_id_at_start, created_at)
			VALUES ('blocked', 'u1', 'i1', 'r1', 'assigned', 'balanced', 'child', 4)
		`);
		expect(db.prepare("SELECT 1 FROM agent_run WHERE id = 'blocked'").get()).toBeUndefined();
		db.exec(`
			INSERT INTO agent_run
				(id, user_id, issue_id, runner_id, status, tier, state_id_at_start, created_at)
			VALUES ('drained', 'u1', 'i1', 'r1', 'completed', 'balanced', 'child', 4);
			UPDATE agent_run SET status = 'running' WHERE id = 'drained';
		`);
		expect(db.prepare("SELECT status FROM agent_run WHERE id = 'drained'").get()).toEqual({
			status: 'completed'
		});
		db.exec("UPDATE state_retirement_hold SET released_at = 5 WHERE id = 'hold1'");
		db.exec(`
			INSERT INTO agent_run
				(id, user_id, issue_id, runner_id, status, tier, state_id_at_start, created_at)
			VALUES ('after-b', 'u1', 'i1', 'r1', 'assigned', 'balanced', 'child', 5)
		`);
		expect(db.prepare("SELECT status FROM agent_run WHERE id = 'after-b'").get()).toEqual({
			status: 'assigned'
		});
	});

	it('fails closed on an unresolved recorded pointer and leaves the A tables intact', () => {
		const db = preReleaseADb();
		seedPopulatedInheritance(db);
		db.exec("UPDATE workflow_state SET inherits_from_state_id = NULL WHERE id = 'child'");
		acquireHold(db);
		db.exec(`
			INSERT INTO state_retirement_pointer
				(hold_id, user_id, child_state_id, original_parent_state_id, state_witness)
			VALUES ('hold1', 'u1', 'child', 'root', 'witness')
		`);
		db.exec('BEGIN');
		expect(() => applyReleaseB(db)).toThrow(/CHECK constraint failed/);
		db.exec('ROLLBACK');
		expect(
			db
				.prepare(
					"SELECT successful_receipt_id FROM state_retirement_pointer WHERE child_state_id = 'child'"
				)
				.get()
		).toEqual({
			successful_receipt_id: null
		});
	});
});
