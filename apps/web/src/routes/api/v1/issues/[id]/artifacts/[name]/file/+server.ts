import { json } from '@sveltejs/kit';
import { ARTIFACT_FILE_MAX_BYTES } from '@tines/shared';
import { uploadArtifactFile } from '$lib/server/api/artifacts';
import { api, apiContext, ApiFail } from '$lib/server/api/core';
import { actorForIssue } from '$lib/server/api/project-access';
import type { RequestHandler } from './$types';

/**
 * Raw-body upload for `file` artifacts — the one non-JSON write endpoint.
 * Bytes in the body, MIME in Content-Type, display name in ?filename=….
 */
export const PUT: RequestHandler = api(async (event) => {
	const { db, env, actor: requester } = await apiContext(event);
	// Members work on shared issues with the owner's scope (project-access.ts).
	const actor = await actorForIssue(db, requester, event.params.id);
	const filename = event.url.searchParams.get('filename');
	const contentType = event.request.headers.get('content-type');
	// `?filename=` is what makes this a file upload, so the JSON guard is
	// only about a misdirected client: no filename plus a JSON body is
	// someone who meant the JSON upsert next door, and gets told so before
	// the generic missing-filename 422. A request that *does* name a file is
	// an upload whatever its MIME type — `.json` included (Tines/242).
	if (!filename) {
		if (!contentType || contentType.startsWith('application/json')) {
			throw new ApiFail(
				422,
				'invalid_field',
				'Send the file bytes as the raw request body with its MIME type in Content-Type (this endpoint does not take JSON)',
				{ field: 'content_type' }
			);
		}
		throw new ApiFail(422, 'invalid_field', 'Pass the display file name as ?filename=…', {
			field: 'filename'
		});
	}
	if (!contentType) {
		throw new ApiFail(
			422,
			'invalid_field',
			'Send the file bytes as the raw request body with its MIME type in Content-Type',
			{ field: 'content_type' }
		);
	}
	// The declared length gates before any bytes are buffered; the actual
	// size is re-checked after the read (the store never sees an oversize).
	// The header must be checked for absence before Number(): Number(null)
	// is 0, which would wave a chunked no-length upload past both gates.
	const declaredHeader = event.request.headers.get('content-length');
	const declared = declaredHeader === null ? Number.NaN : Number(declaredHeader);
	if (!Number.isFinite(declared)) {
		throw new ApiFail(411, 'length_required', 'Content-Length is required for artifact uploads');
	}
	if (declared > ARTIFACT_FILE_MAX_BYTES) {
		throw new ApiFail(
			422,
			'artifact_too_large',
			`An artifact file can be at most ${ARTIFACT_FILE_MAX_BYTES} bytes (Content-Length says ${declared})`,
			{ max_bytes: ARTIFACT_FILE_MAX_BYTES, size_bytes: declared }
		);
	}
	const bytes = new Uint8Array(await event.request.arrayBuffer());
	return json(
		await uploadArtifactFile(db, env, actor, event.params.id, event.params.name, {
			filename,
			contentType: contentType.split(';')[0].trim(),
			bytes
		})
	);
});
