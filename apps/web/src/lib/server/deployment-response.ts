import type { VersionResponse } from '@tines/shared';

export function isApiPath(pathname: string): boolean {
	return pathname === '/api' || pathname.startsWith('/api/');
}

export function finalizeDeploymentResponse(
	request: Request,
	response: Response,
	identity: Readonly<VersionResponse>
): Response {
	if (!isApiPath(new URL(request.url).pathname)) return response;
	const headers = new Headers(response.headers);
	headers.set('X-Tines-Version', identity.version);
	headers.set('X-Tines-Commit', identity.commit);
	const bodyless = request.method === 'HEAD' || [101, 204, 205, 304].includes(response.status);
	return new Response(bodyless ? null : response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}

export async function handleDeploymentFetch(
	request: Request,
	fetcher: (request: Request) => Promise<Response>,
	identity: Readonly<VersionResponse>
): Promise<Response> {
	try {
		return finalizeDeploymentResponse(request, await fetcher(request), identity);
	} catch (error) {
		if (!isApiPath(new URL(request.url).pathname)) throw error;
		console.error('API request failed', { code: 'api_request_failed' });
		return finalizeDeploymentResponse(
			request,
			new Response('Internal Server Error', {
				status: 500,
				headers: {
					'content-type': 'text/plain; charset=utf-8',
					'cache-control': 'no-store'
				}
			}),
			identity
		);
	}
}
