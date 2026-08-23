import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { ApiFail, encodeCursor, pageResult, readPage } from './core';

/** readPage only touches `url.searchParams`. */
function eventWithUrl(query: string): RequestEvent {
	return { url: new URL(`http://test/api/v1/items${query}`) } as RequestEvent;
}

describe('cursor pagination', () => {
	it('round-trips (created_at, id) through the cursor', () => {
		const cursor = encodeCursor(1723000000123, 'iss_abcDEF123');
		const page = readPage(eventWithUrl(`?cursor=${cursor}`));
		expect(page.cursor).toEqual({ createdAt: 1723000000123, id: 'iss_abcDEF123' });
	});

	it('produces URL-safe cursors (no +, /, =)', () => {
		// ">>>???" forces + and / in plain base64.
		const cursor = encodeCursor(999, '>>>???');
		expect(cursor).not.toMatch(/[+/=]/);
		expect(readPage(eventWithUrl(`?cursor=${cursor}`)).cursor).toEqual({
			createdAt: 999,
			id: '>>>???'
		});
	});

	it('rejects malformed cursors with a 400', () => {
		expect(() => readPage(eventWithUrl('?cursor=%%%not-base64'))).toThrowError(ApiFail);
		try {
			readPage(eventWithUrl('?cursor=aGk')); // "hi": no separator
		} catch (e) {
			expect(e).toBeInstanceOf(ApiFail);
			expect((e as ApiFail).status).toBe(400);
			expect((e as ApiFail).code).toBe('invalid_cursor');
			return;
		}
		throw new Error('expected a malformed cursor to throw');
	});

	it('applies default and max limits', () => {
		expect(readPage(eventWithUrl('')).limit).toBe(50);
		expect(readPage(eventWithUrl('?limit=10')).limit).toBe(10);
		expect(readPage(eventWithUrl('?limit=100000')).limit).toBe(100);
		expect(readPage(eventWithUrl('?limit=0')).limit).toBe(50);
		expect(readPage(eventWithUrl('?limit=banana')).limit).toBe(50);
	});
});

describe('pageResult', () => {
	const row = (id: string, createdAt: number) => ({ id, created_at: createdAt });

	it('trims the +1 probe row and emits a next cursor', () => {
		const rows = [row('c', 3), row('b', 2), row('a', 1)];
		const page = pageResult(rows, 2);
		expect(page.items.map((r) => r.id)).toEqual(['c', 'b']);
		expect(page.next_cursor).toBe(encodeCursor(2, 'b'));
	});

	it('returns a null cursor on the last page', () => {
		const page = pageResult([row('b', 2), row('a', 1)], 2);
		expect(page.items).toHaveLength(2);
		expect(page.next_cursor).toBeNull();
	});

	it('handles an empty page', () => {
		expect(pageResult([], 10)).toEqual({ items: [], next_cursor: null });
	});
});
