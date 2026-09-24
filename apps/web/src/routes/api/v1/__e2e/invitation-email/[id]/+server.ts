import { json } from '@sveltejs/kit';
import { readIsolatedInvitation } from '$lib/server/api/invitation-email';
import { notFound } from '$lib/server/api/core';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = async ({ params }) => {
	const url = readIsolatedInvitation(params.id);
	if (!url) throw notFound();
	return json({ url }, { headers: { 'cache-control': 'no-store' } });
};
