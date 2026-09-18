import { json } from '@sveltejs/kit';
import { parseStrictLibraryJson, type ExportWorkflowPackageOptions } from '@tines/shared';
import { api, apiContext, ApiFail } from '$lib/server/api/core';
import { buildWorkflowPackage } from '$lib/server/api/library-packages';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const params = event.url.searchParams;
	if (new TextEncoder().encode(event.url.search).byteLength > 512 * 1024)
		throw new ApiFail(413, 'package_too_large', 'Export choices exceed 512 KiB');
	if (['source_project_id', 'authoring'].some((key) => params.getAll(key).length > 1))
		throw new ApiFail(422, 'invalid_export_options', 'Duplicate singleton export parameter');
	if (
		[...params.keys()].some(
			(key) => !['source_project_id', 'schedule_id', 'tier', 'authoring'].includes(key)
		)
	)
		throw new ApiFail(422, 'invalid_export_options', 'Unknown export query parameter');
	let options: ExportWorkflowPackageOptions;
	try {
		options = {
			...(params.has('source_project_id')
				? { source_project_id: params.get('source_project_id')! }
				: {}),
			schedule_ids: params.getAll('schedule_id'),
			tiers: params
				.getAll('tier')
				.map((value) => parseStrictLibraryJson(value)) as ExportWorkflowPackageOptions['tiers'],
			...(params.has('authoring')
				? {
						authoring: parseStrictLibraryJson(
							params.get('authoring')!
						) as ExportWorkflowPackageOptions['authoring']
					}
				: {})
		};
	} catch {
		throw new ApiFail(400, 'invalid_json', 'Tier and authoring selectors must be strict JSON');
	}
	return json(await buildWorkflowPackage(db, actor.userId, event.params.id, options));
});
