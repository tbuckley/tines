const PUBLICATION_PATH_PREFIXES = ['/p', '/api/v1/publications/public'] as const;

export function isPublicPublicationPath(pathname: string): boolean {
	return PUBLICATION_PATH_PREFIXES.some(
		(prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
	);
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

	const hasBody = request.method !== 'HEAD' && ![101, 204, 205, 304].includes(response.status);
	return new Response(hasBody ? response.body : null, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}
