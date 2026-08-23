import type { TimeResponse } from '@tines/shared';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => {
	const res = await fetch('/api/time');
	return {
		time: (await res.json()) as TimeResponse
	};
};
