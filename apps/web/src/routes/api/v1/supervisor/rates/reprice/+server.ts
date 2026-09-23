import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { api, apiContext, readJson, requireString } from '$lib/server/api/core';
import { repriceRate } from '$lib/server/api/rates';

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<{ model?: unknown; cursor?: unknown }>(event);
	const cursor = body.cursor == null ? null : requireString(body.cursor, 'cursor');
	return json(
		await repriceRate(db, env, actor.userId, requireString(body.model, 'model'), cursor)
	);
});
