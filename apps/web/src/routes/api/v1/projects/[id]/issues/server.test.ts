import { describe, expect, it } from 'vitest';
import { createTestDb } from '$lib/server/api/test-db';
import { addIssue, PROJECT, seedBase, USER } from '$lib/server/supervisor/test-fixtures';
import { GET, POST } from './+server';

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

async function multipartRequest(form: FormData, contentLength = true): Promise<Request> {
	const encoded = new Request('http://test', { method: 'POST', body: form });
	const bytes = await encoded.arrayBuffer();
	const headers = new Headers({ 'content-type': encoded.headers.get('content-type')! });
	if (contentLength) headers.set('content-length', String(bytes.byteLength));
	return new Request('http://test/api/v1/projects/prj_1/issues', {
		method: 'POST',
		headers,
		body: bytes
	});
}

async function post(request: Request) {
	const t = createTestDb();
	seedBase(t);
	const event = {
		locals: { user: { id: USER, name: 'alice' } },
		platform: { env: t.env, ctx: { waitUntil: () => {} } },
		params: { id: PROJECT },
		request,
		url: new URL(request.url)
	};
	const response = await POST(event as unknown as Parameters<typeof POST>[0]);
	return { t, response, body: (await response.json()) as any };
}

describe('POST /api/v1/projects/:id/issues multipart', () => {
	it('creates the issue and indexed file parts together', async () => {
		const form = new FormData();
		form.append(
			'metadata',
			JSON.stringify({
				issue: { title: 'Screenshot attached' },
				attachments: [{ part: 'file-0', name: 'screen', filename: 'screen.png' }]
			})
		);
		form.append('file-0', new Blob([new Uint8Array([137, 80, 78, 71])]), 'transport-name');
		const result = await post(await multipartRequest(form));
		expect(result.response.status).toBe(201);
		expect(result.body.title).toBe('Screenshot attached');
		const version = result.t.all(
			'SELECT filename, content_type, size_bytes FROM artifact_version'
		)[0];
		expect(version).toEqual({
			filename: 'screen.png',
			content_type: 'application/octet-stream',
			size_bytes: 4
		});
	});

	it('requires content length before parsing', async () => {
		const form = new FormData();
		form.append('metadata', '{}');
		const result = await post(await multipartRequest(form, false));
		expect(result.response.status).toBe(411);
		expect(result.body.error.code).toBe('length_required');
	});

	it('rejects missing, duplicate, and unlisted parts', async () => {
		const form = new FormData();
		form.append(
			'metadata',
			JSON.stringify({
				issue: { title: 'Bad' },
				attachments: [{ part: 'file-0', name: 'one', filename: 'one.txt' }]
			})
		);
		form.append('extra', new Blob(['x']), 'extra.txt');
		const result = await post(await multipartRequest(form));
		expect(result.response.status).toBe(422);
		expect(result.body.error.code).toBe('invalid_field');
		expect(result.t.all('SELECT id FROM issue')).toEqual([]);
	});
});
