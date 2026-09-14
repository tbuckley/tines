export const ISSUE_PAGE_SIZE = 100;

export function clearIssuePagination(params: URLSearchParams): void {
	params.delete('after');
	params.delete('before');
	params.delete('page_scope');
}

export function issuePageHref(
	url: URL,
	direction?: 'after' | 'before',
	cursor?: string,
	scope?: string
): string {
	const params = new URLSearchParams(url.searchParams);
	clearIssuePagination(params);
	params.delete('project');
	if (direction && cursor) params.set(direction, cursor);
	if (direction && scope) params.set('page_scope', scope);
	const query = params.toString();
	return `${url.pathname}${query ? `?${query}` : ''}`;
}
