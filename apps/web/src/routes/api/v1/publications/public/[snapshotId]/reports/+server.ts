import { json } from '@sveltejs/kit';
import type { PublicationReportRequest } from '@tines/shared';
import { api, ApiFail } from '$lib/server/api/core';
import { getDb } from '$lib/server/db';
import {
	PUBLICATION_RESPONSE_HEADERS,
	withPublicationHeaders
} from '$lib/server/publications/public';
import { acceptPublicationReport } from '$lib/server/publications/reports';
import { sweepModerationRetention } from '$lib/server/publications/moderation-retention';
import type { RequestHandler } from './$types';

const post = api(async (event) => {
	if (!event.platform) throw new ApiFail(500, 'no_platform', 'Platform bindings unavailable');
	if (!event.params.snapshotId)
		throw new ApiFail(404, 'publication_unavailable', 'This publication is not available.');
	if (event.request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json')
		throw new ApiFail(415, 'unsupported_media_type', 'Use application/json');
	if (event.request.headers.get('origin') !== event.url.origin)
		throw new ApiFail(403, 'invalid_origin', 'Same-origin browser request required');
	const reader = event.request.body?.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (!reader) throw new ApiFail(400, 'invalid_json', 'Request body must be valid JSON');
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > 16_384) {
			await reader.cancel();
			throw new ApiFail(413, 'request_too_large', 'Report request is too large');
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	let body: PublicationReportRequest;
	try {
		body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch {
		throw new ApiFail(400, 'invalid_json', 'Request body must be valid JSON');
	}
	let network: string;
	try {
		network = event.getClientAddress();
	} catch {
		throw new ApiFail(503, 'reporting_unavailable', 'Reporting is temporarily unavailable');
	}
	const result = await acceptPublicationReport(
		getDb(event.platform.env),
		event.platform.env,
		event.params.snapshotId,
		body,
		{ network, ...(event.locals.user ? { account: event.locals.user.id } : {}) }
	);
	event.platform.ctx?.waitUntil?.(sweepModerationRetention(event.platform.env, Date.now(), 1));
	return json(result.body, { status: result.status, headers: PUBLICATION_RESPONSE_HEADERS });
});

export const POST: RequestHandler = (event) =>
	withPublicationHeaders(
		post(event).then((response) => {
			if (response.status === 429) {
				return response
					.clone()
					.json()
					.then((body) => {
						const seconds = body?.error?.details?.retry_after_seconds;
						if (typeof seconds === 'number') response.headers.set('retry-after', String(seconds));
						return response;
					});
			}
			return response;
		})
	);
