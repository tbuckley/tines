/**
 * Route-level guard wiring for the raw upload. `uploadArtifactFile` never
 * sees a Content-Type it should refuse — the "this endpoint does not take
 * JSON" check lives only in this handler, so only a test that drives the
 * handler can pin which requests it refuses. The guard is deliberately
 * narrow: it fires on a *misdirected JSON client* (no `?filename=`), never
 * on a genuine upload of a `.json` file (Tines/242).
 */
import { TEST_NOOP_DISPATCH_EFFECTS } from '$lib/server/api/test-dispatch-effects';
import { describe, expect, it } from 'vitest';
import { artifactContentResponse, getArtifactDetail } from '$lib/server/api/artifacts';
import type { ActorContext } from '$lib/server/api/core';
import { createIssue } from '$lib/server/api/issues';
import { createTestDb, type TestDb } from '$lib/server/api/test-db';
import { PROJECT, seedBase, USER } from '$lib/server/supervisor/test-fixtures';
import { PUT } from './+server';

const actor: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

async function upload(
	t: TestDb,
	issueId: string,
	name: string,
	opts: { filename?: string; contentType?: string | null; body: string }
) {
	// A raw Uint8Array body, never a string: fetch stamps
	// `text/plain;charset=UTF-8` onto a string body, which would hide the
	// missing-Content-Type case.
	const bytes = new TextEncoder().encode(opts.body);
	const query = opts.filename === undefined ? '' : `?filename=${encodeURIComponent(opts.filename)}`;
	const url = new URL(`http://test/api/v1/issues/${issueId}/artifacts/${name}/file${query}`);
	const headers: Record<string, string> = { 'content-length': String(bytes.byteLength) };
	if (opts.contentType !== null && opts.contentType !== undefined) {
		headers['content-type'] = opts.contentType;
	}
	const event = {
		params: { id: issueId, name },
		locals: { user: { id: USER, name: 'alice' } },
		platform: { env: t.env, ctx: { waitUntil: () => {} } },
		request: new Request(url, { method: 'PUT', headers, body: bytes }),
		url
	};
	return PUT(event as unknown as Parameters<typeof PUT>[0]);
}

async function errorOf(res: Response) {
	return (await res.json()) as { error: { code: string; message: string; details?: unknown } };
}

describe('PUT /api/v1/issues/:id/artifacts/:name/file', () => {
	it('accepts application/json bytes when ?filename= names a file', async () => {
		const t = createTestDb();
		seedBase(t);
		const issue = await createIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, PROJECT, {
			title: 'JSON'
		});
		const payload = '{"findings":[{"id":1,"note":"café ☕"}]}';

		const res = await upload(t, issue.id, 'report', {
			filename: 'report.json',
			contentType: 'application/json',
			body: payload
		});
		expect(res.status).toBe(200);

		const detail = await getArtifactDetail(t.db, actor.userId, issue.id, 'report');
		expect(detail.current_version).toMatchObject({
			filename: 'report.json',
			content_type: 'application/json'
		});

		// Byte-identical round trip, not just a matching MIME label.
		const content = await artifactContentResponse(t.db, t.env, actor.userId, issue.id, 'report');
		expect(await content.text()).toBe(payload);
		// JSON is not on the inline allowlist: it is served as a download.
		expect(content.headers.get('content-disposition')).toBe('attachment; filename="report.json"');
	});

	it('refuses a JSON body with no filename, naming the JSON mistake', async () => {
		const t = createTestDb();
		seedBase(t);
		const issue = await createIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, PROJECT, {
			title: 'JSON'
		});

		const res = await upload(t, issue.id, 'report', {
			contentType: 'application/json; charset=utf-8',
			body: '{"type":"text","content":"oops"}'
		});
		expect(res.status).toBe(422);
		const err = await errorOf(res);
		expect(err.error.code).toBe('invalid_field');
		expect(err.error.message).toContain('does not take JSON');
		expect(err.error.details).toMatchObject({ field: 'content_type' });
	});

	it('asks for ?filename= when the body is not JSON', async () => {
		const t = createTestDb();
		seedBase(t);
		const issue = await createIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, PROJECT, {
			title: 'JSON'
		});

		const res = await upload(t, issue.id, 'report', {
			contentType: 'text/markdown',
			body: '# notes'
		});
		expect(res.status).toBe(422);
		const err = await errorOf(res);
		expect(err.error.message).toContain('?filename=');
		expect(err.error.details).toMatchObject({ field: 'filename' });
	});

	it('still requires a Content-Type on a named upload', async () => {
		const t = createTestDb();
		seedBase(t);
		const issue = await createIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, PROJECT, {
			title: 'JSON'
		});

		const res = await upload(t, issue.id, 'report', {
			filename: 'report.json',
			contentType: null,
			body: '{}'
		});
		expect(res.status).toBe(422);
		expect((await errorOf(res)).error.details).toMatchObject({ field: 'content_type' });
	});
});
