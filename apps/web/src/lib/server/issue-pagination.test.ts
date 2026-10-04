import type { IssueListItem } from '@tines/shared';
import { describe, expect, it } from 'vitest';
import { clearIssuePagination, issuePageHref } from '$lib/issue-pagination';
import { ApiFail, decodeCursor, encodeCursor } from './api/core';
import { issuePagination, keysetPagination, readIssuePage } from './issue-pagination';

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
		const source = url(
			'?label=a&label=b&workflow=wf_eng&state=s_review&after=old&before=older&page_scope=old&project=demo&q=hi'
		);
		expect(issuePageHref(source, 'after', 'new', 'all')).toBe(
			'/issues?label=a&label=b&workflow=wf_eng&state=s_review&q=hi&after=new&page_scope=all'
		);
		clearIssuePagination(source.searchParams);
		expect(source.searchParams.getAll('label')).toEqual(['a', 'b']);
		expect(source.searchParams.get('workflow')).toBe('wf_eng');
		expect(source.searchParams.get('state')).toBe('s_review');
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

	it('mints cursors from the timestamp the caller sorts on', () => {
		const source = new URL('https://example.test/context?kind=prompt');
		const rows = [
			{ id: 'ctx_b', created_at: 1, updated_at: 9 },
			{ id: 'ctx_a', created_at: 2, updated_at: 7 }
		];
		const pagination = keysetPagination(
			source,
			readIssuePage(source),
			rows,
			true,
			(row) => row.updated_at,
			'all'
		);
		const next = new URL(pagination.nextHref!, source);
		expect(next.pathname).toBe('/context');
		expect(next.searchParams.get('kind')).toBe('prompt');
		expect(next.searchParams.get('page_scope')).toBe('all');
		expect(decodeCursor(next.searchParams.get('after')!)).toEqual({ createdAt: 7, id: 'ctx_a' });
	});
});
