import { json } from '@sveltejs/kit';
import type { TimeResponse } from '@tines/shared';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => {
	const now = new Date();
	const body: TimeResponse = {
		time: now.toISOString(),
		unix: now.getTime()
	};
	return json(body);
};
