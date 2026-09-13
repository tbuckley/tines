import { describe, expect, it } from 'vitest';
import { createTestDb } from '$lib/server/api/test-db';
import {
	addIssue,
	addTransitionEvent,
	NOW,
	OPEN,
	REVIEW,
	seedBase,
	USER
} from '$lib/server/supervisor/test-fixtures';
import { GET } from './+server';

async function list(t: ReturnType<typeof createTestDb>, query: string) {
	const url = new URL(`http://test/api/v1/events${query}`);
	const event = {
		locals: { user: { id: USER, name: 'alice' } },
		platform: { env: t.env, ctx: { waitUntil: () => {} } },
		request: new Request(url, { method: 'GET' }),
		url
	};
	const response = await GET(event as unknown as Parameters<typeof GET>[0]);
	return (await response.json()) as { items: { id: string; created_at: number }[] };
}

describe('GET /api/v1/events window filters', () => {
	it('combines inclusive since, exclusive until and payload state', async () => {
		const t = createTestDb();
		seedBase(t);
		const issue = addIssue(t);
		addTransitionEvent(t, {
			issueId: issue,
			apiKeyId: null,
			at: NOW - 3000,
			from: OPEN,
			to: REVIEW
		});
		addTransitionEvent(t, {
			issueId: issue,
			apiKeyId: null,
			at: NOW - 2000,
			from: REVIEW,
			to: OPEN
		});
		addTransitionEvent(t, {
			issueId: issue,
			apiKeyId: null,
			at: NOW - 1000,
			from: REVIEW,
			to: OPEN
		});

		addTransitionEvent(t, { issueId: issue, apiKeyId: null, at: NOW - 1500, from: OPEN, to: OPEN });
		const { items } = await list(
			t,
			`?since=${NOW - 2000}&until=${NOW - 1000}&state=${encodeURIComponent(REVIEW)}&type=issue.transitioned,issue.created`
		);
		expect(items.map((item) => item.created_at)).toEqual([NOW - 2000]);
	});
});
