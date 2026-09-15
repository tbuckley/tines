const PUBLICATION_PATH_PREFIXES = ['/p', '/api/v1/publications/public'] as const;

export function isPublicPublicationPath(pathname: string): boolean {
	return PUBLICATION_PATH_PREFIXES.some(
		(prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
	);
}

/** Strip validators before framework handling so public responses can never become a 304. */
export function preparePublicationRequest(request: Request): Request {
	if (!isPublicPublicationPath(new URL(request.url).pathname)) return request;
	if (!request.headers.has('if-none-match') && !request.headers.has('if-modified-since'))
		return request;
	const headers = new Headers(request.headers);
	headers.delete('if-none-match');
	headers.delete('if-modified-since');
	return new Request(request, { headers });
}

function nonceSource(response: Response): string | null {
	const policy = response.headers.get('content-security-policy') ?? '';
	return policy.match(/(?:^|[;\s])('nonce-[^'\s;]+')(?=[\s;]|$)/)?.[1] ?? null;
}

function publicationCsp(response: Response): string {
	const isHtml =
		response.headers.get('content-type')?.toLowerCase().startsWith('text/html') ?? false;
	const nonce = isHtml ? nonceSource(response) : null;
	const scriptSources = isHtml ? ["'self'", ...(nonce ? [nonce] : [])].join(' ') : "'none'";
	return [
		"default-src 'none'",
		`script-src ${scriptSources}`,
		"script-src-attr 'none'",
		`style-src ${isHtml ? "'self' 'unsafe-inline'" : "'none'"}`,
		`font-src ${isHtml ? "'self'" : "'none'"}`,
		`connect-src ${isHtml ? "'self'" : "'none'"}`,
		"img-src 'none'",
		"media-src 'none'",
		"frame-src 'none'",
		"object-src 'none'",
		"base-uri 'none'",
		"frame-ancestors 'none'",
		"worker-src 'none'",
		"manifest-src 'none'",
		`form-action ${isHtml ? "'self'" : "'none'"}`
	].join('; ');
}

/** Apply the public snapshot boundary after all framework response handling. */
export function finalizePublicationResponse(request: Request, response: Response): Response {
	if (!isPublicPublicationPath(new URL(request.url).pathname)) return response;

	const headers = new Headers(response.headers);
	headers.set('cache-control', 'no-store, max-age=0');
	headers.set('content-security-policy', publicationCsp(response));
	headers.set('referrer-policy', 'no-referrer');
	headers.set('x-content-type-options', 'nosniff');
	headers.delete('etag');
	headers.delete('last-modified');

	// A 304 at this outer boundary means a bypass generated it despite stripped
	// validators. Fail closed as a neutral response instead of permitting cache reuse.
	const status = response.status === 304 ? 500 : response.status;
	const hasBody = request.method !== 'HEAD' && ![101, 204, 205].includes(status);
	return new Response(hasBody ? response.body : null, {
		status,
		statusText: status === response.status ? response.statusText : 'Internal Server Error',
		headers
	});
}

/** Worker-level wrapper for framework responses and exceptions. */
export async function handlePublicationFetch(
	request: Request,
	fetcher: (request: Request) => Promise<Response>
): Promise<Response> {
	try {
		return finalizePublicationResponse(request, await fetcher(preparePublicationRequest(request)));
	} catch (error) {
		if (!isPublicPublicationPath(new URL(request.url).pathname)) throw error;
		console.error('Public publication request failed', { code: 'publication_request_failed' });
		return finalizePublicationResponse(
			request,
			new Response('Publication unavailable', {
				status: 500,
				headers: { 'content-type': 'text/plain; charset=utf-8' }
			})
		);
	}
}
