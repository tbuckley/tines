import { describe, expect, it } from 'vitest';
import { listAll, listPages, MAX_PAGE_SIZE } from './paginate.js';
import type { PageFetcher } from './paginate.js';
import type { ListResponse, PageParams } from './types.js';

interface Row {
	id: string;
}

const rows = (n: number, prefix = 'r'): Row[] =>
	Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }));

/**
 * A server: pages `items` by offset, encoding the offset in the cursor. The
 * `calls` array records every PageParams it was handed, so the tests can pin
 * what the walk actually asked for rather than only what it returned.
 */
function paged(items: Row[], pageSize = MAX_PAGE_SIZE) {
	const calls: PageParams[] = [];
	const fetchPage: PageFetcher<Row> = async (page) => {
		calls.push(page);
		const offset = page.cursor ? Number(page.cursor) : 0;
		const limit = Math.min(page.limit ?? pageSize, pageSize);
		const slice = items.slice(offset, offset + limit);
		const end = offset + slice.length;
		return { items: slice, next_cursor: end < items.length ? String(end) : null };
	};
	return { fetchPage, calls };
}

/** A one-shot server returning exactly the given responses, in order. */
function scripted(...responses: ListResponse<Row>[]): PageFetcher<Row> {
	let i = 0;
	return async () => responses[Math.min(i++, responses.length - 1)];
}

describe('listAll', () => {
	it('returns a single page as-is', async () => {
		const { fetchPage } = paged(rows(7));
		expect(await listAll(fetchPage)).toEqual(rows(7));
	});

	it('concatenates every page in server order', async () => {
		const all = rows(250);
		const { fetchPage, calls } = paged(all);
		expect(await listAll(fetchPage)).toEqual(all);
		expect(calls.map((c) => c.cursor)).toEqual([undefined, '100', '200']);
	});

	it('returns an empty array for an empty list', async () => {
		const { fetchPage, calls } = paged([]);
		expect(await listAll(fetchPage)).toEqual([]);
		expect(calls).toHaveLength(1);
	});

	it('asks for the largest page by default, and forwards pageSize as limit', async () => {
		const { fetchPage, calls } = paged(rows(30));
		await listAll(fetchPage);
		expect(calls[0].limit).toBe(MAX_PAGE_SIZE);

		const small = paged(rows(30));
		await listAll(small.fetchPage, { pageSize: 10 });
		expect(small.calls.map((c) => c.limit)).toEqual([10, 10, 10]);
	});

	it('collapses items repeated across pages', async () => {
		// What `context list` does when an item is edited mid-walk: it slides
		// into a later page and would otherwise be returned twice.
		const fetchPage = scripted(
			{ items: rows(3), next_cursor: 'p2' },
			{ items: [...rows(1), { id: 'r9' }], next_cursor: null }
		);
		expect(await listAll(fetchPage)).toEqual([...rows(3), { id: 'r9' }]);
	});

	it('accepts a list exactly at the ceiling', async () => {
		const { fetchPage } = paged(rows(300));
		expect(await listAll(fetchPage, { maxItems: 300 })).toHaveLength(300);
	});

	it('throws rather than truncating past the ceiling', async () => {
		const { fetchPage } = paged(rows(300));
		await expect(listAll(fetchPage, { maxItems: 250 })).rejects.toThrow(
			/more than 250 items — narrow it with filters/
		);
	});

	it('throws when the cursor stops advancing', async () => {
		const fetchPage = scripted(
			{ items: rows(2), next_cursor: 'stuck' },
			{ items: rows(2, 's'), next_cursor: 'stuck' }
		);
		await expect(listAll(fetchPage)).rejects.toThrow(/cursor did not advance past "stuck"/);
	});

	it('propagates a mid-walk fetch error instead of returning a partial list', async () => {
		let call = 0;
		const fetchPage: PageFetcher<Row> = async () => {
			if (call++ === 1) throw new Error('boom');
			return { items: rows(2), next_cursor: 'p2' };
		};
		await expect(listAll(fetchPage)).rejects.toThrow('boom');
	});
});

describe('listPages', () => {
	it('yields one array per request, for streaming callers', async () => {
		const { fetchPage } = paged(rows(250));
		const sizes: number[] = [];
		for await (const page of listPages(fetchPage)) sizes.push(page.length);
		expect(sizes).toEqual([100, 100, 50]);
	});
});
