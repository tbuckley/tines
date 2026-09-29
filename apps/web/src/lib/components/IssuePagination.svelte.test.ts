import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
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

describe('IssuePagination', () => {
	it('renders nothing on a single unbounded page', async () => {
		const screen = await render(IssuePagination, { pagination: pagination(), itemCount: 3 });
		expect(screen.container.querySelector('nav')).toBeNull();
	});

	it('renders the nav once the page is bounded, even with no neighbours', async () => {
		const screen = await render(IssuePagination, {
			pagination: pagination({ bounded: true }),
			itemCount: 3
		});
		await expect
			.element(screen.getByRole('navigation', { name: 'Issue pagination' }))
			.toBeVisible();
	});

	it('makes a href-less direction a disabled button rather than a dead link', async () => {
		const screen = await render(IssuePagination, {
			pagination: pagination({ nextHref: '/issues?after=abc' }),
			itemCount: 25
		});

		const previous = screen.getByText('Previous');
		expect(previous.element().tagName).toBe('BUTTON');
		await expect.element(previous).toBeDisabled();

		const next = screen.getByText('Next');
		expect(next.element().tagName).toBe('A');
		await expect.element(next).toHaveAttribute('href', '/issues?after=abc');
	});

	it('pluralises the count and announces it politely', async () => {
		const screen = await render(IssuePagination, {
			pagination: pagination({ bounded: true }),
			itemCount: 1
		});
		await expect
			.element(screen.getByText('1 issue on this page'))
			.toHaveAttribute('aria-live', 'polite');

		await screen.rerender({ pagination: pagination({ bounded: true }), itemCount: 2 });
		await expect.element(screen.getByText('2 issues on this page')).toBeVisible();
	});

	it('drops the live region when the caller opts out', async () => {
		const screen = await render(IssuePagination, {
			pagination: pagination({ bounded: true }),
			itemCount: 4,
			announceCount: false
		});
		expect(screen.getByText('4 issues on this page').element().hasAttribute('aria-live')).toBe(
			false
		);
	});

	it('offers a way back to the first page only when the page came up empty', async () => {
		const screen = await render(IssuePagination, {
			pagination: pagination({ bounded: true, empty: true }),
			itemCount: 0
		});
		await expect
			.element(screen.getByRole('link', { name: 'First page' }))
			.toHaveAttribute('href', '/issues');

		await screen.rerender({ pagination: pagination({ bounded: true }), itemCount: 4 });
		await expect.element(screen.getByRole('link', { name: 'First page' })).not.toBeInTheDocument();
	});

	it('takes the landmark label from the caller, so two navs on a page stay distinct', async () => {
		const screen = await render(IssuePagination, {
			pagination: pagination({ bounded: true }),
			itemCount: 3,
			label: 'Backlog pagination'
		});
		await expect
			.element(screen.getByRole('navigation', { name: 'Backlog pagination' }))
			.toBeVisible();
	});
});
