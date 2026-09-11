import { expect, it } from 'vitest';
import { createTestDb } from '$lib/server/api/test-db';
import { USER, seedBase } from '$lib/server/supervisor/test-fixtures';
import { exportWorkflowPackage } from '$lib/server/library/export';
import { POST } from './+server';
it('prepares a complete independent Standard copy through the bounded authenticated handler without writes', async () => {
	const t = createTestDb();
	seedBase(t);
	const doc = await exportWorkflowPackage(t.db, USER, 'wf_standard');
	const call = (body: string) =>
		POST({
			locals: { user: { id: USER, name: 'Alice' } },
			platform: { env: { ...t.env, BETTER_AUTH_SECRET: 'test-key' }, ctx: { waitUntil: () => {} } },
			url: new URL('http://test/api/v1/library/prepare'),
			params: {},
			request: new Request('http://test/api/v1/library/prepare', { method: 'POST', body })
		} as unknown as Parameters<typeof POST>[0]);
	const response = await call(JSON.stringify({ document_json: JSON.stringify(doc) }));
	expect(response.status).toBe(200);
	const result = await response.json();
	expect(result).toMatchObject({
		document_digest: doc.digest,
		resolved: { workflows: [{ name: 'Standard (imported)' }], schedules: [], routing: [] }
	});
	expect(result.plan_token).toMatch(/^wip1\./);
	for (const raw of [
		'{"document_json":"{}","document_json":"{}"}',
		JSON.stringify({ document_json: JSON.stringify(doc), choices: { overwrite: true } }),
		JSON.stringify({ document_json: JSON.stringify(doc), extra: true })
	])
		expect((await call(raw)).status).toBeGreaterThanOrEqual(400);
	expect(
		await t.db.selectFrom('workflow').selectAll().where('user_id', '=', USER).execute()
	).toEqual([]);
	expect(await t.db.selectFrom('event').selectAll().execute()).toEqual([]);
});
