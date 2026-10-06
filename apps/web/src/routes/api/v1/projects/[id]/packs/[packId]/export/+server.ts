import { json } from '@sveltejs/kit';
import { api, apiContext } from '$lib/server/api/core';
import { b64ToBytes } from '$lib/server/api/packs/model';
import { exportPack } from '$lib/server/api/packs/install';
import { writePackArchive, packFolderName } from '@tines/shared/packs';
import type { RequestHandler } from './$types';

/**
 * Exports the pack. JSON by default (`PackExport`); `?format=zip` returns the
 * `.tinespack` file itself.
 */
export const GET: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const out = await exportPack(db, env, actor, event.params.id, event.params.packId);
	if (event.url.searchParams.get('format') !== 'zip') return json(out);
	const zip = writePackArchive(
		out.files.map((f) => ({ path: f.path, bytes: b64ToBytes(f.content_b64) })),
		packFolderName(out.pack_key)
	);
	return new Response(zip as Uint8Array<ArrayBuffer>, {
		headers: {
			'content-type': 'application/zip',
			'content-disposition': `attachment; filename="${out.filename}"`,
			'x-pack-digest': out.digest,
			'x-pack-version': String(out.version)
		}
	});
});
