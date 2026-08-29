import { json } from '@sveltejs/kit';
import { ARTIFACT_FOLDER_MAX_BYTES } from '@tines/shared';
import { uploadArtifactFolder, type FolderUploadFile } from '$lib/server/api/artifacts';
import { api, apiContext, ApiFail } from '$lib/server/api/core';
import type { RequestHandler } from './$types';

/**
 * Multipart snapshot upload for `folder` artifacts: one part per file, the
 * workspace-relative path as the part's filename and the declared MIME as
 * the part's content type (field names are ignored). A folder version is
 * always born whole — there are no per-file writes.
 */
export const PUT: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	// The multipart parse buffers in memory; a declared length far past the
	// cap is rejected before reading (multipart overhead gets some slack —
	// the exact per-file/total caps are enforced after the parse).
	const declared = Number(event.request.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > ARTIFACT_FOLDER_MAX_BYTES + 10 * 1024 * 1024) {
		throw new ApiFail(
			422,
			'artifact_too_large',
			`A folder version can total at most ${ARTIFACT_FOLDER_MAX_BYTES} bytes (Content-Length says ${declared})`,
			{ max_bytes: ARTIFACT_FOLDER_MAX_BYTES, size_bytes: declared }
		);
	}
	let form: FormData;
	try {
		form = await event.request.formData();
	} catch {
		throw new ApiFail(
			422,
			'invalid_field',
			'Send the folder snapshot as multipart/form-data: one part per file, its path as the part filename and its MIME type as the part content type'
		);
	}
	const files: FolderUploadFile[] = [];
	for (const [, value] of form.entries()) {
		if (typeof value === 'string') continue;
		files.push({
			path: value.name,
			contentType: value.type || 'application/octet-stream',
			bytes: new Uint8Array(await value.arrayBuffer())
		});
	}
	return json(await uploadArtifactFolder(db, env, actor, event.params.id, event.params.name, files));
});
