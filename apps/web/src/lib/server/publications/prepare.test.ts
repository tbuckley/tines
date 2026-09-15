import { describe, expect, it } from 'vitest';
import { canonicalizeLibraryValue, withLibraryDocumentDigest } from '@tines/shared';
import { inheritedPackage } from '../../../../../../packages/shared/src/library/fixtures';
import { createTestDb } from '../api/test-db';
import { USER, seedBase } from '../supervisor/test-fixtures';
import { preparePublication } from './prepare';

const actor = {
	userId: USER,
	userName: 'Alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

async function request(displayName = 'Example Team') {
	return {
		prepare_request_id: 'prepare-once',
		source: {
			kind: 'file' as const,
			document_json: canonicalizeLibraryValue(await withLibraryDocumentDigest(inheritedPackage()))
		},
		metadata: { display_name: displayName, license: 'MIT' as const, license_year: 2026 }
	};
}

describe('publication preparation', () => {
	it('stores an actor-bound candidate and reconciles an identical request', async () => {
		const t = createTestDb();
		seedBase(t);
		const env = { ...t.env, PUBLIC_WORKFLOW_PUBLISHING_ENABLED: 'true' } as Env;
		const first = await preparePublication(t.db, env, actor, await request(), 1000);
		const replay = await preparePublication(t.db, env, actor, await request(), 2000);
		expect(replay).toEqual(first);
		expect(first.candidate_id).toMatch(/^pub_/);
		expect(first.expires_at).toBe(901000);
		expect(await t.db.selectFrom('workflow_publication').selectAll().execute()).toHaveLength(1);
		const source = await t.db
			.selectFrom('workflow_publication_source')
			.selectAll()
			.executeTakeFirst();
		expect(source?.source_witness_json).not.toContain('Review the change');
		expect(source?.source_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);

		await expect(
			preparePublication(t.db, env, actor, await request('Different'), 2000)
		).rejects.toMatchObject({
			status: 409,
			code: 'prepare_request_conflict'
		});
	});

	it('fails closed when host publication creation is disabled', async () => {
		const t = createTestDb();
		seedBase(t);
		await expect(preparePublication(t.db, t.env, actor, await request())).rejects.toMatchObject({
			status: 503,
			code: 'publication_disabled'
		});
		expect(await t.db.selectFrom('workflow_publication').selectAll().execute()).toEqual([]);
	});
});
