import type { RequestHandler } from './$types';
import { deploymentIdentity } from '$lib/server/deployment';
import { MAX_BODY_BYTES, parseTelemetry, toDataPoint } from '$lib/server/telemetry';

/**
 * Real-user latency telemetry from the app's own pages (lib/perf/telemetry.ts).
 * Signed-in browsers only; anything malformed is dropped rather than refused,
 * so a bad record never costs the rest of its batch. Always 204: a beacon
 * has nobody to read an error.
 */
export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const dataset = platform?.env.PERF;
	if (!locals.user || !dataset) return new Response(null, { status: 204 });
	const text = await request.text();
	if (text.length > MAX_BODY_BYTES) return new Response(null, { status: 204 });
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return new Response(null, { status: 204 });
	}
	const cf = platform.cf;
	const ctx = {
		colo: typeof cf?.colo === 'string' ? cf.colo : '',
		country: typeof cf?.country === 'string' ? cf.country : '',
		version: deploymentIdentity.version
	};
	for (const r of parseTelemetry(body)) dataset.writeDataPoint(toDataPoint(r, ctx));
	return new Response(null, { status: 204 });
};
