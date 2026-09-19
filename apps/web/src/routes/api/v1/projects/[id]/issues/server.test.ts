import {
	ARTIFACT_FILE_MAX_BYTES,
	ISSUE_CREATE_FILES_MAX_BYTES,
	ISSUE_CREATE_MAX_FILES,
	ISSUE_CREATE_METADATA_MAX_BYTES,
	ISSUE_CREATE_MULTIPART_MAX_BYTES
} from '@tines/shared';
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
	let puts = 0;
	t.env.ARTIFACTS = {
		put: async () => {
			puts++;
		}
	} as unknown as NonNullable<Env['ARTIFACTS']>;
	const event = {
		locals: { user: { id: USER, name: 'alice' } },
		platform: { env: t.env, ctx: { waitUntil: () => {} } },
		params: { id: PROJECT },
		request,
		url: new URL(request.url)
	};
	const response = await POST(event as unknown as Parameters<typeof POST>[0]);
	return { t, puts: () => puts, response, body: (await response.json()) as any };
}

function validForm(
	attachments: { name: string; filename: string; bytes?: number; type?: string }[] = [
		{ name: 'screen', filename: 'screen.png' }
	]
) {
	const form = new FormData();
	form.append(
		'metadata',
		JSON.stringify({
			issue: { title: 'Multipart issue' },
			attachments: attachments.map((attachment, index) => ({
				part: `file-${index}`,
				name: attachment.name,
				filename: attachment.filename
			}))
		})
	);
	for (const [index, attachment] of attachments.entries()) {
		form.append(
			`file-${index}`,
			new Blob([new Uint8Array(attachment.bytes ?? 1)], { type: attachment.type }),
			'transport-name'
		);
	}
	return form;
}

