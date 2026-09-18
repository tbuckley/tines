/**
 * The GitHub PAT in supervisor settings: write-only, encrypted at rest,
 * only the fingerprint hint readable, rotation on the record with the value
 * elided by construction.
 */
import {
	recordDispatchEffects,
	TEST_NOOP_DISPATCH_EFFECTS
} from '$lib/server/api/test-dispatch-effects';
import { describe, expect, it } from 'vitest';
import { decryptSecret } from '$lib/server/crypto';
import type { ActorContext } from './core';
import { getSupervisorSettings, updateSupervisorSettings } from './supervisor';
import { createTestDb, type TestDb } from './test-db';
import { seedBase, USER } from '../supervisor/test-fixtures';

const ENC_KEY = 'test-encryption-key';

const actor: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

function world(): TestDb {
	const t = createTestDb();
	seedBase(t);
	t.env.SECRET_ENCRYPTION_KEY = ENC_KEY;
	return t;
}

describe('the GitHub PAT', () => {
	it('dispatch effects: settings write signals before final hydration', async () => {
		const t = world();
		const effects = recordDispatchEffects();
		await expect(
			updateSupervisorSettings(
				t.db,
				t.env,
				actor,
				{
					...effects,
					signalDispatch() {
						effects.signalDispatch();
						t.sqlite.exec(
							'ALTER TABLE supervisor_settings RENAME TO supervisor_settings_after_commit'
						);
					}
				},
				{ attempt_limit: 5 }
			)
		).rejects.toThrow();
		expect(effects.count()).toBe(1);
		expect(t.all('SELECT attempt_limit FROM supervisor_settings_after_commit')).toEqual([
			{ attempt_limit: 5 }
		]);
		expect(t.all("SELECT type FROM event WHERE type = 'settings.updated'")).toHaveLength(1);
	});

	it('dispatch effects: settings rejected batches stay silent and successful no-ops signal', async () => {
		const rejected = world();
		const rejectedEffects = recordDispatchEffects();
		const realBatch = rejected.env.DB.batch.bind(rejected.env.DB);
		rejected.env.DB.batch = async () => {
			throw new Error('injected settings batch failure');
		};
		await expect(
			updateSupervisorSettings(rejected.db, rejected.env, actor, rejectedEffects, {
				attempt_limit: 5
			})
		).rejects.toThrow('injected settings batch failure');
		rejected.env.DB.batch = realBatch;
		expect(rejectedEffects.count()).toBe(0);

		const noOp = world();
		const noOpEffects = recordDispatchEffects();
		await updateSupervisorSettings(noOp.db, noOp.env, actor, noOpEffects, {});
		expect(noOpEffects.count()).toBe(1);
	});

	it('reads a missing row as enabled and creates partial settings enabled', async () => {
		const t = world();
		t.sqlite.exec(`DELETE FROM supervisor_settings WHERE user_id = '${USER}'`);
		expect((await getSupervisorSettings(t.db, USER)).enabled).toBe(true);

		await updateSupervisorSettings(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, {
			attempt_limit: 5
		});
		expect(t.all('SELECT enabled FROM supervisor_settings')[0].enabled).toBe(1);
	});

	it('preserves a saved stop through unrelated partial and empty writes', async () => {
		const t = world();
		await updateSupervisorSettings(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, {
			enabled: false
		});
		await updateSupervisorSettings(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, {
			attempt_limit: 5
		});
		await updateSupervisorSettings(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, {});
		expect((await getSupervisorSettings(t.db, USER)).enabled).toBe(false);
		expect(t.all('SELECT enabled FROM supervisor_settings')[0].enabled).toBe(0);
	});

	it('preserves a stop saved after an unrelated writer reads settings', async () => {
		const t = world();
		await updateSupervisorSettings(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, {
			enabled: true
		});
		const d1 = t.env.DB as unknown as { batch: (statements: unknown[]) => Promise<unknown[]> };
		const realBatch = d1.batch.bind(d1);
		let intercepted = false;
		d1.batch = async (statements) => {
			if (!intercepted) {
				intercepted = true;
				// Simulate another request committing the kill switch after this
				// request's initial read but before its upsert conflict branch.
				t.sqlite.exec(`UPDATE supervisor_settings SET enabled = 0 WHERE user_id = '${USER}'`);
			}
			return realBatch(statements as never[]);
		};

		await updateSupervisorSettings(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, {
			attempt_limit: 5
		});
		expect((await getSupervisorSettings(t.db, USER)).enabled).toBe(false);
	});

	it('stores encrypted, reads back only the hint, and clears with null', async () => {
		const t = world();
		const saved = await updateSupervisorSettings(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, {
			github_pat: 'github_pat_11AAAA0abcdefghijklmn'
		});
		expect(saved.github_pat_hint).toBe('github_p…klmn');
		expect(JSON.stringify(saved)).not.toContain('github_pat_11AAAA');

		const row = t.all('SELECT github_pat_enc FROM supervisor_settings')[0] as {
			github_pat_enc: string;
		};
		expect(row.github_pat_enc).not.toContain('github_pat_11AAAA');
		expect(await decryptSecret(row.github_pat_enc, ENC_KEY)).toBe(
			'github_pat_11AAAA0abcdefghijklmn'
		);
		expect(t.all('SELECT source_credentials_revision FROM supervisor_settings')).toEqual([
			{ source_credentials_revision: 1 }
		]);

		// Rotation is on record, the value never is.
		const events = t.all("SELECT payload FROM event WHERE type = 'settings.updated'") as {
			payload: string;
		}[];
		expect(events).toHaveLength(1);
		expect(JSON.parse(events[0].payload)).toMatchObject({ changed: ['github_pat'] });
		expect(events[0].payload).not.toContain('github_pat_11AAAA');

		const cleared = await updateSupervisorSettings(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, {
			github_pat: null
		});
		expect(cleared.github_pat_hint).toBeNull();
		const after = t.all('SELECT github_pat_enc FROM supervisor_settings')[0] as {
			github_pat_enc: string | null;
		};
		expect(after.github_pat_enc).toBeNull();
		expect(t.all('SELECT source_credentials_revision FROM supervisor_settings')).toEqual([
			{ source_credentials_revision: 2 }
		]);
	});

	it('replacing the PAT does not disturb the plain settings fields', async () => {
		const t = world();
		await updateSupervisorSettings(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, {
			enabled: true,
			attempt_limit: 5
		});
		await updateSupervisorSettings(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, {
			github_pat: 'github_pat_11BBBB0abcdefghij'
		});
		const settings = await getSupervisorSettings(t.db, USER);
		expect(settings.enabled).toBe(true);
		expect(settings.attempt_limit).toBe(5);
		expect(settings.github_pat_hint).toBe('github_p…ghij');
	});
});
