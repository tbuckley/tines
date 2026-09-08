import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ArtifactSiteLink } from '@tines/shared';
import { createTestDb, type TestDb } from '$lib/server/api/test-db';
import { USER, seedBase, addIssue } from '$lib/server/supervisor/test-fixtures';
import { upsertArtifact, artifactSiteResponse } from '$lib/server/api/artifacts';
import { POST } from './+server';

let t: TestDb;
let issueId: string;
const actor = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};
beforeEach(async () => {
	t = createTestDb();
	seedBase(t);
	t.env.BETTER_AUTH_SECRET = 'site-route-test';
	issueId = addIssue(t);
	for (const version of [1, 2]) {
		await upsertArtifact(t.db, t.env, actor, issueId, 'prototype', {
			type: 'text',
			content: `<h1>v${version}</h1>`,
			content_type: 'text/html'
		});
	}
});
afterEach(() => t.sqlite.close());

async function post(body?: unknown) {
	const url = new URL(`https://tines.test/api/v1/issues/${issueId}/artifacts/prototype/site-link`);
	return POST({
		locals: { user: { id: USER, name: 'alice' } },
		platform: { env: t.env, ctx: { waitUntil: () => {} } },
		request: new Request(url, {
			method: 'POST',
			...(body === undefined
				? {}
				: {
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(body)
					})
		}),
		params: { id: issueId, name: 'prototype' },
		url
	} as unknown as Parameters<typeof POST>[0]);
}

describe('POST artifact site-link', () => {
	it.each([
		{ version: 1, body: { version: 1 } },
		{ version: 2, body: {} },
		{ version: 2, body: undefined }
	])('pins and serves v$version for body $body', async ({ version, body }) => {
		const response = await post(body);
		expect(response.status).toBe(200);
		const link = (await response.json()) as ArtifactSiteLink;
		expect(link.version).toBe(version);
		const url = new URL(link.url);
		const served = await artifactSiteResponse(t.db, t.env, url, url.pathname.split('/')[2], '');
		expect(served.status).toBe(200);
		expect(await served.text()).toBe(`<h1>v${version}</h1>`);
	});
	it.each([0, -1, 1.5, '1', true, {}, []].map((version) => ({ version })))(
		'rejects invalid version $version at the boundary',
		async ({ version }) => {
			const response = await post({ version });
			expect(response.status).toBe(422);
			expect(await response.json()).toMatchObject({
				error: { code: 'invalid_field', details: { field: 'version' } }
			});
		}
	);
});
