import type { IssueListItem } from '@tines/shared';
import { describe, expect, it } from 'vitest';
import { clearIssuePagination, issuePageHref } from '$lib/issue-pagination';
import { ApiFail, encodeCursor } from './api/core';
import { issuePagination, readIssuePage } from './issue-pagination';

const url = (query = '') => new URL(`https://example.test/issues${query}`);
const item = (id: string, created_at: number) => ({ id, created_at }) as IssueListItem;

describe('web issue page parsing', () => {
	it('accepts first, after, and before pages', () => {
		const cursor = encodeCursor(42, 'iss_1');
		expect(readIssuePage(url()).cursor).toBeNull();
		expect(readIssuePage(url(`?after=${cursor}`))).toMatchObject({
			cursor: { createdAt: 42, id: 'iss_1' },
			direction: 'after',
			limit: 100
		});
		expect(readIssuePage(url(`?before=${cursor}`)).direction).toBe('before');
	});

	it.each(['?after=', '?before=', '?after=x&before=x', '?after=x&after=y', '?before=x&before=y'])(
		'rejects ambiguous or empty boundaries: %s',
		(query) => expect(() => readIssuePage(url(query))).toThrowError(ApiFail)
	);
});

describe('issue pagination URLs', () => {
	it('preserves repeated filters while removing all paging and one-shot project params', () => {
		const source = url('?label=a&label=b&after=old&before=older&page_scope=old&project=demo&q=hi');
		expect(issuePageHref(source, 'after', 'new', 'all')).toBe(
			'/issues?label=a&label=b&q=hi&after=new&page_scope=all'
		);
		clearIssuePagination(source.searchParams);
		expect(source.searchParams.getAll('label')).toEqual(['a', 'b']);
		expect(source.searchParams.has('after')).toBe(false);
	});

	it('builds first, middle, last, and stale-page controls', () => {
		const first = readIssuePage(url());
		expect(issuePagination(url(), first, [item('a', 3), item('b', 2)], true, 'all')).toMatchObject({
			previousHref: null,
			nextHref: expect.stringContaining('after='),
			bounded: false
		});
		const after = readIssuePage(url(`?after=${encodeCursor(4, 'z')}`));
		expect(issuePagination(url(), after, [item('a', 3)], false, 'all')).toMatchObject({
			previousHref: expect.stringContaining('before='),
			nextHref: null
		});
		const before = readIssuePage(url(`?before=${encodeCursor(1, 'x')}`));
		expect(issuePagination(url(), before, [item('a', 3)], false, 'all')).toMatchObject({
			previousHref: null,
			nextHref: expect.stringContaining('after=')
		});
		expect(issuePagination(url(), after, [], false, 'all')).toMatchObject({
			empty: true,
			previousHref: expect.stringContaining('before='),
			firstHref: '/issues'
		});
	});
});
