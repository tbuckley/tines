import { json } from '@sveltejs/kit';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { readUpload } from '$lib/server/api/packs/install';
import type { RequestHandler } from './$types';

/** Validates an uploaded pack without installing it. Needs no project. */
export const POST: RequestHandler = api(async (event) => {
	await apiContext(event);
	const parsed = await readUpload(await readJson(event));
	return json({
		digest: parsed.digest,
		errors: parsed.errors,
		warnings: parsed.warnings,
		model: parsed.model,
		files: parsed.files.map((f) => f.path)
	});
});
