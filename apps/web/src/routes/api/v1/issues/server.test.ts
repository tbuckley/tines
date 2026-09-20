import { describe, expect, it } from 'vitest';
import { createTestDb } from '$lib/server/api/test-db';
import { addIssue, seedBase, USER } from '$lib/server/supervisor/test-fixtures';
import { GET } from './+server';

async function list(value: string | null) {
	const t = createTestDb();
	seedBase(t);
	const canonical = addIssue(t, { id: 'iss_canonical', title: 'Canonical' });
	const duplicate = addIssue(t, { id: 'iss_duplicate', title: 'Duplicate' });
	t.sqlite
		.prepare(
			`INSERT INTO issue_link (id, source_issue_id, target_issue_id, kind, created_at)
			 VALUES ('lnk_duplicate', ?, ?, 'duplicate_of', 0)`
		)
		.run(duplicate, canonical);
	const url = new URL('http://test/api/v1/issues');
	if (value !== null) url.searchParams.set('hide_duplicates', value);
	const event = {
		locals: { user: { id: USER, name: 'alice' } },
		platform: { env: t.env, ctx: { waitUntil: () => {} } },
		params: {},
		request: new Request(url),
		url
	};
	const response = await GET(event as unknown as Parameters<typeof GET>[0]);
	return (await response.json()) as { items: Array<{ id: string }> };
}

describe('GET /api/v1/issues duplicate visibility', () => {
	it.each([
		[null, false],
		['', false],
		['true', false],
		['1', false],
		['unknown', false],
		['false', true],
		['0', true]
	] as const)('parses hide_duplicates=%s', async (value, includesDuplicate) => {
		const body = await list(value);
		expect(body.items.map((item) => item.id).includes('iss_duplicate')).toBe(includesDuplicate);
		expect(body.items.map((item) => item.id)).toContain('iss_canonical');
	});
});