async function expectRejected(request: Request, code: string) {
	const result = await post(request);
	expect(result.response.status).toBe(422);
	expect(result.body.error.code).toBe(code);
	expect(result.puts()).toBe(0);
	expect(result.t.all('SELECT id FROM issue')).toEqual([]);
	expect(result.t.all("SELECT id FROM context_item WHERE kind = 'artifact'")).toEqual([]);
	return result;
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

	it.each(['nope', '-1', '1.5', 'Infinity'])('rejects invalid content length %s', async (value) => {
		const request = await multipartRequest(validForm());
		request.headers.set('content-length', value);
		const result = await post(request);
		expect(result.response.status).toBe(411);
		expect(result.body.error.code).toBe('length_required');
		expect(result.puts()).toBe(0);
		expect(result.t.all('SELECT id FROM issue')).toEqual([]);
	});

	it('rejects an oversized declaration before consuming the body', async () => {
		const request = await multipartRequest(validForm());
		request.headers.set('content-length', String(ISSUE_CREATE_MULTIPART_MAX_BYTES + 1));
		await expectRejected(request, 'artifact_too_large');
	});

	it('rejects an understated content length', async () => {
		const request = await multipartRequest(validForm());
		request.headers.set(
			'content-length',
			String(Number(request.headers.get('content-length')) - 1)
		);
		await expectRejected(request, 'invalid_field');
	});

	it('rejects an actual stream larger than the multipart body limit', async () => {
		const bytes = new Uint8Array(ISSUE_CREATE_MULTIPART_MAX_BYTES + 1);
		const request = new Request('http://test/api/v1/projects/prj_1/issues', {
			method: 'POST',
			headers: {
				'content-type': 'multipart/form-data; boundary=limit',
				'content-length': '1'
			},
			body: bytes
		});
		await expectRejected(request, 'artifact_too_large');
	});

	it('rejects a broken multipart boundary', async () => {
		const bytes = new TextEncoder().encode('--wrong--');
		const request = new Request('http://test/api/v1/projects/prj_1/issues', {
			method: 'POST',
			headers: {
				'content-type': 'multipart/form-data; boundary=expected',
				'content-length': String(bytes.byteLength)
			},
			body: bytes
		});
		await expectRejected(request, 'invalid_field');
	});

	it('pins the zero and eleven-entry file-count bounds', async () => {
		await expectRejected(await multipartRequest(validForm([])), 'artifact_file_limit');
		await expectRejected(
			await multipartRequest(
				validForm(
					Array.from({ length: ISSUE_CREATE_MAX_FILES + 1 }, (_, index) => ({
						name: `file-${index}`,
						filename: `file-${index}.txt`
					}))
				)
			),
			'artifact_file_limit'
		);
	});

	it('accepts exactly ten files', async () => {
		const result = await post(
			await multipartRequest(
				validForm(
					Array.from({ length: ISSUE_CREATE_MAX_FILES }, (_, index) => ({
						name: `file-${index}`,
						filename: `file-${index}.txt`
					}))
				)
			)
		);
		expect(result.response.status).toBe(201);
		expect(result.puts()).toBe(ISSUE_CREATE_MAX_FILES);
		expect(result.t.all("SELECT id FROM context_item WHERE kind = 'artifact'")).toHaveLength(
			ISSUE_CREATE_MAX_FILES
		);
	});

	it('accepts exact metadata and aggregate limits, then rejects one byte over each', async () => {
		const attachments = [
			{ name: 'one', filename: 'one.bin', bytes: ARTIFACT_FILE_MAX_BYTES },
			{ name: 'two', filename: 'two.bin', bytes: ARTIFACT_FILE_MAX_BYTES }
		];
		const exact = validForm(attachments);
		const base = JSON.parse(exact.get('metadata') as string);
		base.issue.padding = '';
		let metadata = JSON.stringify(base);
		base.issue.padding = 'x'.repeat(ISSUE_CREATE_METADATA_MAX_BYTES - metadata.length);
		metadata = JSON.stringify(base);
		expect(new TextEncoder().encode(metadata)).toHaveLength(ISSUE_CREATE_METADATA_MAX_BYTES);
		exact.set('metadata', metadata);
		const accepted = await post(await multipartRequest(exact));
		expect(accepted.response.status).toBe(201);
		expect(accepted.puts()).toBe(2);

		base.issue.padding += 'x';
		const metadataOver = validForm();
		metadataOver.set('metadata', JSON.stringify(base));
		await expectRejected(await multipartRequest(metadataOver), 'artifact_too_large');

		await expectRejected(
			await multipartRequest(
				validForm([
					{ name: 'one', filename: 'one.bin', bytes: ARTIFACT_FILE_MAX_BYTES },
					{ name: 'two', filename: 'two.bin', bytes: ARTIFACT_FILE_MAX_BYTES },
					{ name: 'extra', filename: 'extra.bin', bytes: 1 }
				])
			),
			'artifact_too_large'
		);
		expect(ISSUE_CREATE_FILES_MAX_BYTES).toBe(ARTIFACT_FILE_MAX_BYTES * 2);
	});

	it('pins the per-file size bound', async () => {
		await expectRejected(
			await multipartRequest(
				validForm([{ name: 'large', filename: 'large.bin', bytes: ARTIFACT_FILE_MAX_BYTES + 1 }])
			),
			'artifact_too_large'
		);
	});

	it('rejects duplicate metadata, duplicate/missing/string/unlisted file parts', async () => {
		const duplicateMetadata = validForm();
		duplicateMetadata.append('metadata', duplicateMetadata.get('metadata') as string);
		await expectRejected(await multipartRequest(duplicateMetadata), 'invalid_field');

		const duplicateFile = validForm();
		duplicateFile.append('file-0', new Blob(['again']), 'again.txt');
		await expectRejected(await multipartRequest(duplicateFile), 'invalid_field');

		const missing = validForm();
		missing.delete('file-0');
		await expectRejected(await multipartRequest(missing), 'invalid_field');

		const stringPart = validForm();
		stringPart.set('file-0', 'not a file');
		await expectRejected(await multipartRequest(stringPart), 'invalid_field');

		const unlisted = validForm();
		unlisted.append('extra', new Blob(['x']), 'extra.txt');
		await expectRejected(await multipartRequest(unlisted), 'invalid_field');
	});

	it('returns indexed errors for invalid names, filenames, and MIME types', async () => {
		for (const attachment of [
			{ name: 'Bad Name', filename: 'ok.txt' },
			{ name: 'ok', filename: '../bad.txt' },
			{ name: 'ok', filename: 'ok.txt', type: 'not-a-mime' }
		]) {
			const result = await expectRejected(
				await multipartRequest(validForm([attachment])),
				'invalid_field'
			);
			expect(result.body.error.details.attachment_index).toBe(0);
		}
	});

	it('uses application/octet-stream when the file part has no MIME type', async () => {
		const result = await post(await multipartRequest(validForm()));
		expect(result.response.status).toBe(201);
		expect(result.t.all('SELECT content_type FROM artifact_version')).toEqual([
			{ content_type: 'application/octet-stream' }
		]);
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
