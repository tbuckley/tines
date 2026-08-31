/**
 * Cursor following for the paginated list endpoints. Every `/api/v1` list
 * returns one page plus a `next_cursor`; callers that want the whole set — the
 * CLI's `--all-pages`, and its own name lookups — walk it here rather than
 * each re-implementing the loop (and each getting the truncation wrong).
 *
 * The walk is deliberately loud: it never returns a short list. Hitting the
 * ceiling or a server that stops advancing the cursor throws, so a truncated
 * result can't be mistaken for a complete one.
 */

import type { ListResponse, PageParams } from './types.js';

/** Server-side page cap; asking for it minimises round trips. */
export const MAX_PAGE_SIZE = 100;

/**
 * Hard ceiling on a single walk. Well above any real list (the largest today is
 * the activity log, low thousands) and low enough that a runaway query fails
 * fast instead of pulling the database through the CLI.
 */
export const MAX_ALL_PAGES_ITEMS = 10_000;

export interface PaginateOptions {
	/** Items per request; clamped by the server to MAX_PAGE_SIZE. */
	pageSize?: number;
	/** Ceiling on the total returned; exceeding it throws. */
	maxItems?: number;
}

/** Fetches one page — every `ApiClient.list*` method has this shape once its filters are bound. */
export type PageFetcher<T> = (page: PageParams) => Promise<ListResponse<T>>;

/**
 * Yields each page's items, following `next_cursor` until it is null.
 *
 * Items already seen on an earlier page are dropped, so a page may come back
 * empty (or short) without meaning the walk is over. That de-duplication is
 * load-bearing: some endpoints page on a mutable column (`context` orders by
 * `updated_at`), so an item edited mid-walk can shift into a later page. A walk
 * is therefore not a snapshot — it can repeat an item, and can miss one that
 * moves backwards past the cursor.
 *
 * @throws if more than `maxItems` distinct items are seen, or if the server
 * returns a cursor it has already handed out (which would loop forever).
 */
export async function* listPages<T extends { id: string }>(
	fetchPage: PageFetcher<T>,
	opts: PaginateOptions = {}
): AsyncGenerator<T[]> {
	const pageSize = opts.pageSize ?? MAX_PAGE_SIZE;
	const maxItems = opts.maxItems ?? MAX_ALL_PAGES_ITEMS;
	const seen = new Set<string>();
	const seenCursors = new Set<string>();
	let cursor: string | undefined;

	for (;;) {
		const res = await fetchPage({ limit: pageSize, cursor });
		const fresh = res.items.filter((item) => !seen.has(item.id));
		for (const item of fresh) seen.add(item.id);
		if (seen.size > maxItems) {
			throw new Error(
				`list has more than ${maxItems} items — narrow it with filters, or page manually with --cursor`
			);
		}
		yield fresh;
		if (res.next_cursor === null) return;
		// Any cursor we have already followed — the same one twice running, or a
		// server alternating between two — would loop forever, and because
		// repeats are de-duplicated the ceiling above would never fire either.
		if (seenCursors.has(res.next_cursor)) {
			throw new Error(`pagination cursor did not advance past "${cursor}" (server bug?)`);
		}
		seenCursors.add(res.next_cursor);
		cursor = res.next_cursor;
	}
}

/**
 * Collects every page into one array, in server order. See {@link listPages}
 * for the ceiling, the cursor guard, and why a walk is not a snapshot.
 */
export async function listAll<T extends { id: string }>(
	fetchPage: PageFetcher<T>,
	opts: PaginateOptions = {}
): Promise<T[]> {
	const items: T[] = [];
	for await (const page of listPages(fetchPage, opts)) items.push(...page);
	return items;
}
