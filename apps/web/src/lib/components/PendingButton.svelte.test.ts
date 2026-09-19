import { describe, expect, it } from 'vitest';
import { createRawSnippet } from 'svelte';
import { render, screen } from '@testing-library/svelte';
import PendingButton from './PendingButton.svelte';

const children = createRawSnippet(() => ({ render: () => '<span>Move to review</span>' }));

function button(): HTMLButtonElement {
	return screen.getByRole('button') as HTMLButtonElement;
}

describe('PendingButton', () => {
	it('is an ordinary button until something is pending', () => {
		render(PendingButton, { props: { children } });
		expect(button().disabled).toBe(false);
		expect(button().hasAttribute('aria-busy')).toBe(false);
		expect(screen.getByText('Move to review')).toBeTruthy();
	});

	it('disables itself and says so while pending', () => {
		render(PendingButton, { props: { children, pending: true } });
		expect(button().disabled).toBe(true);
		expect(button().getAttribute('aria-busy')).toBe('true');
	});

	it('keeps the label in the layout while hiding it from both eye and reader', () => {
		const { rerender } = render(PendingButton, { props: { children } });
		const label = screen.getByText('Move to review').parentElement!;
		expect(label.classList.contains('invisible')).toBe(false);

		rerender({ children, pending: true });
		// Still mounted — the grid cell it occupies is what stops the row
		// reflowing when the spinner takes over (Tines/153).
		expect(label.isConnected).toBe(true);
		expect(label.classList.contains('invisible')).toBe(true);
		expect(label.getAttribute('aria-hidden')).toBe('true');
	});

	it('announces the pending state with a default caller can override', () => {
		const { rerender } = render(PendingButton, { props: { children, pending: true } });
		expect(screen.getByText('Working…').classList.contains('sr-only')).toBe(true);

		rerender({ children, pending: true, pendingLabel: 'Moving…' });
		expect(screen.getByText('Moving…').classList.contains('sr-only')).toBe(true);
	});

	it('still honours a plain disabled, pending or not', () => {
		render(PendingButton, { props: { children, disabled: true } });
		expect(button().disabled).toBe(true);
		expect(button().hasAttribute('aria-busy')).toBe(false);
	});
});
