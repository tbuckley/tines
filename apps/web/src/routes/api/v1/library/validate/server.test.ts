import { expect, it } from 'vitest';
import { createTestDb } from '$lib/server/api/test-db';
import { USER, seedBase } from '$lib/server/supervisor/test-fixtures';
import { POST } from './+server';
import { GET } from '../../workflows/[id]/export/+server';

it('serves complete Standard copy and strict validation through authenticated handlers without object/event writes', async () => {
	const t = createTestDb();
	seedBase(t);
	const event = (path: string, raw?: string) => ({
		locals: { user: { id: USER, name: 'Alice' } },
		platform: { env: t.env, ctx: { waitUntil: () => {} } },
		url: new URL(`http://test/api/v1/${path}`),
		params: { id: 'wf_standard' },
		request: new Request(`http://test/api/v1/${path}`, raw ? { method: 'POST', body: raw } : {})
	});
	const before = await t.db.selectFrom('event').selectAll().execute();
	const exported = await GET(
		event('workflows/wf_standard/export') as unknown as Parameters<typeof GET>[0]
	);
	expect(exported.status).toBe(200);
	const document = await exported.json();
	expect(document).toMatchObject({ profile: 'workflow', main_workflow_id: 'workflow:1' });
	const validated = await POST(
		event(
			'library/validate',
			JSON.stringify({ document_json: JSON.stringify(document) })
		) as unknown as Parameters<typeof POST>[0]
	);
	expect(validated.status).toBe(200);
	expect(await validated.json()).toMatchObject({ valid: true, digest: document.digest });
	for (const raw of ['{"document_json":"{}","document_json":"{}"}', '{"document_json":{}}']) {
		const invalid = await POST(
			event('library/validate', raw) as unknown as Parameters<typeof POST>[0]
		);
		expect(invalid.status).toBeGreaterThanOrEqual(400);
	}
	const unknown = await GET(
		event('workflows/wf_standard/export?unknown=yes') as unknown as Parameters<typeof GET>[0]
	);
	expect(unknown.status).toBe(422);
	expect(await t.db.selectFrom('event').selectAll().execute()).toEqual(before);
});
