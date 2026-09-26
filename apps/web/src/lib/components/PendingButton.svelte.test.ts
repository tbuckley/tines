import { describe, expect, it } from 'vitest';
import { createRawSnippet } from 'svelte';
import { render } from 'vitest-browser-svelte';
import PendingButton from './PendingButton.svelte';

const children = createRawSnippet(() => ({ render: () => '<span>Move to review</span>' }));

describe('PendingButton', () => {
	it('is an ordinary button until something is pending', async () => {
		const screen = await render(PendingButton, { children });
		const button = screen.getByRole('button');
		await expect.element(button).toBeEnabled();
		expect(button.element().hasAttribute('aria-busy')).toBe(false);
		await expect.element(screen.getByText('Move to review')).toBeVisible();
	});

	it('disables itself and says so while pending', async () => {
		const screen = await render(PendingButton, { children, pending: true });
		const button = screen.getByRole('button');
		await expect.element(button).toBeDisabled();
		await expect.element(button).toHaveAttribute('aria-busy', 'true');
	});

	it('hides the label from both eye and reader while pending', async () => {
		const screen = await render(PendingButton, { children });
		const label = screen.container.querySelector('button > span')!;
		expect(getComputedStyle(label).visibility).toBe('visible');

		await screen.rerender({ children, pending: true });
		expect(getComputedStyle(label).visibility).toBe('hidden');
		expect(label.getAttribute('aria-hidden')).toBe('true');
	});

	it('does not reflow the row when the spinner takes over (Tines/153)', async () => {
		const screen = await render(PendingButton, { children });
		const button = screen.getByRole('button').element();
		const idle = button.getBoundingClientRect();

		await screen.rerender({ children, pending: true });

		// The label keeps its grid cell, so the box is still sized by the label
		// and the swap cannot shift anything beside it.
		const pending = button.getBoundingClientRect();
		expect(pending.width).toBeCloseTo(idle.width, 1);
		expect(pending.height).toBeCloseTo(idle.height, 1);
	});

	it('announces the pending state with a default the caller can override', async () => {
		const screen = await render(PendingButton, { children, pending: true });
		expect(screen.getByText('Working…').element().classList.contains('sr-only')).toBe(true);

		await screen.rerender({ children, pending: true, pendingLabel: 'Moving…' });
		expect(screen.getByText('Moving…').element().classList.contains('sr-only')).toBe(true);
	});

	it('still honours a plain disabled, pending or not', async () => {
		const screen = await render(PendingButton, { children, disabled: true });
		const button = screen.getByRole('button');
		await expect.element(button).toBeDisabled();
		expect(button.element().hasAttribute('aria-busy')).toBe(false);
	});
});
