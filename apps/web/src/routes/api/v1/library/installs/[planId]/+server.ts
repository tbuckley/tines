import { json } from '@sveltejs/kit';
import { api, apiContext, requireString } from '$lib/server/api/core';
import { getWorkflowPackageReceipt } from '$lib/server/library/install';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	return json(
		await getWorkflowPackageReceipt(
			db,
			actor,
			requireString(event.params.planId, 'planId', { max: 150 })
		)
	);
});
