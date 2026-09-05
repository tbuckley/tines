import { describe, expect, it } from 'vitest';
import { addIssue, addRun, addRunner, NOW, seedBase, USER } from '../supervisor/test-fixtures';
import { countRunKeys, listApiKeys, revokeApiKey } from './apikeys';
import type { ActorContext } from './core';
import { actorRunOf } from './events';
import { createTestDb, type TestDb } from './test-db';

/**
 * Insert an `api_key` row directly, the way the seed and the supervisor's
 * launch path do — `createApiKey` cannot mint a run key.
 */
function addKey(
	t: TestDb,
	opts: {
		id: string;
		name: string;
		runId?: string | null;
		revokedAt?: number | null;
		createdAt?: number;
	}
): string {
	t.sqlite
		.prepare(
			`INSERT INTO api_key (id, user_id, name, key_hash, key_prefix, created_at, agent_run_id, revoked_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			opts.id,
			USER,
			opts.name,
			`hash_${opts.id}`,
			`tines_${opts.id}`.slice(0, 14),
			opts.createdAt ?? NOW,
			opts.runId ?? null,
			opts.revokedAt ?? null
		);
	return opts.id;
}

const actor: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

describe('listApiKeys', () => {
	it('returns a user with no runs their own keys, newest first, with no run provenance', async () => {
		const t = createTestDb();
		seedBase(t);
		addKey(t, { id: 'key_old', name: 'laptop', createdAt: NOW - 1000 });
		addKey(t, { id: 'key_new', name: 'ci', createdAt: NOW });

		const keys = await listApiKeys(t.db, USER);
		expect(keys.map((k) => k.name)).toEqual(['ci', 'laptop']);
		expect(keys.every((k) => k.run === undefined)).toBe(true);
		expect(await countRunKeys(t.db, USER)).toEqual({ active: 0, revoked: 0 });
	});

	it('hides revoked run keys by default and resolves the live one to its run', async () => {
		const t = createTestDb();
		seedBase(t);
		const issueId = addIssue(t, { title: 'Fix the thing' });
		const runnerId = addRunner(t, { name: 'laptop-m4' });
		const live = addRun(t, { id: 'arun_live', issueId, runnerId, status: 'running' });
		const dead1 = addRun(t, { id: 'arun_dead1', issueId, runnerId, status: 'completed' });
		const dead2 = addRun(t, { id: 'arun_dead2', issueId, runnerId, status: 'failed' });
		addKey(t, { id: 'key_user', name: 'laptop', createdAt: NOW - 5000 });
		addKey(t, { id: 'key_live', name: `run ${live}`, runId: live, createdAt: NOW });
		addKey(t, {
			id: 'key_dead1',
			name: `run ${dead1}`,
			runId: dead1,
			revokedAt: NOW,
			createdAt: NOW - 2000
		});
		addKey(t, {
			id: 'key_dead2',
			name: `run ${dead2}`,
			runId: dead2,
			revokedAt: NOW,
			createdAt: NOW - 1000
		});

		const keys = await listApiKeys(t.db, USER);
		expect(keys.map((k) => k.id)).toEqual(['key_live', 'key_user']);

		const runKey = keys.find((k) => k.id === 'key_live');
		const issueNumber = t.all('SELECT number FROM issue WHERE id = ?', issueId)[0].number;
		expect(runKey?.run).toEqual({
			run_id: live,
			runner_name: 'laptop-m4',
			issue_ref: { project_name: 'demo', number: issueNumber }
		});
		// A user key stays byte-identical to what the page rendered before.
		expect(keys.find((k) => k.id === 'key_user')?.run).toBeUndefined();

		expect(await countRunKeys(t.db, USER)).toEqual({ active: 1, revoked: 2 });
	});

	it("'all' adds the newest revoked run keys up to the cap, and 'none' drops every run key", async () => {
		const t = createTestDb();
		seedBase(t);
		const issueId = addIssue(t);
		const runnerId = addRunner(t, { name: 'laptop-m4' });
		addKey(t, { id: 'key_user', name: 'laptop' });
		for (const [i, id] of ['arun_a', 'arun_b', 'arun_c'].entries()) {
			addRun(t, { id, issueId, runnerId, status: 'completed' });
			addKey(t, {
				id: `key_${id}`,
				name: `run ${id}`,
				runId: id,
				revokedAt: NOW,
				createdAt: NOW + i
			});
		}

		const capped = await listApiKeys(t.db, USER, { runKeys: 'all', revokedRunKeyLimit: 2 });
		// Newest revoked first, and only as many as the cap allows.
		expect(capped.map((k) => k.id)).toEqual(['key_user', 'key_arun_c', 'key_arun_b']);

		const all = await listApiKeys(t.db, USER, { runKeys: 'all' });
		expect(all).toHaveLength(4);

		const none = await listApiKeys(t.db, USER, { runKeys: 'none' });
		expect(none.map((k) => k.id)).toEqual(['key_user']);
	});

	it('revokes a live run key, so a leaked one can be killed from the page', async () => {
		const t = createTestDb();
		seedBase(t);
		const issueId = addIssue(t);
		const runnerId = addRunner(t);
		const runId = addRun(t, { issueId, runnerId, status: 'running' });
		addKey(t, { id: 'key_live', name: `run ${runId}`, runId });

		await revokeApiKey(t.db, t.env, actor, 'key_live');

		expect(t.all('SELECT revoked_at FROM api_key WHERE id = ?', 'key_live')[0].revoked_at).not.toBe(
			null
		);
		// Gone from the default listing, still reachable behind the toggle.
		expect(await listApiKeys(t.db, USER)).toHaveLength(0);
		expect((await listApiKeys(t.db, USER, { runKeys: 'all' })).map((k) => k.id)).toEqual([
			'key_live'
		]);
		expect(await countRunKeys(t.db, USER)).toEqual({ active: 0, revoked: 1 });
	});
});

describe('actorRunOf', () => {
	it('falls back to the run id when the issue behind the run is gone', () => {
		expect(
			actorRunOf({
				run_id: 'arun_1',
				runner_name: 'laptop-m4',
				run_project_name: null,
				run_issue_number: null
			})
		).toEqual({ run_id: 'arun_1', runner_name: 'laptop-m4', issue_ref: null });
	});

	it('names an unresolvable runner rather than rendering null', () => {
		expect(
			actorRunOf({
				run_id: 'arun_1',
				runner_name: null,
				run_project_name: 'demo',
				run_issue_number: 3
			})
		).toEqual({
			run_id: 'arun_1',
			runner_name: 'unknown runner',
			issue_ref: { project_name: 'demo', number: 3 }
		});
	});
});
