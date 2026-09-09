/**
 * The GitHub PAT in supervisor settings: write-only, encrypted at rest,
 * only the fingerprint hint readable, rotation on the record with the value
 * elided by construction.
 */
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
	it('reads a missing row as enabled and creates partial settings enabled', async () => {
		const t = world();
		t.sqlite.exec(`DELETE FROM supervisor_settings WHERE user_id = '${USER}'`);
		expect((await getSupervisorSettings(t.db, USER)).enabled).toBe(true);

		await updateSupervisorSettings(t.db, t.env, actor, { attempt_limit: 5 });
		expect(t.all('SELECT enabled FROM supervisor_settings')[0].enabled).toBe(1);
	});

	it('preserves a saved stop through unrelated partial and empty writes', async () => {
		const t = world();
		await updateSupervisorSettings(t.db, t.env, actor, { enabled: false });
		await updateSupervisorSettings(t.db, t.env, actor, { attempt_limit: 5 });
		await updateSupervisorSettings(t.db, t.env, actor, {});
		expect((await getSupervisorSettings(t.db, USER)).enabled).toBe(false);
		expect(t.all('SELECT enabled FROM supervisor_settings')[0].enabled).toBe(0);
	});

	it('stores encrypted, reads back only the hint, and clears with null', async () => {
		const t = world();
		const saved = await updateSupervisorSettings(t.db, t.env, actor, {
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

		// Rotation is on record, the value never is.
		const events = t.all("SELECT payload FROM event WHERE type = 'settings.updated'") as {
			payload: string;
		}[];
		expect(events).toHaveLength(1);
		expect(JSON.parse(events[0].payload)).toMatchObject({ changed: ['github_pat'] });
		expect(events[0].payload).not.toContain('github_pat_11AAAA');

		const cleared = await updateSupervisorSettings(t.db, t.env, actor, { github_pat: null });
		expect(cleared.github_pat_hint).toBeNull();
		const after = t.all('SELECT github_pat_enc FROM supervisor_settings')[0] as {
			github_pat_enc: string | null;
		};
		expect(after.github_pat_enc).toBeNull();
	});

	it('replacing the PAT does not disturb the plain settings fields', async () => {
		const t = world();
		await updateSupervisorSettings(t.db, t.env, actor, { enabled: true, attempt_limit: 5 });
		await updateSupervisorSettings(t.db, t.env, actor, {
			github_pat: 'github_pat_11BBBB0abcdefghij'
		});
		const settings = await getSupervisorSettings(t.db, USER);
		expect(settings.enabled).toBe(true);
		expect(settings.attempt_limit).toBe(5);
		expect(settings.github_pat_hint).toBe('github_p…ghij');
	});
});
