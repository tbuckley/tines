import { readFileSync, readdirSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

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

const RELEASE_A_SIGNING_KEY = 'native-release-a-test-key';
type ReleaseAPlan = {
	hold_id: string;
	inventory_digest: string;
	topology_digest: string;
	child_state_id: string;
	parent_state_id: string;
	sources: Array<{
		id: string;
		kind: string;
		name: string;
		body: string | null;
		version: number;
		copy_id: string;
		copy_name: string;
		project_id: string | null;
		files: Array<{ id: string; path: string; content: string }>;
	}>;
};

function signedReleaseAPlan(plan: ReleaseAPlan): string {
	return createHmac('sha256', RELEASE_A_SIGNING_KEY).update(JSON.stringify(plan)).digest('hex');
}

/** Frozen native-D1 witness for the signed A transaction consumed by B. */
function applyFrozenReleaseA(
	db: DatabaseSync,
	plan: ReleaseAPlan,
	signature: string
): Record<string, unknown> {
	if (signedReleaseAPlan(plan) !== signature) throw new Error('invalid signed Release A plan');
	const existing = db
		.prepare('SELECT receipt_json FROM state_retirement_receipt WHERE request_digest = ?')
		.get('native-request') as { receipt_json?: string } | undefined;
	if (existing?.receipt_json) return JSON.parse(existing.receipt_json) as Record<string, unknown>;
	db.exec('BEGIN');
	try {
		const hold = db
			.prepare(
				`SELECT 1 AS ok FROM state_retirement_hold h
				 WHERE h.id = ? AND h.released_at IS NULL
				   AND h.inventory_digest = ? AND h.topology_digest = ?`
			)
			.get(plan.hold_id, plan.inventory_digest, plan.topology_digest);
		if (!hold) throw new Error('retirement hold changed');
		for (const source of plan.sources) {
			const current = db
				.prepare('SELECT body, version FROM context_item WHERE id = ?')
				.get(source.id) as { body: string | null; version: number } | undefined;
			if (!current || current.body !== source.body || current.version !== source.version)
				throw new Error('retirement_plan_stale');
		}
		const receipt = {
			version: 1,
			id: 'native-receipt',
			kind: 'preserve',
			request_digest: 'native-request',
			copied_source_ids: plan.sources.map((source) => source.id)
		};
		db.prepare(
			`INSERT INTO state_retirement_receipt
			 (id,user_id,hold_id,actor_key,kind,rollback_of_receipt_id,inventory_digest,
			  plan_digest,request_digest,execution_nonce,receipt_json,committed_at)
			 VALUES ('native-receipt','u1',?,'session:u1','preserve',NULL,?,'native-plan',
			 'native-request','native-execution',?,10)`
		).run(plan.hold_id, plan.inventory_digest, JSON.stringify(receipt));
		for (const source of plan.sources) {
			db.prepare(
				`INSERT INTO context_item
				 (id,user_id,kind,name,description,project_id,workflow_state_id,label_id,issue_id,
				  body,position,version,created_at,updated_at)
				 SELECT ?,user_id,kind,?,description,?,?,NULL,NULL,body,position,1,10,10
				 FROM context_item WHERE id = ?
				   AND EXISTS (SELECT 1 FROM state_retirement_receipt WHERE id='native-receipt')`
			).run(source.copy_id, source.copy_name, source.project_id, plan.child_state_id, source.id);
			for (const file of source.files)
				db.prepare(
					`INSERT INTO context_item_file
					 (id,context_item_id,path,content,created_at,updated_at)
					 VALUES (?,?,?, ?,10,10)`
				).run(file.id, source.copy_id, file.path, file.content);
		}
		const cleared = db
			.prepare(
				`UPDATE workflow_state SET inherits_from_state_id = NULL
				 WHERE id = ? AND inherits_from_state_id = ?`
			)
			.run(plan.child_state_id, plan.parent_state_id);
		if (cleared.changes !== 1) throw new Error('retirement pointer changed');
		db.prepare(
			`UPDATE state_retirement_pointer SET successful_receipt_id = ?
			 WHERE hold_id = ? AND child_state_id = ? AND original_parent_state_id = ?`
		).run('native-receipt', plan.hold_id, plan.child_state_id, plan.parent_state_id);
		db.exec('COMMIT');
		return receipt;
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
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
	it('carries populated guidance through signed A preservation, receipt retry, and the B barrier', () => {
		const db = preReleaseADb();
		seedPopulatedInheritance(db);
		acquireHold(db);
		db.exec(`
			INSERT INTO state_retirement_pointer
				(hold_id, user_id, child_state_id, original_parent_state_id, state_witness)
			VALUES ('hold1', 'u1', 'child', 'root', '{"child":"child","parent":"root"}');
		`);
		const plan: ReleaseAPlan = {
			hold_id: 'hold1',
			inventory_digest: 'inventory',
			topology_digest: 'topology',
			child_state_id: 'child',
			parent_state_id: 'root',
			sources: [
				{
					id: 'root-prompt',
					kind: 'prompt',
					name: 'instructions',
					body: 'Root guidance bytes',
					version: 1,
					copy_id: 'copy-prompt',
					copy_name: 'Guidance — preserved from Craft / Root',
					project_id: null,
					files: []
				},
				{
					id: 'root-journal',
					kind: 'prompt',
					name: 'journal',
					body: 'Root journal bytes',
					version: 1,
					copy_id: 'copy-journal',
					copy_name: 'journal',
					project_id: 'p1',
					files: []
				},
				{
					id: 'root-skill',
					kind: 'skill',
					name: 'review',
					body: null,
					version: 1,
					copy_id: 'copy-skill',
					copy_name: 'review',
					project_id: null,
					files: [{ id: 'copy-skill-file', path: 'SKILL.md', content: 'Root skill bytes' }]
				},
				{
					id: 'root-repo',
					kind: 'repo',
					name: 'source',
					body: null,
					version: 1,
					copy_id: 'copy-repo',
					copy_name: 'source',
					project_id: null,
					files: []
				}
			]
		};
		const signature = signedReleaseAPlan(plan);

		// A late journal/payload write invalidates the witnessed signed request and leaves no residue.
		db.exec("UPDATE context_item SET body = 'late write', version = 2 WHERE id = 'root-prompt'");
		expect(() => applyFrozenReleaseA(db, plan, signature)).toThrow('retirement_plan_stale');
		expect(db.prepare('SELECT COUNT(*) AS n FROM state_retirement_receipt').get()).toEqual({
			n: 0
		});
		expect(
			db.prepare("SELECT COUNT(*) AS n FROM context_item WHERE id LIKE 'copy-%'").get()
		).toEqual({
			n: 0
		});
		expect(
			db.prepare("SELECT inherits_from_state_id FROM workflow_state WHERE id = 'child'").get()
		).toEqual({ inherits_from_state_id: 'root' });

		db.exec(
			"UPDATE context_item SET body = 'Root guidance bytes', version = 1 WHERE id = 'root-prompt'"
		);
		const receipt = applyFrozenReleaseA(db, plan, signature);
		expect(receipt).toMatchObject({
			id: 'native-receipt',
			copied_source_ids: ['root-prompt', 'root-journal', 'root-skill', 'root-repo']
		});
		expect(applyFrozenReleaseA(db, plan, signature)).toEqual(receipt);
		expect(db.prepare('SELECT COUNT(*) AS n FROM state_retirement_receipt').get()).toEqual({
			n: 1
		});
		expect(
			db.prepare("SELECT inherits_from_state_id FROM workflow_state WHERE id = 'child'").get()
		).toEqual({ inherits_from_state_id: null });
		expect(
			db
				.prepare(
					"SELECT kind, name, body, project_id, workflow_state_id FROM context_item WHERE id LIKE 'copy-%' ORDER BY id"
				)
				.all()
		).toEqual([
			{
				kind: 'prompt',
				name: 'journal',
				body: 'Root journal bytes',
				project_id: 'p1',
				workflow_state_id: 'child'
			},
			{
				kind: 'prompt',
				name: 'Guidance — preserved from Craft / Root',
				body: 'Root guidance bytes',
				project_id: null,
				workflow_state_id: 'child'
			},
			{ kind: 'repo', name: 'source', body: null, project_id: null, workflow_state_id: 'child' },
			{ kind: 'skill', name: 'review', body: null, project_id: null, workflow_state_id: 'child' }
		]);
		db.exec(
			"UPDATE context_item SET body = 'Child journal append', version = 2 WHERE id = 'copy-journal'"
		);
		expect(db.prepare("SELECT body FROM context_item WHERE id = 'root-journal'").get()).toEqual({
			body: 'Root journal bytes'
		});
		expect(
			db.prepare("SELECT content FROM context_item_file WHERE id = 'copy-skill-file'").get()
		).toEqual({
			content: 'Root skill bytes'
		});

		db.exec("UPDATE state_retirement_hold SET released_at = 20 WHERE id = 'hold1'");
		applyReleaseB(db);
		expect(
			db
				.prepare(
					'SELECT pointer_count, unresolved_receipt_count FROM state_inheritance_retirement_barrier'
				)
				.get()
		).toEqual({ pointer_count: 0, unresolved_receipt_count: 0 });
		expect(() =>
			db.exec(`
				UPDATE workflow_state SET inherits_from_state_id = 'root' WHERE id = 'child'
			`)
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
