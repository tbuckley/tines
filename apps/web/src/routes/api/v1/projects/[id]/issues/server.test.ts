import { describe, expect, it } from 'vitest';
import { createTestDb } from '$lib/server/api/test-db';
import { addIssue, PROJECT, seedBase, USER } from '$lib/server/supervisor/test-fixtures';
import { GET } from './+server';

async function list(query: string) {
	const t = createTestDb();
	seedBase(t);
	t.sqlite.exec(`
		INSERT INTO workflow (id, user_id, name, initial_state_id, created_at, updated_at)
			VALUES ('wf_other', '${USER}', 'Other', 'wfs_other_open', 0, 0);
		INSERT INTO workflow_state (id, workflow_id, name, category, position, created_at)
			VALUES ('wfs_other_open', 'wf_other', 'Open', 'active', 0, 0);
	`);
	const standard = addIssue(t, { id: 'iss_standard', title: 'Standard issue' });
	const other = addIssue(t, {
		id: 'iss_other',
		title: 'Other issue',
		workflow: 'wf_other',
		state: 'wfs_other_open'
	});
	const url = new URL(`http://test/api/v1/projects/${PROJECT}/issues${query}`);
	const event = {
		locals: { user: { id: USER, name: 'alice' } },
		platform: { env: t.env, ctx: { waitUntil: () => {} } },
		params: { id: PROJECT },
		request: new Request(url, { method: 'GET' }),
		url
	};
	const response = await GET(event as unknown as Parameters<typeof GET>[0]);
	return {
		status: response.status,
		body: (await response.json()) as { items: Array<{ id: string }> },
		standard,
		other
	};
}

describe('GET /api/v1/projects/:id/issues', () => {
	it.each([
		['wf_standard', 'iss_standard'],
		['Standard', 'iss_standard'],
		['wf_other', 'iss_other'],
		['Other', 'iss_other']
	])('forwards workflow ref %s', async (workflow, expected) => {
		const result = await list(`?workflow=${encodeURIComponent(workflow)}`);
		expect(result.status).toBe(200);
		expect(result.body.items.map((item) => item.id)).toEqual([expected]);
	});

	it('returns no rows for an unknown workflow', async () => {
		const result = await list('?workflow=wf_missing');
		expect(result.status).toBe(200);
		expect(result.body.items).toEqual([]);
	});
});
