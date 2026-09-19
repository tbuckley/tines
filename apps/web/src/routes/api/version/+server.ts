import { deploymentIdentity } from '$lib/server/deployment';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const headers = { 'cache-control': 'no-store' };

export const GET: RequestHandler = () => json(deploymentIdentity, { headers });
export const HEAD: RequestHandler = () => new Response(null, { headers });
