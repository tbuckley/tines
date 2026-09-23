import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const migrationsDir = fileURLToPath(new URL('../../../../migrations/', import.meta.url));
const migrationName = '0033_state_retirement.sql';

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
