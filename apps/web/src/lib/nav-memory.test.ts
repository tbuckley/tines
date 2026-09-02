import { describe, expect, it } from 'vitest';
import { DEFAULT_NAV_MEMORY, isListHref, parseNavMemory } from './nav-memory.svelte';

describe('isListHref', () => {
	it.each(['/issues', '/issues?q=a&project=Tines', '/projects/prj_1', '/projects/prj_1?ready=1'])(
		'accepts %o',
		(href) => {
			expect(isListHref(href)).toBe(true);
		}
	);

	it.each([
		'',
		'/settings',
		'/issuesfoo',
		'issues',
		'https://evil.example/issues',
		'//evil.example',
		'javascript:alert(1)',
		null,
		undefined,
		42,
		{ href: '/issues' }
	])('rejects %o', (href) => {
		expect(isListHref(href)).toBe(false);
	});
});

describe('parseNavMemory', () => {
	it('round-trips a valid value', () => {
		const memory = {
			issuesQuery: '?project=Tines&q=nav',
			lastList: { href: '/projects/prj_1?done=1', label: 'Tines' }
		};
		expect(parseNavMemory(JSON.stringify(memory))).toEqual(memory);
	});

	it.each([null, undefined, '', 'not json', '[1,2]', '"a string"', 'null', '7'])(
		'falls back wholesale for %o',
		(raw) => {
			expect(parseNavMemory(raw)).toEqual(DEFAULT_NAV_MEMORY);
		}
	);

	it.each(['x=1', 42, null, undefined])('drops an issuesQuery of %o', (issuesQuery) => {
		expect(parseNavMemory(JSON.stringify({ issuesQuery })).issuesQuery).toBe('');
	});

	it.each([
		{ href: 'https://evil.example', label: 'Evil' },
		{ href: '//evil.example', label: 'Evil' },
		{ href: '/settings', label: 'Settings' },
		{ href: '/issues', label: '' },
		{ href: '/issues' },
		{ label: 'Issues' },
		'/issues',
		null
	])('drops a lastList of %o', (lastList) => {
		expect(parseNavMemory(JSON.stringify({ lastList })).lastList).toBeNull();
	});

	it('keeps a good field when the other is corrupt', () => {
		const badList = parseNavMemory(JSON.stringify({ issuesQuery: '?q=a', lastList: 'nope' }));
		expect(badList).toEqual({ issuesQuery: '?q=a', lastList: null });

		const list = { href: '/issues?q=a', label: 'Issues' };
		const badQuery = parseNavMemory(JSON.stringify({ issuesQuery: 12, lastList: list }));
		expect(badQuery).toEqual({ issuesQuery: '', lastList: list });
	});
});
