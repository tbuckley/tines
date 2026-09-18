import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const migrationsDir = fileURLToPath(new URL('../../../../migrations/', import.meta.url));

describe('publication source detachment migration', () => {
	it('upgrades a pre-0037 database and permits only source nulling', () => {
		const db = new DatabaseSync(':memory:');
		db.exec('PRAGMA foreign_keys = ON');
		for (const file of readdirSync(migrationsDir)
			.sort()
			.filter((name) => name < '0037_')) {
			db.exec(readFileSync(`${migrationsDir}/${file}`, 'utf8'));
		}
		db.exec(`
			INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt)
			VALUES ('u1','Alice','alice@example.test',1,1,1);
			INSERT INTO workflow (id,user_id,name,description,initial_state_id,created_at,updated_at)
			VALUES ('w1','u1','Private source','','s1',1,1);
			INSERT INTO workflow_state (id,workflow_id,name,category,position,created_at)
			VALUES ('s1','w1','Open','active',0,1);
			INSERT INTO workflow_publication
				(id,user_id,actor_key,prepare_request_id,prepare_request_hash,source_workflow_id,
				source_kind,source_provenance_json,document_json,document_digest,bytes_sha256,
				byte_length,metadata_json,review_digest,policy_version,created_at,expires_at,
				snapshot_id,published_at,owner_state,host_state,status_version)
			VALUES ('p1','u1','session','request','hash','w1','owned_workflow','{}','frozen',
				'digest','bytes',6,'{}','review',1,1,2,'snapshot_12345678901234567890',1,
				'published','active',1);
		`);
		expect(() => db.exec("DELETE FROM workflow WHERE id = 'w1'")).toThrow(/immutable/);

		db.exec(readFileSync(`${migrationsDir}/0037_publication_source_detachment.sql`, 'utf8'));
		db.exec("DELETE FROM workflow WHERE id = 'w1'");
		expect(
			db
				.prepare("SELECT source_workflow_id,document_json FROM workflow_publication WHERE id='p1'")
				.get()
		).toEqual({ source_workflow_id: null, document_json: 'frozen' });
		expect(() =>
			db.exec("UPDATE workflow_publication SET source_workflow_id='other' WHERE id='p1'")
		).toThrow(/source is immutable/);
		expect(() =>
			db.exec("UPDATE workflow_publication SET document_json='changed' WHERE id='p1'")
		).toThrow(/content is immutable/);
		expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
	});
});
