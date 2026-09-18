import { expect, it } from 'vitest';
import { createTestDb } from '$lib/server/api/test-db';
import { seedBase, USER } from '$lib/server/supervisor/test-fixtures';
import { createWorkflow } from '$lib/server/api/workflows';
import { POST } from './+server';
import { GET } from '../export/+server';

function event(t: ReturnType<typeof createTestDb>, method: string, route: string, raw?: string) {
	const url = new URL(`http://test/api/v1/${route}`);
	return {
		locals: { user: { id: USER, name: 'Alice' } },
		platform: { env: t.env, ctx: { waitUntil: () => {} } },
		request: new Request(url, {
			method,
			...(raw ? { body: raw, headers: { 'content-type': 'application/json' } } : {})
		}),
		url
	};
}
it('exports v3 by default and imports the same file through the route, with explicit v2 compatibility', async () => {
	const t = createTestDb();
	seedBase(t);
	await createWorkflow(
		t.db,
		t.env,
		{ userId: USER, userName: 'Alice', apiKeyId: null, apiKeyName: null, viaSession: true },
		{
			name: 'Portable',
			initial_state: 'Start',
			states: [{ name: 'Start', category: 'active' }],
			transitions: []
		}
	);
	const res = await GET(event(t, 'GET', 'export') as unknown as Parameters<typeof GET>[0]);
	expect(res.status).toBe(200);
	const document = await res.json();
	expect(document).toMatchObject({ version: 3, profile: 'library' });
	const imported = await POST(
		event(
			t,
			'POST',
			'import',
			JSON.stringify({ document, dry_run: true })
		) as unknown as Parameters<typeof POST>[0]
	);
	expect(imported.status).toBe(200);
	expect(await imported.json()).toMatchObject({
		applied: false,
		counts: { create: 0, refuse: 0, error: 0 }
	});
	const old = await GET(
		event(t, 'GET', 'export?version=2') as unknown as Parameters<typeof GET>[0]
	);
	expect(await old.json()).toMatchObject({ version: 2 });
});
it('rejects duplicate JSON keys before object decoding can erase them', async () => {
	const t = createTestDb();
	seedBase(t);
	for (const raw of ['{"document":null,"document":{}}', '{"document":{"version":3,"version":2}}']) {
		const res = await POST(
			event(t, 'POST', 'import', raw) as unknown as Parameters<typeof POST>[0]
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			error: { code: 'invalid_json', details: { diagnostics: [{ code: 'duplicate_key' }] } }
		});
	}
});
