import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { IssueLabel } from '@tines/shared';
import LabelChip from './LabelChip.svelte';

const label: Pick<IssueLabel, 'name' | 'color'> = { name: 'needs-review', color: 'amber' };

const removeButton = 'Remove label needs-review';

describe('LabelChip', () => {
	it('paints itself from the palette token for its colour', async () => {
		const screen = await render(LabelChip, { label });
		const chip = screen.container.querySelector('span')!;
		expect(chip.style.getPropertyValue('--cat')).toBe('var(--label-amber, var(--label-slate))');
	});

	it('falls back to the slate token, not a broken var, for an unknown colour', async () => {
		// The column is free text: a row written before a colour left the
		// palette still comes back, and must not render a dangling var().
		const screen = await render(LabelChip, {
			label: { name: 'odd', color: 'ultraviolet' as IssueLabel['color'] }
		});
		const chip = screen.container.querySelector('span')!;
		expect(chip.style.getPropertyValue('--cat')).toBe(
			'var(--label-ultraviolet, var(--label-slate))'
		);
		// Resolved by the browser, so an unpainted chip fails here rather than
		// looking fine in the DOM: `--label-ultraviolet` is undefined, and the
		// slate fallback is what the chip actually renders with.
		expect(getComputedStyle(chip).getPropertyValue('--cat').trim()).not.toBe('');
	});

	it('renders the pill form as a state badge and the dot form as its own quiet chip', async () => {
		const screen = await render(LabelChip, { label });
		expect(screen.container.querySelector('span')!.classList.contains('state-badge')).toBe(true);

		await screen.rerender({ label, variant: 'dot' });
		const dot = screen.container.querySelector('span')!;
		expect(dot.classList.contains('state-badge')).toBe(false);
		// The coloured dot is an extra child the pill does not have.
		expect(dot.querySelectorAll('span').length).toBe(2);
	});

	it('ellipses a name too long for a capped chip instead of clipping the pill', async () => {
		const screen = await render(LabelChip, {
			label: { ...label, name: 'a-label-name-far-wider-than-the-cap-allows' },
			class: 'max-w-[8rem]'
		});

		const chip = screen.container.querySelector('span')!;
		const name = screen.getByText('a-label-name-far-wider-than-the-cap-allows').element();
		// The name owns the overflow, so it is the element that is cut short
		// while the pill itself stays whole and within the cap.
		expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
		expect(chip.scrollWidth).toBeLessThanOrEqual(chip.clientWidth + 1);
		expect(getComputedStyle(name).textOverflow).toBe('ellipsis');
	});

	it('grows a remove button only when a handler is given', async () => {
		const onremove = vi.fn();
		const screen = await render(LabelChip, { label });
		await expect.element(screen.getByRole('button')).not.toBeInTheDocument();

		await screen.rerender({ label, onremove });
		await screen.getByRole('button', { name: removeButton }).click();
		expect(onremove).toHaveBeenCalledOnce();
	});

	it('cancels the click, so removing a label inside a linked row does not follow the row', async () => {
		const onremove = vi.fn();
		const screen = await render(LabelChip, { label, onremove });

		let click: MouseEvent | undefined;
		screen.container.addEventListener('click', (event) => {
			click = event as MouseEvent;
		});

		await screen.getByRole('button', { name: removeButton }).click();

		expect(onremove).toHaveBeenCalledOnce();
		// Read after the dispatch has finished, so the handler's preventDefault
		// has landed on the event this listener captured on the way past.
		expect(click?.defaultPrevented).toBe(true);
	});

	it('disables the remove button while a removal is in flight', async () => {
		const onremove = vi.fn();
		const screen = await render(LabelChip, { label, onremove, removeBusy: true });
		await expect.element(screen.getByRole('button', { name: removeButton })).toBeDisabled();
	});
});
