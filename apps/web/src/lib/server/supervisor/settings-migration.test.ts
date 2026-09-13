import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const migrationsDir = fileURLToPath(new URL('../../../../migrations/', import.meta.url));

describe('supervisor enabled default migration', () => {
	it('preserves saved rows and foreign keys while changing only the default', () => {
		const db = new DatabaseSync(':memory:');
		db.exec('PRAGMA foreign_keys = ON');
		const files = readdirSync(migrationsDir).sort();
		for (const file of files.filter((name) => name < '0025_')) {
			db.exec(readFileSync(`${migrationsDir}/${file}`, 'utf8'));
		}
		db.exec(`
			INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
			VALUES ('u_false', 'False', 'false@example.com', 1, 1, 1),
			       ('u_true', 'True', 'true@example.com', 1, 1, 1),
			       ('u_new', 'New', 'new@example.com', 1, 1, 1);
			INSERT INTO supervisor_settings
				(user_id, enabled, quota, attempt_limit, budget, pricing, github_pat_enc, github_pat_hint, updated_at)
			VALUES
				('u_false', 0, 'q0', 7, 'b0', 'p0', 'enc0', 'hint0', 99),
				('u_true', 1, 'q1', 8, 'b1', 'p1', 'enc1', 'hint1', 100);
		`);

		db.exec(readFileSync(`${migrationsDir}/0025_supervisor_enabled_default.sql`, 'utf8'));
		expect(db.prepare('SELECT * FROM supervisor_settings ORDER BY user_id').all()).toEqual([
			{
				user_id: 'u_false',
				enabled: 0,
				quota: 'q0',
				attempt_limit: 7,
				budget: 'b0',
				pricing: 'p0',
				github_pat_enc: 'enc0',
				github_pat_hint: 'hint0',
				updated_at: 99
			},
			{
				user_id: 'u_true',
				enabled: 1,
				quota: 'q1',
				attempt_limit: 8,
				budget: 'b1',
				pricing: 'p1',
				github_pat_enc: 'enc1',
				github_pat_hint: 'hint1',
				updated_at: 100
			}
		]);
		db.exec(
			`INSERT INTO supervisor_settings (user_id, quota, updated_at) VALUES ('u_new', '{}', 101)`
		);
		expect(
			db.prepare("SELECT enabled FROM supervisor_settings WHERE user_id = 'u_new'").get()
		).toEqual({ enabled: 1 });
		db.exec(`DELETE FROM user WHERE id = 'u_false'`);
		expect(
			db.prepare("SELECT 1 FROM supervisor_settings WHERE user_id = 'u_false'").get()
		).toBeUndefined();
		expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
	});
});
