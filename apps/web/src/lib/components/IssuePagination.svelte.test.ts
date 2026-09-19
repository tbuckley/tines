import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import type { IssuePagination as Pagination } from '$lib/server/issue-pagination';
import IssuePagination from './IssuePagination.svelte';

function pagination(overrides: Partial<Pagination> = {}): Pagination {
	return {
		previousHref: null,
		nextHref: null,
		firstHref: '/issues',
		bounded: false,
		empty: false,
		...overrides
	};
}

/** The Previous/Next control, found by its label so the element kind is free. */
function control(name: 'Previous' | 'Next'): HTMLElement {
	return screen.getByText(name);
}

describe('IssuePagination', () => {
	it('renders nothing on a single unbounded page', () => {
		const { container } = render(IssuePagination, {
			props: { pagination: pagination(), itemCount: 3 }
		});
		expect(container.querySelector('nav')).toBeNull();
	});

	it('renders the nav once the page is bounded, even with no neighbours', () => {
		render(IssuePagination, {
			props: { pagination: pagination({ bounded: true }), itemCount: 3 }
		});
		expect(screen.getByRole('navigation', { name: 'Issue pagination' })).toBeTruthy();
	});

	it('makes a href-less direction a disabled button rather than a dead link', () => {
		render(IssuePagination, {
			props: { pagination: pagination({ nextHref: '/issues?after=abc' }), itemCount: 25 }
		});

		const previous = control('Previous');
		expect(previous.tagName).toBe('BUTTON');
		expect((previous as HTMLButtonElement).disabled).toBe(true);

		const next = control('Next');
		expect(next.tagName).toBe('A');
		expect(next.getAttribute('href')).toBe('/issues?after=abc');
	});

	it('pluralises the count and announces it politely', () => {
		const { rerender } = render(IssuePagination, {
			props: { pagination: pagination({ bounded: true }), itemCount: 1 }
		});
		const count = screen.getByText('1 issue on this page');
		expect(count.getAttribute('aria-live')).toBe('polite');

		rerender({ pagination: pagination({ bounded: true }), itemCount: 2 });
		expect(screen.getByText('2 issues on this page')).toBeTruthy();
	});

	it('drops the live region when the caller opts out', () => {
		render(IssuePagination, {
			props: { pagination: pagination({ bounded: true }), itemCount: 4, announceCount: false }
		});
		expect(screen.getByText('4 issues on this page').hasAttribute('aria-live')).toBe(false);
	});

	it('offers a way back to the first page only when the page came up empty', () => {
		const { rerender } = render(IssuePagination, {
			props: { pagination: pagination({ bounded: true, empty: true }), itemCount: 0 }
		});
		expect(screen.getByRole('link', { name: 'First page' }).getAttribute('href')).toBe('/issues');

		rerender({ pagination: pagination({ bounded: true }), itemCount: 4 });
		expect(screen.queryByRole('link', { name: 'First page' })).toBeNull();
	});

	it('takes the landmark label from the caller, so two navs on a page stay distinct', () => {
		render(IssuePagination, {
			props: {
				pagination: pagination({ bounded: true }),
				itemCount: 3,
				label: 'Backlog pagination'
			}
		});
		expect(screen.getByRole('navigation', { name: 'Backlog pagination' })).toBeTruthy();
	});
});
