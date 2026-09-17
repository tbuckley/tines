import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import type { IssueLabel } from '@tines/shared';
import LabelChip from './LabelChip.svelte';

const label: Pick<IssueLabel, 'name' | 'color'> = { name: 'needs-review', color: 'amber' };

describe('LabelChip', () => {
	it('paints itself from the palette token for its colour', () => {
		const { container } = render(LabelChip, { props: { label } });
		const chip = container.querySelector('span');
		expect(chip?.style.getPropertyValue('--cat')).toBe('var(--label-amber, var(--label-slate))');
	});

	it('falls back to the slate token, not a broken var, for an unknown colour', () => {
		const { container } = render(LabelChip, {
			// The column is free text: a row written before a colour left the
			// palette still comes back, and must not render a dangling var().
			props: { label: { name: 'odd', color: 'ultraviolet' as IssueLabel['color'] } }
		});
		expect(container.querySelector('span')?.style.getPropertyValue('--cat')).toBe(
			'var(--label-ultraviolet, var(--label-slate))'
		);
	});

	it('renders the pill form as a state badge and the dot form as its own quiet chip', () => {
		const { container, rerender } = render(LabelChip, { props: { label } });
		expect(container.querySelector('span')?.classList.contains('state-badge')).toBe(true);

		rerender({ label, variant: 'dot' });
		const dot = container.querySelector('span');
		expect(dot?.classList.contains('state-badge')).toBe(false);
		// The coloured dot is an extra child the pill does not have.
		expect(dot?.querySelectorAll('span').length).toBe(2);
	});

	it('keeps the name in its own element so a capped chip ellipses instead of clipping', () => {
		render(LabelChip, { props: { label } });
		const name = screen.getByText('needs-review');
		expect(name.tagName).toBe('SPAN');
		expect(name.classList.contains('truncate')).toBe(true);
	});

	it('grows a remove button only when a handler is given', async () => {
		const onremove = vi.fn();
		const { rerender } = render(LabelChip, { props: { label } });
		expect(screen.queryByRole('button')).toBeNull();

		rerender({ label, onremove });
		await fireEvent.click(screen.getByRole('button', { name: 'Remove label needs-review' }));
		expect(onremove).toHaveBeenCalledOnce();
	});

	it('cancels the click, so removing a label inside a linked row does not follow the row', async () => {
		const onremove = vi.fn();
		render(LabelChip, { props: { label, onremove } });

		const click = new MouseEvent('click', { bubbles: true, cancelable: true });
		await fireEvent(screen.getByRole('button', { name: 'Remove label needs-review' }), click);

		expect(onremove).toHaveBeenCalledOnce();
		expect(click.defaultPrevented).toBe(true);
	});

	it('disables the remove button while a removal is in flight', () => {
		const onremove = vi.fn();
		render(LabelChip, { props: { label, onremove, removeBusy: true } });

		// Asserted on the attribute, not by clicking: `fireEvent` dispatches
		// straight at the node, so it fires handlers a disabled button would
		// never receive from a real pointer.
		const button = screen.getByRole('button', { name: 'Remove label needs-review' });
		expect((button as HTMLButtonElement).disabled).toBe(true);
	});
});
