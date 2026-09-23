import { error } from '@sveltejs/kit';
import { api, apiContext } from '$lib/server/api/core';
import { getFullRunLog } from '$lib/server/api/runs';
import type { RequestHandler } from './$types';

/**
 * `GET /api/v1/runs/:id/log` — the run's *complete* log, streamed.
 *
 * Singular, deliberately: the plural `/logs` is the daemon's runner-token
 * append. This one is ordinary user auth (session or user API key) and is
 * what the CLI's `--full` and the viewer's truncation link hit. `?raw=1`
 * serves the unrendered harness stream instead, when one was uploaded.
 */
export const GET: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const raw = event.url.searchParams.get('raw') === '1';
	const result = await getFullRunLog(db, env, actor, event.params.id, raw);
	if (result.kind === 'expired') {
		error(410, 'This run log has passed its retention window; only the tail remains');
	}
	if (result.kind === 'missing_raw') {
		error(404, 'This run has no raw harness stream');
	}
	if (result.kind === 'not_ready') {
		// A sweep outage left more spilled parts than one read may fetch
		// without blowing the Worker subrequest budget. Self-heals.
		error(503, 'The full log is still being compacted; retry shortly');
	}
	const filename = `run-${event.params.id}.log`;
	const headers = new Headers({
		'content-type': raw ? 'application/x-ndjson' : 'text/plain; charset=utf-8',
		'content-disposition': `inline; filename="${filename}"`,
		'cache-control': 'no-store'
	});
	if (result.kind === 'tail') {
		const bytes = new TextEncoder().encode(result.text);
		headers.set('content-length', String(bytes.length));
		return new Response(bytes, { headers });
	}
	headers.set('content-length', String(result.size));
	return new Response(result.body, { headers });
});
