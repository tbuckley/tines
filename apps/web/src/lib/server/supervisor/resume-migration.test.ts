import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const migrationsDir = fileURLToPath(new URL('../../../../migrations/', import.meta.url));

describe('run resume migration', () => {
	it('preserves populated runner, settings, and run rows while defaulting policy off', () => {
		const db = new DatabaseSync(':memory:');
		db.exec('PRAGMA foreign_keys = ON');
		for (const file of readdirSync(migrationsDir)
			.sort()
			.filter((name) => name < '0026_')) {
			db.exec(readFileSync(`${migrationsDir}/${file}`, 'utf8'));
		}
		db.exec(`
			INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
			VALUES ('u1', 'Alice', 'a@example.com', 1, 1, 1);
			INSERT INTO project (id, user_id, name, created_at, updated_at)
			VALUES ('p1', 'u1', 'Demo', 1, 1);
			INSERT INTO runner (id, user_id, type, name, status, max_concurrent, max_run_minutes,
				default_tier, config, launch_failures, draining, created_at, updated_at)
			VALUES ('r1', 'u1', 'local', 'mac', 'active', 1, 30, 'balanced', '{}', 0, 0, 1, 1);
			INSERT INTO supervisor_settings (user_id, enabled, quota, attempt_limit, updated_at)
			VALUES ('u1', 1, '{}', 3, 1);
			INSERT INTO issue (id, project_id, number, title, description, workflow_id, state_id,
				attempt_count, needs_attention, created_at, updated_at, state_entered_at)
			VALUES ('i1', 'p1', 1, 'Existing', '', 'wf_standard', 'wfs_std_open', 0, 0, 1, 1, 1);
			INSERT INTO agent_run (id, user_id, issue_id, runner_id, status, tier, model,
				state_id_at_start, log, log_bytes_dropped, created_at)
			VALUES ('a1', 'u1', 'i1', 'r1', 'completed', 'balanced', 'model',
				'wfs_std_open', 'kept log', 0, 1);
		`);

		db.exec(readFileSync(`${migrationsDir}/0026_run_resume.sql`, 'utf8'));
		expect(
			db.prepare('SELECT id, resume_enabled, resume_config_revision FROM runner').get()
		).toEqual({ id: 'r1', resume_enabled: 0, resume_config_revision: 0 });
		expect(
			db.prepare('SELECT user_id, source_credentials_revision FROM supervisor_settings').get()
		).toEqual({ user_id: 'u1', source_credentials_revision: 0 });
		expect(db.prepare('SELECT id, log, resumed_from_run_id FROM agent_run').get()).toEqual({
			id: 'a1',
			log: 'kept log',
			resumed_from_run_id: null
		});
		expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
	});
});
