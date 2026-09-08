import type { IssueListItem } from '@tines/shared';
import { ApiFail, decodeCursor, encodeCursor, type Page } from '$lib/server/api/core';
import { ISSUE_PAGE_SIZE, issuePageHref } from '$lib/issue-pagination';

export type IssuePageDirection = 'after' | 'before';
export type WebIssuePage = Page & { direction: IssuePageDirection };
export interface IssuePagination {
	previousHref: string | null;
	nextHref: string | null;
	firstHref: string;
	bounded: boolean;
	empty: boolean;
}

export function readIssuePage(url: URL): WebIssuePage {
	const after = url.searchParams.getAll('after');
	const before = url.searchParams.getAll('before');
	if (
		after.length > 1 ||
		before.length > 1 ||
		(after.length && before.length) ||
		(after.length === 1 && !after[0]) ||
		(before.length === 1 && !before[0])
	) {
		throw new ApiFail(400, 'invalid_cursor', 'Malformed pagination cursor');
	}
	const direction: IssuePageDirection = before.length ? 'before' : 'after';
	const raw = before[0] ?? after[0];
	return { cursor: raw ? decodeCursor(raw) : null, limit: ISSUE_PAGE_SIZE, direction };
}

export function issuePagination(
	url: URL,
	page: WebIssuePage,
	items: IssueListItem[],
	hasMore: boolean,
	scope?: string
): IssuePagination {
	const bounded = page.cursor !== null;
	const firstHref = issuePageHref(url);
	const cursorFor = (item: IssueListItem) => encodeCursor(item.created_at, item.id);
	let previousHref: string | null = null;
	let nextHref: string | null = null;
	if (items.length) {
		const first = cursorFor(items[0]);
		const last = cursorFor(items[items.length - 1]);
		previousHref =
			bounded && (page.direction === 'after' || hasMore)
				? issuePageHref(url, 'before', first, scope)
				: null;
		nextHref = (!bounded || page.direction === 'after' ? hasMore : true)
			? issuePageHref(url, 'after', last, scope)
			: null;
	} else if (page.cursor) {
		const raw = encodeCursor(page.cursor.createdAt, page.cursor.id);
		if (page.direction === 'after') previousHref = issuePageHref(url, 'before', raw, scope);
		else nextHref = issuePageHref(url, 'after', raw, scope);
	}
	return { previousHref, nextHref, firstHref, bounded, empty: items.length === 0 };
}
